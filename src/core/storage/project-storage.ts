import path from "node:path";

import type { FileSystem, FileSystemEntryType } from "../filesystem/filesystem.js";

export const preferredProjectDirectory = ".briefonce";
export const legacyProjectDirectory = ".agentfold";

export type ProjectStorageDirectory =
  typeof preferredProjectDirectory | typeof legacyProjectDirectory;

export interface ProjectStorageEntry {
  readonly directory: ProjectStorageDirectory;
  readonly entryType: FileSystemEntryType;
  readonly absolutePath: string;
}

export type ProjectStorageResolution =
  | {
      readonly status: "absent";
      readonly preferredDirectory: typeof preferredProjectDirectory;
    }
  | {
      readonly status: "selected";
      readonly selected: ProjectStorageEntry;
      readonly legacy: boolean;
    }
  | {
      readonly status: "conflict";
      readonly preferred: ProjectStorageEntry;
      readonly legacy: ProjectStorageEntry;
    };

export function projectStorageRelativePath(
  directory: ProjectStorageDirectory,
  relativePath = "",
): string {
  const portableRelativePath = relativePath.replaceAll("\\", "/").replace(/^\/+/u, "");
  return portableRelativePath.length === 0 ? directory : `${directory}/${portableRelativePath}`;
}

export function preferredProjectRelativePath(relativePath = ""): string {
  return projectStorageRelativePath(preferredProjectDirectory, relativePath);
}

export function projectStorageAbsolutePath(
  repositoryRoot: string,
  directory: ProjectStorageDirectory,
  relativePath = "",
): string {
  const segments = relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  return path.join(repositoryRoot, directory, ...segments);
}

async function storageEntry(
  fileSystem: FileSystem,
  repositoryRoot: string,
  directory: ProjectStorageDirectory,
): Promise<ProjectStorageEntry | undefined> {
  const absolutePath = path.join(repositoryRoot, directory);
  const detectedType = await fileSystem.entryType(absolutePath);
  const entryType =
    detectedType ??
    (fileSystem.isSymbolicLink !== undefined && (await fileSystem.isSymbolicLink(absolutePath))
      ? "other"
      : undefined);
  return entryType === undefined ? undefined : { directory, entryType, absolutePath };
}

export async function resolveProjectStorage(
  fileSystem: FileSystem,
  repositoryRoot: string,
): Promise<ProjectStorageResolution> {
  const [preferred, legacy] = await Promise.all([
    storageEntry(fileSystem, repositoryRoot, preferredProjectDirectory),
    storageEntry(fileSystem, repositoryRoot, legacyProjectDirectory),
  ]);

  if (preferred !== undefined && legacy !== undefined) {
    return { status: "conflict", preferred, legacy };
  }

  if (preferred !== undefined) {
    return { status: "selected", selected: preferred, legacy: false };
  }

  if (legacy !== undefined) {
    return { status: "selected", selected: legacy, legacy: true };
  }

  return { status: "absent", preferredDirectory: preferredProjectDirectory };
}
