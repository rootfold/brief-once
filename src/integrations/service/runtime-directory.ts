import path from "node:path";
import os from "node:os";

import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import {
  isKnownPlatformPathAlias,
  samePlatformPath,
} from "../../core/filesystem/platform-path-aliases.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import type { ServiceEndpointKind } from "./service-types.js";

export interface ServicePlatformInput {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}

export interface ServiceRuntimeLocation {
  readonly directory: string;
  readonly endpointKind: ServiceEndpointKind;
}

export interface PreparedServiceRuntime extends ServiceRuntimeLocation {
  readonly realDirectory: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface PrepareServiceRuntimeInput {
  readonly fileSystem: FileSystem;
  readonly platform?: ServicePlatformInput;
  readonly runtimeDirectory?: string;
  readonly restrictDirectory?: (directory: string) => Promise<void>;
  readonly gitRepositoryLocator?: GitRepositoryLocator;
}

export function nodeServicePlatformInput(): ServicePlatformInput {
  return {
    platform: process.platform,
    environment: process.env,
    homeDirectory: os.homedir(),
  };
}

export function resolveServiceRuntimeLocation(
  input: ServicePlatformInput,
  override?: string,
): ServiceRuntimeLocation {
  const platformPath = input.platform === "win32" ? path.win32 : path.posix;
  const configuredOverride = override ?? input.environment.AGENTFOLD_RUNTIME_DIR;
  if (configuredOverride !== undefined && configuredOverride.trim().length > 0) {
    return {
      directory: platformPath.resolve(configuredOverride),
      endpointKind: input.platform === "win32" ? "named-pipe" : "unix-socket",
    };
  }

  if (input.platform === "win32") {
    const localAppData = input.environment.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.trim().length === 0) {
      throw new Error("LOCALAPPDATA is unavailable for the BriefOnce service runtime.");
    }
    return {
      directory: path.win32.join(localAppData, "AgentFold", "runtime"),
      endpointKind: "named-pipe",
    };
  }

  if (input.platform === "darwin") {
    return {
      directory: path.posix.join(
        input.homeDirectory,
        "Library",
        "Application Support",
        "AgentFold",
      ),
      endpointKind: "unix-socket",
    };
  }

  const xdgRuntime = input.environment.XDG_RUNTIME_DIR;
  if (xdgRuntime !== undefined && xdgRuntime.trim().length > 0) {
    return {
      directory: path.posix.join(xdgRuntime, "agentfold"),
      endpointKind: "unix-socket",
    };
  }
  const xdgState = input.environment.XDG_STATE_HOME;
  return {
    directory:
      xdgState !== undefined && xdgState.trim().length > 0
        ? path.posix.join(xdgState, "agentfold")
        : path.posix.join(input.homeDirectory, ".local", "state", "agentfold"),
    endpointKind: "unix-socket",
  };
}

async function hasUnsafeSymbolicLinkComponent(
  fileSystem: FileSystem,
  directory: string,
  platform: NodeJS.Platform,
): Promise<boolean | undefined> {
  if (fileSystem.isSymbolicLink === undefined) return undefined;
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const resolved = platformPath.resolve(directory);
  const parsed = platformPath.parse(resolved);
  let current = parsed.root;
  const relative = resolved.slice(parsed.root.length);
  for (const component of relative.split(/[\\/]+/u).filter((item) => item.length > 0)) {
    current = platformPath.join(current, component);
    if (
      (await fileSystem.isSymbolicLink(current)) &&
      !(await isKnownPlatformPathAlias(fileSystem, current, platform))
    ) {
      return true;
    }
  }
  return false;
}

async function defaultRestrictDirectory(directory: string): Promise<void> {
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(directory, 0o700);
  }
}

export async function prepareServiceRuntimeDirectory(
  input: PrepareServiceRuntimeInput,
): Promise<PreparedServiceRuntime> {
  const platform = input.platform ?? nodeServicePlatformInput();
  const location = resolveServiceRuntimeLocation(platform, input.runtimeDirectory);
  await input.fileSystem.ensureDirectory(location.directory);
  const realDirectory = await input.fileSystem.realPath(location.directory);
  const hasUnsafeSymbolicLink = await hasUnsafeSymbolicLinkComponent(
    input.fileSystem,
    location.directory,
    platform.platform,
  );
  if (
    hasUnsafeSymbolicLink === true ||
    (hasUnsafeSymbolicLink === undefined &&
      !samePlatformPath(location.directory, realDirectory, platform.platform))
  ) {
    throw new Error(
      "The BriefOnce compatibility runtime directory resolves through a symbolic link.",
    );
  }
  await (input.restrictDirectory ?? defaultRestrictDirectory)(realDirectory);
  if ((await input.gitRepositoryLocator?.findRoot(realDirectory)) !== undefined) {
    throw new Error(
      "The BriefOnce compatibility runtime directory must remain outside project repositories.",
    );
  }
  return { ...location, realDirectory, diagnostics: [] };
}
