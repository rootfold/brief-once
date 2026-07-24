import { chmod } from "node:fs/promises";
import net from "node:net";
import process from "node:process";

import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import type { McpStderrLogger } from "../mcp/mcp-context.js";
import { generateCapabilityToken } from "./authentication.js";
import { createAgentFoldService } from "./create-service.js";
import { LeaseMonitor, type ServiceScheduler } from "./lease-monitor.js";
import { connectAgentFoldServiceClient } from "./service-client.js";
import { AgentFoldServiceCoordinator } from "./service-coordinator.js";
import { createServiceEndpoint } from "./service-endpoint.js";
import { agentFoldServiceProtocolVersion } from "./service-protocol.js";
import {
  readServiceRuntimeMetadata,
  removeServiceRuntimeMetadata,
  writeServiceRuntimeMetadata,
} from "./runtime-metadata.js";
import { prepareServiceRuntimeDirectory, type ServicePlatformInput } from "./runtime-directory.js";
import { prepareReliabilityStateDirectory } from "../reliability/state-directory.js";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ServiceSignalSource {
  once(signal: ShutdownSignal, listener: () => void): void;
  off(signal: ShutdownSignal, listener: () => void): void;
}

export interface RunAgentFoldServiceInput {
  readonly version: string;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly logger: McpStderrLogger;
  readonly runtimeDirectory?: string;
  readonly platform?: ServicePlatformInput;
  readonly now?: () => Date;
  readonly generateToken?: () => string;
  readonly generateSessionId?: () => string;
  readonly processId?: number;
  readonly signalSource?: ServiceSignalSource;
  readonly scheduler?: ServiceScheduler;
  readonly leaseMonitorIntervalMilliseconds?: number;
  readonly reliabilityStateDirectory?: string;
  readonly generateEventId?: () => string;
}

export async function runAgentFoldService(input: RunAgentFoldServiceInput): Promise<number> {
  const now = input.now ?? (() => new Date());
  let runtime;
  try {
    runtime = await prepareServiceRuntimeDirectory({
      fileSystem: input.fileSystem,
      gitRepositoryLocator: input.gitRepositoryLocator,
      ...(input.runtimeDirectory === undefined ? {} : { runtimeDirectory: input.runtimeDirectory }),
      ...(input.platform === undefined ? {} : { platform: input.platform }),
    });
  } catch {
    input.logger.error("AFSV005: The AgentFold runtime directory is invalid or unsafe.");
    return 1;
  }

  const existing = await connectAgentFoldServiceClient({
    fileSystem: input.fileSystem,
    clientVersion: input.version,
    runtimeDirectory: runtime.realDirectory,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
  if (existing.status === "connected") {
    input.logger.debug("AgentFold service is already running.");
    return 0;
  }
  if (
    existing.status === "incompatible" ||
    existing.diagnostics.some((item) => item.code === "AFSV009")
  ) {
    input.logger.error("AFSV012: Existing service metadata could not be reused safely.");
    return 1;
  }

  const staleMetadata = await readServiceRuntimeMetadata(
    input.fileSystem,
    runtime.realDirectory,
  ).catch(() => undefined);
  if (staleMetadata !== undefined) {
    await removeServiceRuntimeMetadata(input.fileSystem, runtime.realDirectory);
    if (
      staleMetadata.endpointKind === "unix-socket" &&
      staleMetadata.endpoint === createServiceEndpoint(runtime.realDirectory, "unix-socket")
    ) {
      await input.fileSystem.remove(staleMetadata.endpoint);
    }
    input.logger.debug("Confirmed stale AgentFold service metadata was removed.");
  }

  const endpoint = createServiceEndpoint(runtime.realDirectory, runtime.endpointKind);
  if (
    staleMetadata === undefined &&
    runtime.endpointKind === "unix-socket" &&
    (await input.fileSystem.exists(endpoint))
  ) {
    const acceptsConnections = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(endpoint);
      let settled = false;
      const finish = (connected: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(connected);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(500, () => finish(false));
    });
    if (acceptsConnections) {
      input.logger.error("AFSV012: An unsafe pre-existing local socket was not replaced.");
      return 1;
    }
    await input.fileSystem.remove(endpoint);
    input.logger.debug("Confirmed stale Unix socket was removed.");
  }
  const token = (input.generateToken ?? generateCapabilityToken)();
  let reliabilityStateDirectory: string | undefined;
  try {
    reliabilityStateDirectory = await prepareReliabilityStateDirectory({
      fileSystem: input.fileSystem,
      gitRepositoryLocator: input.gitRepositoryLocator,
      ...(input.reliabilityStateDirectory === undefined
        ? {}
        : { stateDirectory: input.reliabilityStateDirectory }),
      ...(input.platform === undefined ? {} : { platform: input.platform }),
    });
  } catch {
    input.logger.error(
      "AFREL003: Reliability persistence is unavailable; the service will continue without it.",
    );
  }
  const startedAt = now().toISOString();
  const processId = input.processId ?? process.pid;
  const coordinator = new AgentFoldServiceCoordinator({
    version: input.version,
    startedAt,
    processId,
    endpointKind: runtime.endpointKind,
    fileSystem: input.fileSystem,
    gitRepositoryLocator: input.gitRepositoryLocator,
    gitInspector: input.gitInspector,
    now,
    logger: input.logger,
    ...(input.generateSessionId === undefined
      ? {}
      : { generateSessionId: input.generateSessionId }),
    ...(reliabilityStateDirectory === undefined ? {} : { reliabilityStateDirectory }),
    ...(input.generateEventId === undefined ? {} : { generateEventId: input.generateEventId }),
    onShutdownRequested: () => setImmediate(() => void shutdown()),
  });
  await coordinator.initialize();
  const service = createAgentFoldService({ endpoint, token, coordinator });
  const monitor = new LeaseMonitor({
    inspect: () => coordinator.recoverStaleSessions(),
    ...(input.scheduler === undefined ? {} : { scheduler: input.scheduler }),
    ...(input.leaseMonitorIntervalMilliseconds === undefined
      ? {}
      : { intervalMilliseconds: input.leaseMonitorIntervalMilliseconds }),
    onError: () => input.logger.error("AFSV026: Lease recovery inspection failed safely."),
  });
  const signalSource = input.signalSource ?? process;
  let stopping = false;
  let coordinatorStopped = false;
  let serviceStarted = false;
  let metadataWritten = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return service.closed;
    stopping = true;
    monitor.stop();
    if (!coordinatorStopped) {
      coordinatorStopped = true;
      await coordinator.shutdown();
    }
    await service.stop();
  };
  const onSignal = (): void => void shutdown();
  signalSource.once("SIGINT", onSignal);
  signalSource.once("SIGTERM", onSignal);

  try {
    await service.start();
    serviceStarted = true;
    if (runtime.endpointKind === "unix-socket") await chmod(endpoint, 0o600);
    await writeServiceRuntimeMetadata(input.fileSystem, runtime.realDirectory, {
      schemaVersion: 1,
      protocolVersion: agentFoldServiceProtocolVersion,
      serviceVersion: input.version,
      pid: processId,
      startedAt,
      endpointKind: runtime.endpointKind,
      endpoint,
      token,
    });
    metadataWritten = true;
    monitor.start();
    input.logger.error("AFSV001: AgentFold local service started.");
    await service.closed;
    return 0;
  } catch {
    input.logger.error("AFSV003: The AgentFold service failed to start safely.");
    await shutdown();
    return 1;
  } finally {
    signalSource.off("SIGINT", onSignal);
    signalSource.off("SIGTERM", onSignal);
    monitor.stop();
    if (!coordinatorStopped) {
      coordinatorStopped = true;
      await coordinator.shutdown();
    }
    if (metadataWritten) {
      const ownedMetadata = await readServiceRuntimeMetadata(
        input.fileSystem,
        runtime.realDirectory,
      ).catch(() => undefined);
      if (ownedMetadata?.token === token && ownedMetadata.pid === processId) {
        if (runtime.endpointKind === "unix-socket") await input.fileSystem.remove(endpoint);
        await removeServiceRuntimeMetadata(input.fileSystem, runtime.realDirectory);
      }
    } else if (serviceStarted && runtime.endpointKind === "unix-socket") {
      await input.fileSystem.remove(endpoint);
    }
    input.logger.error("AFSV007: AgentFold local service stopped.");
  }
}
