import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { createAgentFoldIntegrationOperations } from "../application/integration-operations.js";
import { createAgentFoldMcpServer } from "./create-mcp-server.js";
import { createLazyMcpOperations } from "./lazy-mcp-tools.js";
import { createMcpApplicationContext, type McpStderrLogger } from "./mcp-context.js";
import { InMemorySessionRegistry } from "./session-registry.js";
import {
  connectAgentFoldServiceClient,
  type ConnectServiceClientResult,
} from "../service/service-client.js";
import { startAgentFoldService } from "../service/service-lifecycle.js";
import type { ServiceMode } from "../service/service-mode.js";
import { createMcpServiceBridge } from "./service-bridge.js";
import { workspaceModes, type WorkspaceMode } from "./workspace-mode.js";
import { McpWorkspaceResolver } from "./workspace-resolver.js";
import { prepareRepositoryReliability } from "../reliability/create-recorder.js";
import type { ServicePlatformInput } from "../service/runtime-directory.js";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface McpSignalSource {
  once(signal: ShutdownSignal, listener: () => void): void;
  off(signal: ShutdownSignal, listener: () => void): void;
}

export interface RunMcpServerInput {
  readonly workspace?: string;
  readonly debug?: boolean;
  readonly version: string;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly logger: McpStderrLogger;
  readonly now?: () => Date;
  readonly generateSessionId?: () => string;
  readonly signalSource?: McpSignalSource;
  readonly transport?: Transport;
  readonly serviceMode?: ServiceMode;
  readonly ensureService?: boolean;
  readonly workspaceMode?: WorkspaceMode;
  readonly runtimeDirectory?: string;
  readonly reliabilityStateDirectory?: string;
  readonly platform?: ServicePlatformInput;
  readonly connectServiceClient?: typeof connectAgentFoldServiceClient;
  readonly startService?: typeof startAgentFoldService;
}

async function connectSharedService(input: RunMcpServerInput): Promise<ConnectServiceClientResult> {
  const connect = input.connectServiceClient ?? connectAgentFoldServiceClient;
  const clientInput = {
    fileSystem: input.fileSystem,
    clientVersion: input.version,
    ...(input.runtimeDirectory === undefined ? {} : { runtimeDirectory: input.runtimeDirectory }),
  };
  let connected = await connect(clientInput);
  if (connected.status !== "unavailable" || input.ensureService !== true) return connected;

  const started = await (input.startService ?? startAgentFoldService)({
    fileSystem: input.fileSystem,
    version: input.version,
    ...(input.runtimeDirectory === undefined ? {} : { runtimeDirectory: input.runtimeDirectory }),
  });
  for (const item of started.diagnostics) {
    const message = `${item.code}: ${item.message}`;
    if (item.severity === "error" || item.severity === "warning") input.logger.error(message);
    else input.logger.debug(message);
  }
  if (started.exitCode !== 0) return connected;
  connected = await connect(clientInput);
  return connected;
}

export async function runMcpServer(input: RunMcpServerInput): Promise<number> {
  const serviceMode = input.serviceMode ?? "auto";
  if (input.ensureService === true && serviceMode === "disabled") {
    input.logger.error("AFSV033: --ensure-service cannot be used with disabled service mode.");
    return 2;
  }
  const requestedMode = input.workspace === undefined ? (input.workspaceMode ?? "fixed") : "fixed";
  if (!workspaceModes.includes(requestedMode)) return 2;
  const now = input.now ?? (() => new Date());
  const sessions = new InMemorySessionRegistry({
    now,
    ...(input.generateSessionId === undefined ? {} : { generateId: input.generateSessionId }),
  });
  const resolver = new McpWorkspaceResolver({
    mode: requestedMode,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    fileSystem: input.fileSystem,
    gitRepositoryLocator: input.gitRepositoryLocator,
  });
  if (requestedMode === "fixed" || requestedMode === "cwd") {
    const initialResolution = await resolver.resolve();
    if (initialResolution.status === "error") {
      for (const diagnostic of initialResolution.diagnostics) {
        input.logger.error(`${diagnostic.code}: ${diagnostic.message}`);
      }
      return 6;
    }
  }

  let serviceConnection: ConnectServiceClientResult | undefined;
  if (serviceMode !== "disabled") {
    serviceConnection = await connectSharedService(input);
    if (serviceConnection.status === "connected") {
      for (const diagnostic of serviceConnection.diagnostics) {
        input.logger.error(`${diagnostic.code}: ${diagnostic.message}`);
      }
      input.logger.debug("MCP tools are delegated to the shared AgentFold service.");
    } else if (serviceMode === "required") {
      for (const diagnostic of serviceConnection.diagnostics) {
        input.logger.error(`${diagnostic.code}: ${diagnostic.message}`);
      }
      input.logger.error("AFSV032: The required shared AgentFold service is unavailable.");
      return 1;
    } else {
      input.logger.error(
        "AFSV031: Shared AgentFold service unavailable; using embedded mode without cross-application automation.",
      );
    }
  }

  const lazy = createLazyMcpOperations({
    resolver,
    create: async (repositoryRoot) => {
      let reliability;
      if (serviceConnection?.status !== "connected") {
        try {
          reliability = await prepareRepositoryReliability({
            repositoryRoot,
            fileSystem: input.fileSystem,
            gitRepositoryLocator: input.gitRepositoryLocator,
            ...(input.reliabilityStateDirectory === undefined
              ? {}
              : { stateDirectory: input.reliabilityStateDirectory }),
            ...(input.platform === undefined ? {} : { platform: input.platform }),
            now,
          });
        } catch {
          input.logger.error(
            "AFREL003: Reliability persistence is unavailable; MCP lifecycle operations remain available.",
          );
        }
      }
      const resolved = await createMcpApplicationContext({
        workspace: repositoryRoot,
        version: input.version,
        fileSystem: input.fileSystem,
        gitRepositoryLocator: input.gitRepositoryLocator,
        gitInspector: input.gitInspector,
        sessions,
        now,
        debug: input.debug ?? false,
        logger: input.logger,
        ...(reliability === undefined ? {} : { reliability: reliability.recorder }),
        reliabilityMode: "embedded",
      });
      if (resolved.status === "error") throw new Error("MCP workspace context failed validation.");
      if (serviceConnection?.status === "connected") {
        const bridge = createMcpServiceBridge({
          workspace: repositoryRoot,
          client: serviceConnection.client,
          logger: input.logger,
        });
        return { handlers: bridge.handlers, shutdown: () => bridge.shutdown() };
      }
      return {
        handlers: createAgentFoldIntegrationOperations(resolved.context),
        shutdown: () => Promise.resolve(),
      };
    },
  });
  const server = createAgentFoldMcpServer({
    version: input.version,
    logger: input.logger,
    handlers: lazy.handlers,
    repositoryRoot: () => resolver.lockedRepositoryRoot,
  });
  resolver.setRootsProvider(async () => {
    if (server.server.getClientCapabilities()?.roots === undefined) return { supported: false };
    const listed = await server.server.listRoots(undefined, {
      signal: AbortSignal.timeout(5_000),
    });
    return {
      supported: true,
      roots: listed.roots.map((root) => ({
        uri: root.uri,
        ...(root.name === undefined ? {} : { name: root.name }),
      })),
    };
  });
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    const warning = await resolver.inspectRootsAfterLock();
    if (warning !== undefined) input.logger.error(`${warning.code}: ${warning.message}`);
  });
  const transport = input.transport ?? new StdioServerTransport();
  const signalSource = input.signalSource ?? process;
  let shuttingDown = false;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  server.server.onclose = () => {
    void lazy
      .shutdown()
      .catch(() => input.logger.error("AFMCP015: MCP shutdown did not complete cleanly."))
      .finally(() => resolveClosed?.());
  };
  server.server.onerror = (error) => {
    input.logger.debug(`Transport warning: ${error.message}`);
  };
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    input.logger.debug(`Shutting down after ${reason}.`);
    try {
      await lazy.shutdown();
      await server.close();
    } catch {
      input.logger.error("AFMCP015: MCP shutdown did not complete cleanly.");
      resolveClosed?.();
    }
  };
  const onSigint = (): void => void shutdown("SIGINT");
  const onSigterm = (): void => void shutdown("SIGTERM");
  signalSource.once("SIGINT", onSigint);
  signalSource.once("SIGTERM", onSigterm);

  try {
    await server.connect(transport);
    input.logger.debug("MCP stdio server started.");
    await closed;
    return 0;
  } catch {
    input.logger.error("AFMCP001: MCP stdio server failed to start safely.");
    await shutdown("startup failure");
    return 1;
  } finally {
    signalSource.off("SIGINT", onSigint);
    signalSource.off("SIGTERM", onSigterm);
  }
}
