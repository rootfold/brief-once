import { randomUUID } from "node:crypto";
import path from "node:path";

import type { FileSystem } from "../filesystem/filesystem.js";
import { briefOnceDirectory } from "./paths.js";

export interface InitializationFile {
  readonly relativePath: string;
  readonly content: string;
}

export class InitializationConflictError extends Error {
  constructor(readonly destination: string) {
    super(`Initialization destination already exists: ${destination}`);
    this.name = "InitializationConflictError";
  }
}

function validateRelativePath(relativePath: string): readonly string[] {
  const segments = relativePath.split("/");

  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe initialization path: ${relativePath}`);
  }

  return segments;
}

export class AtomicInitializationWriter {
  constructor(
    private readonly fileSystem: FileSystem,
    private readonly temporaryName: () => string = () => `.briefonce.init-${randomUUID()}`,
  ) {}

  async write(repositoryRoot: string, files: readonly InitializationFile[]): Promise<void> {
    const destination = path.join(repositoryRoot, briefOnceDirectory);

    if (await this.fileSystem.exists(destination)) {
      throw new InitializationConflictError(destination);
    }

    const temporaryDirectoryName = this.temporaryName();
    if (
      temporaryDirectoryName.length === 0 ||
      path.isAbsolute(temporaryDirectoryName) ||
      temporaryDirectoryName.includes("/") ||
      temporaryDirectoryName.includes("\\")
    ) {
      throw new Error("Temporary initialization name must be a single relative path segment");
    }

    const temporaryDirectory = path.join(repositoryRoot, temporaryDirectoryName);
    if (await this.fileSystem.exists(temporaryDirectory)) {
      throw new InitializationConflictError(temporaryDirectory);
    }

    try {
      await this.fileSystem.ensureDirectory(temporaryDirectory);

      for (const file of [...files].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      )) {
        const destinationPath = path.join(
          temporaryDirectory,
          ...validateRelativePath(file.relativePath),
        );
        await this.fileSystem.ensureDirectory(path.dirname(destinationPath));
        await this.fileSystem.writeText(destinationPath, file.content);
      }

      await this.fileSystem.rename(temporaryDirectory, destination);
    } catch (error: unknown) {
      await this.fileSystem.remove(temporaryDirectory, { recursive: true });
      throw error;
    }
  }
}
