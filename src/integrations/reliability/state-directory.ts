import path from "node:path";

import type { FileSystem } from "../../core/filesystem/filesystem.js";
import {
  isKnownPlatformPathAlias,
  samePlatformPath,
} from "../../core/filesystem/platform-path-aliases.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import {
  nodeServicePlatformInput,
  type ServicePlatformInput,
} from "../service/runtime-directory.js";

export interface PrepareReliabilityStateInput {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator?: GitRepositoryLocator;
  readonly stateDirectory?: string;
  readonly platform?: ServicePlatformInput;
  readonly restrictDirectory?: (directory: string) => Promise<void>;
}

export function resolveReliabilityStateDirectory(
  platform: ServicePlatformInput = nodeServicePlatformInput(),
  override?: string,
): string {
  const platformPath = platform.platform === "win32" ? path.win32 : path.posix;
  const configured = override ?? platform.environment.AGENTFOLD_STATE_DIR;
  if (configured !== undefined && configured.trim().length > 0) {
    return platformPath.resolve(configured);
  }
  if (platform.platform === "win32") {
    const localAppData = platform.environment.LOCALAPPDATA;
    if (localAppData === undefined || localAppData.trim().length === 0) {
      throw new Error("LOCALAPPDATA is unavailable for BriefOnce reliability state.");
    }
    return path.win32.join(localAppData, "AgentFold", "state");
  }
  if (platform.platform === "darwin") {
    return path.posix.join(
      platform.homeDirectory,
      "Library",
      "Application Support",
      "AgentFold",
      "state",
    );
  }
  const xdgState = platform.environment.XDG_STATE_HOME;
  return xdgState !== undefined && xdgState.trim().length > 0
    ? path.posix.join(xdgState, "agentfold")
    : path.posix.join(platform.homeDirectory, ".local", "state", "agentfold");
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
  for (const component of resolved
    .slice(parsed.root.length)
    .split(/[\\/]+/u)
    .filter((item) => item.length > 0)) {
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

export async function prepareReliabilityStateDirectory(
  input: PrepareReliabilityStateInput,
): Promise<string> {
  const platform = input.platform ?? nodeServicePlatformInput();
  const requested = resolveReliabilityStateDirectory(platform, input.stateDirectory);
  await input.fileSystem.ensureDirectory(requested);
  const realDirectory = await input.fileSystem.realPath(requested);
  const unsafe = await hasUnsafeSymbolicLinkComponent(
    input.fileSystem,
    requested,
    platform.platform,
  );
  if (
    unsafe === true ||
    (unsafe === undefined && !samePlatformPath(requested, realDirectory, platform.platform))
  ) {
    throw new Error(
      "The BriefOnce compatibility reliability state directory resolves through a symbolic link.",
    );
  }
  await (input.restrictDirectory ?? defaultRestrictDirectory)(realDirectory);
  if ((await input.gitRepositoryLocator?.findRoot(realDirectory)) !== undefined) {
    throw new Error(
      "The BriefOnce compatibility reliability state directory must remain outside repositories.",
    );
  }
  return realDirectory;
}

export type InspectedReliabilityStateDirectory =
  | { readonly status: "missing"; readonly directory: string }
  | { readonly status: "available"; readonly directory: string };

export async function inspectReliabilityStateDirectory(
  input: Omit<PrepareReliabilityStateInput, "restrictDirectory">,
): Promise<InspectedReliabilityStateDirectory> {
  const platform = input.platform ?? nodeServicePlatformInput();
  const requested = resolveReliabilityStateDirectory(platform, input.stateDirectory);
  if (!(await input.fileSystem.exists(requested))) {
    return { status: "missing", directory: requested };
  }
  const realDirectory = await input.fileSystem.realPath(requested);
  const unsafe = await hasUnsafeSymbolicLinkComponent(
    input.fileSystem,
    requested,
    platform.platform,
  );
  if (
    unsafe === true ||
    (unsafe === undefined && !samePlatformPath(requested, realDirectory, platform.platform))
  ) {
    throw new Error(
      "The BriefOnce compatibility reliability state directory resolves through a symbolic link.",
    );
  }
  if ((await input.gitRepositoryLocator?.findRoot(realDirectory)) !== undefined) {
    throw new Error(
      "The BriefOnce compatibility reliability state directory is inside a repository.",
    );
  }
  return { status: "available", directory: realDirectory };
}
