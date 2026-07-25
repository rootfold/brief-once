import path from "node:path";

import type { FileSystem } from "../filesystem/filesystem.js";
import {
  preferredProjectDirectory,
  projectStorageAbsolutePath,
  projectStorageRelativePath,
  resolveProjectStorage,
  type ProjectStorageDirectory,
} from "../storage/project-storage.js";
import { initializationFilePaths } from "./paths.js";

const externalInstructionFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
] as const;

export interface InstallationInspection {
  readonly directoryExists: boolean;
  readonly configExists: boolean;
  readonly storageDirectory: ProjectStorageDirectory;
  readonly legacyStorage: boolean;
  readonly storageConflict: boolean;
  readonly presentFiles: readonly string[];
  readonly missingFiles: readonly string[];
  readonly externalInstructionFiles: readonly string[];
}

async function detectExternalInstructionFiles(
  fileSystem: FileSystem,
  repositoryRoot: string,
): Promise<readonly string[]> {
  const fixedFiles = await Promise.all(
    externalInstructionFiles.map(async (file) => ({
      file,
      exists: await fileSystem.exists(path.join(repositoryRoot, file)),
    })),
  );
  const detected: string[] = fixedFiles.filter((entry) => entry.exists).map((entry) => entry.file);
  const cursorRulesDirectory = path.join(repositoryRoot, ".cursor", "rules");

  if ((await fileSystem.entryType(cursorRulesDirectory)) === "directory") {
    const cursorRules = (await fileSystem.listDirectory(cursorRulesDirectory))
      .filter((file) => file.toLowerCase().endsWith(".mdc"))
      .map((file) => `.cursor/rules/${file}`);
    detected.push(...cursorRules);
  }

  return detected.sort((left, right) => left.localeCompare(right));
}

export async function inspectInstallation(
  fileSystem: FileSystem,
  repositoryRoot: string,
): Promise<InstallationInspection> {
  const storage = await resolveProjectStorage(fileSystem, repositoryRoot);
  const storageDirectory =
    storage.status === "selected" ? storage.selected.directory : preferredProjectDirectory;
  const directories =
    storage.status === "conflict"
      ? ([storage.preferred.directory, storage.legacy.directory] as const)
      : ([storageDirectory] as const);
  const expectedFiles = await Promise.all(
    directories.flatMap((directory) =>
      initializationFilePaths.map(async (relativePath) => ({
        path: projectStorageRelativePath(directory, relativePath),
        exists: await fileSystem.exists(
          projectStorageAbsolutePath(repositoryRoot, directory, relativePath),
        ),
      })),
    ),
  );
  const resolvedFiles = await Promise.all(expectedFiles);
  const presentFiles = resolvedFiles.filter((file) => file.exists).map((file) => file.path);
  const missingFiles = resolvedFiles.filter((file) => !file.exists).map((file) => file.path);

  return {
    directoryExists: storage.status !== "absent",
    configExists:
      storage.status === "selected" &&
      presentFiles.includes(projectStorageRelativePath(storage.selected.directory, "config.yaml")),
    storageDirectory,
    legacyStorage: storage.status === "selected" && storage.legacy,
    storageConflict: storage.status === "conflict",
    presentFiles,
    missingFiles,
    externalInstructionFiles: await detectExternalInstructionFiles(fileSystem, repositoryRoot),
  };
}
