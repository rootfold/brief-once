import { spawn, type SpawnOptions } from "node:child_process";
import process from "node:process";

import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import { connectAgentFoldServiceClient } from "./service-client.js";
import { createServiceEndpoint } from "./service-endpoint.js";
import { readServiceRuntimeMetadata, removeServiceRuntimeMetadata } from "./runtime-metadata.js";
import {
  nodeServicePlatformInput,
  resolveServiceRuntimeLocation,
  type ServicePlatformInput,
} from "./runtime-directory.js";
import type { SafeAgentFoldServiceStatus } from "./service-types.js";

export interface DetachedProcess {
  unref(): void;
}

export interface ServiceProcessSpawner {
  spawn(command: string, arguments_: readonly string[], options: SpawnOptions): DetachedProcess;
}

export const nodeServiceProcessSpawner: ServiceProcessSpawner = {
  spawn: (command, arguments_, options) => spawn(command, [...arguments_], options),
};

export interface ServiceLifecycleInput {
  readonly fileSystem: FileSystem;
  readonly version: string;
  readonly runtimeDirectory?: string;
  readonly platform?: ServicePlatformInput;
  readonly timeoutMilliseconds?: number;
  readonly pollIntervalMilliseconds?: number;
  readonly now?: () => Date;
}

export interface StartServiceInput extends ServiceLifecycleInput {
  readonly spawner?: ServiceProcessSpawner;
  readonly executable?: string;
  readonly execArguments?: readonly string[];
  readonly scriptPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export type ServiceLifecycleResult =
  | {
      readonly status: "started" | "already_running" | "stopped" | "already_stopped";
      readonly exitCode: 0;
      readonly diagnostics: readonly Diagnostic[];
      readonly serviceStatus?: SafeAgentFoldServiceStatus;
    }
  | {
      readonly status: "startup_timeout" | "unavailable" | "incompatible";
      readonly exitCode: 1;
      readonly diagnostics: readonly Diagnostic[];
    };

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  suggestion?: string,
): Diagnostic {
  return { code, severity, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function clientInput(input: ServiceLifecycleInput) {
  return {
    fileSystem: input.fileSystem,
    clientVersion: input.version,
    ...(input.runtimeDirectory === undefined ? {} : { runtimeDirectory: input.runtimeDirectory }),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    timeoutMilliseconds: Math.min(input.timeoutMilliseconds ?? 2_000, 500),
  };
}

async function cleanConfirmedStaleMetadata(input: ServiceLifecycleInput): Promise<boolean> {
  try {
    const platform = input.platform ?? nodeServicePlatformInput();
    const location = resolveServiceRuntimeLocation(platform, input.runtimeDirectory);
    if (!(await input.fileSystem.exists(location.directory))) return false;
    const realDirectory = await input.fileSystem.realPath(location.directory);
    const metadata = await readServiceRuntimeMetadata(input.fileSystem, realDirectory).catch(
      () => undefined,
    );
    if (metadata === undefined) return false;
    await removeServiceRuntimeMetadata(input.fileSystem, realDirectory);
    if (
      metadata.endpointKind === "unix-socket" &&
      metadata.endpoint === createServiceEndpoint(realDirectory, "unix-socket")
    ) {
      await input.fileSystem.remove(metadata.endpoint);
    }
    return true;
  } catch {
    return false;
  }
}

export async function startAgentFoldService(
  input: StartServiceInput,
): Promise<ServiceLifecycleResult> {
  const initial = await connectAgentFoldServiceClient(clientInput(input));
  if (initial.status === "connected") {
    return {
      status: "already_running",
      exitCode: 0,
      serviceStatus: await initial.client.status(),
      diagnostics: [diagnostic("AFSV002", "info", "BriefOnce service is already running.")],
    };
  }
  if (initial.status === "incompatible") {
    return { status: "incompatible", exitCode: 1, diagnostics: initial.diagnostics };
  }

  const executable = input.executable ?? process.execPath;
  const scriptPath = input.scriptPath ?? process.argv[1];
  if (scriptPath === undefined) {
    return {
      status: "unavailable",
      exitCode: 1,
      diagnostics: [
        diagnostic("AFSV003", "error", "The current BriefOnce executable could not be resolved."),
      ],
    };
  }
  const arguments_ = [...(input.execArguments ?? process.execArgv), scriptPath, "service", "run"];
  const environment = { ...(input.environment ?? process.env) };
  if (input.runtimeDirectory !== undefined)
    environment.AGENTFOLD_RUNTIME_DIR = input.runtimeDirectory;
  const child = (input.spawner ?? nodeServiceProcessSpawner).spawn(executable, arguments_, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    env: environment,
  });
  child.unref();

  const wait = input.delay ?? delay;
  const timeout = input.timeoutMilliseconds ?? 5_000;
  const poll = input.pollIntervalMilliseconds ?? 50;
  const now = input.now ?? (() => new Date());
  const deadline = now().getTime() + timeout;
  while (now().getTime() <= deadline) {
    const connected = await connectAgentFoldServiceClient(clientInput(input));
    if (connected.status === "connected") {
      return {
        status: "started",
        exitCode: 0,
        serviceStatus: await connected.client.status(),
        diagnostics: [
          ...connected.diagnostics,
          diagnostic("AFSV001", "success", "BriefOnce service started."),
        ],
      };
    }
    if (connected.status === "incompatible") {
      return { status: "incompatible", exitCode: 1, diagnostics: connected.diagnostics };
    }
    await wait(poll);
  }
  return {
    status: "startup_timeout",
    exitCode: 1,
    diagnostics: [
      diagnostic(
        "AFSV003",
        "error",
        "BriefOnce service did not become ready before the startup timeout.",
      ),
    ],
  };
}

export async function inspectAgentFoldService(
  input: ServiceLifecycleInput,
): Promise<ServiceLifecycleResult> {
  const connected = await connectAgentFoldServiceClient(clientInput(input));
  if (connected.status === "connected") {
    return {
      status: "already_running",
      exitCode: 0,
      serviceStatus: await connected.client.status(),
      diagnostics: connected.diagnostics,
    };
  }
  if (connected.status === "incompatible") {
    return { status: "incompatible", exitCode: 1, diagnostics: connected.diagnostics };
  }
  const stale =
    connected.diagnostics.some((item) => item.code === "AFSV013") &&
    (await cleanConfirmedStaleMetadata(input));
  return {
    status: "already_stopped",
    exitCode: 0,
    diagnostics: [
      diagnostic("AFSV004", "info", "BriefOnce service is not running."),
      ...(stale
        ? [diagnostic("AFSV006", "info", "Confirmed stale service metadata was removed.")]
        : []),
    ],
  };
}

export async function stopAgentFoldService(
  input: ServiceLifecycleInput & { readonly delay?: (milliseconds: number) => Promise<void> },
): Promise<ServiceLifecycleResult> {
  const connected = await connectAgentFoldServiceClient(clientInput(input));
  if (connected.status === "incompatible") {
    return { status: "incompatible", exitCode: 1, diagnostics: connected.diagnostics };
  }
  if (connected.status !== "connected") {
    const stale =
      connected.diagnostics.some((item) => item.code === "AFSV013") &&
      (await cleanConfirmedStaleMetadata(input));
    return {
      status: "already_stopped",
      exitCode: 0,
      diagnostics: [
        diagnostic("AFSV004", "info", "BriefOnce service is already stopped."),
        ...(stale
          ? [diagnostic("AFSV006", "info", "Confirmed stale service metadata was removed.")]
          : []),
      ],
    };
  }
  await connected.client.shutdown();
  const wait = input.delay ?? delay;
  const now = input.now ?? (() => new Date());
  const deadline = now().getTime() + (input.timeoutMilliseconds ?? 5_000);
  while (now().getTime() <= deadline) {
    await wait(input.pollIntervalMilliseconds ?? 50);
    const current = await connectAgentFoldServiceClient(clientInput(input));
    if (current.status === "unavailable") {
      return {
        status: "stopped",
        exitCode: 0,
        diagnostics: [diagnostic("AFSV007", "success", "BriefOnce service stopped.")],
      };
    }
  }
  return {
    status: "unavailable",
    exitCode: 1,
    diagnostics: [
      diagnostic("AFSV008", "error", "BriefOnce service did not stop before the timeout."),
    ],
  };
}
