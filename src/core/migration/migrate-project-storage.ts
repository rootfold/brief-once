import path from "node:path";

import { loadCanonicalContext } from "../context/load-context.js";
import { isPathInside } from "../context/path-boundary.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../git/git-repository-locator.js";
import { inspectInstallation } from "../initialization/inspect-installation.js";
import {
  legacyProjectDirectory,
  preferredProjectDirectory,
  projectStorageAbsolutePath,
} from "../storage/project-storage.js";

const stagedManifestName = ".manifest.json.briefonce-migration";

interface BaseMigrationPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
  readonly repositoryRoot?: string;
}

export interface ReadyProjectStorageMigrationPlan extends BaseMigrationPlan {
  readonly status: "ready";
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly sourceDirectory: string;
  readonly destinationDirectory: string;
  readonly sourceManifestPath: string;
  readonly stagedManifestPath: string;
  readonly originalManifest: string;
  readonly migratedManifest: string;
}

export interface TerminalProjectStorageMigrationPlan extends BaseMigrationPlan {
  readonly status:
    "not-git" | "not-initialized" | "already-migrated" | "conflict" | "invalid-installation";
}

export type ProjectStorageMigrationPlan =
  ReadyProjectStorageMigrationPlan | TerminalProjectStorageMigrationPlan;

export class ProjectStorageMigrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectStorageMigrationConflictError";
  }
}

export class ProjectStorageMigrationRollbackError extends Error {
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "ProjectStorageMigrationRollbackError";
  }
}

export interface PrepareProjectStorageMigrationDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly startDirectory?: string;
}

function terminal(
  status: TerminalProjectStorageMigrationPlan["status"],
  exitCode: number,
  diagnostics: readonly Diagnostic[],
  repositoryRoot?: string,
): TerminalProjectStorageMigrationPlan {
  return {
    status,
    exitCode,
    diagnostics,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
  };
}

function migrateManifestPath(value: string): string {
  return value.startsWith(`${legacyProjectDirectory}/`)
    ? `${preferredProjectDirectory}/${value.slice(legacyProjectDirectory.length + 1)}`
    : value;
}

function migratedManifest(source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("The legacy manifest is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The legacy manifest must contain one JSON object.");
  }
  const manifest = parsed as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.generatedFiles) ||
    !manifest.generatedFiles.every((entry) => typeof entry === "string") ||
    typeof manifest.hashes !== "object" ||
    manifest.hashes === null ||
    Array.isArray(manifest.hashes)
  ) {
    throw new Error("The legacy manifest does not match the supported schema.");
  }
  const sourceHashes = manifest.hashes as Record<string, unknown>;
  if (!Object.values(sourceHashes).every((value) => typeof value === "string")) {
    throw new Error("The legacy manifest contains an invalid file hash.");
  }

  const generatedFiles = (manifest.generatedFiles as string[]).map(migrateManifestPath);
  if (new Set(generatedFiles).size !== generatedFiles.length) {
    throw new Error("The legacy manifest produces duplicate paths after migration.");
  }
  const hashes = Object.fromEntries(
    Object.entries(sourceHashes)
      .map(([filePath, hash]) => [migrateManifestPath(filePath), hash] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (Object.keys(hashes).length !== Object.keys(sourceHashes).length) {
    throw new Error("The legacy manifest produces duplicate hash paths after migration.");
  }

  return `${JSON.stringify({ ...manifest, generatedFiles, hashes }, undefined, 2)}\n`;
}

export async function prepareProjectStorageMigration(
  dependencies: PrepareProjectStorageMigrationDependencies,
): Promise<ProjectStorageMigrationPlan> {
  const { fileSystem, gitRepositoryLocator } = dependencies;
  let startDirectory: string;
  try {
    startDirectory = dependencies.startDirectory ?? fileSystem.currentWorkingDirectory();
  } catch {
    return terminal("not-git", 6, [
      {
        code: "AFMG001",
        severity: "error",
        message: "The current working directory could not be determined.",
      },
    ]);
  }
  const repositoryRoot = await gitRepositoryLocator.findRoot(startDirectory);
  if (repositoryRoot === undefined) {
    return terminal("not-git", 6, [
      {
        code: "AFMG001",
        severity: "error",
        message: "Project storage migration requires an existing Git repository.",
        suggestion: "Run b1 migrate from inside the repository.",
      },
    ]);
  }

  const inspection = await inspectInstallation(fileSystem, repositoryRoot);
  if (inspection.storageConflict) {
    return terminal(
      "conflict",
      5,
      [
        {
          code: "AFMG002",
          severity: "error",
          message: "Both .briefonce and legacy .agentfold directories already exist.",
          suggestion:
            "Review both directories manually; migration never merges or overwrites them.",
        },
      ],
      repositoryRoot,
    );
  }
  if (!inspection.directoryExists) {
    return terminal(
      "not-initialized",
      6,
      [
        {
          code: "AFMG003",
          severity: "error",
          message: "No legacy .agentfold project directory exists to migrate.",
          suggestion: "Run b1 init --yes for a new BriefOnce project.",
        },
      ],
      repositoryRoot,
    );
  }
  if (!inspection.legacyStorage) {
    return terminal(
      "already-migrated",
      0,
      [
        {
          code: "AFMG004",
          severity: "info",
          message: "Project storage already uses .briefonce. No files were changed.",
        },
      ],
      repositoryRoot,
    );
  }
  if (!inspection.configExists || inspection.missingFiles.length > 0) {
    return terminal(
      "invalid-installation",
      5,
      [
        {
          code: "AFMG005",
          severity: "error",
          message: `The legacy installation is incomplete. Missing: ${inspection.missingFiles.join(", ")}.`,
          suggestion: "Restore or review the missing files before migration.",
        },
      ],
      repositoryRoot,
    );
  }

  const canonical = await loadCanonicalContext({
    fileSystem,
    gitRepositoryLocator,
    startDirectory,
  });
  if (canonical.status === "error") {
    return terminal(
      "invalid-installation",
      2,
      [
        {
          code: "AFMG006",
          severity: "error",
          message: "Legacy canonical context is invalid and cannot be migrated safely.",
        },
        ...canonical.diagnostics,
      ],
      repositoryRoot,
    );
  }

  const sourceDirectory = projectStorageAbsolutePath(repositoryRoot, legacyProjectDirectory);
  const destinationDirectory = projectStorageAbsolutePath(
    repositoryRoot,
    preferredProjectDirectory,
  );
  try {
    if (
      (fileSystem.isSymbolicLink !== undefined &&
        (await fileSystem.isSymbolicLink(sourceDirectory))) ||
      !isPathInside(
        await fileSystem.realPath(repositoryRoot),
        await fileSystem.realPath(sourceDirectory),
      )
    ) {
      throw new Error("The legacy project directory is a symbolic link or escapes the repository.");
    }
    const sourceManifestPath = path.join(sourceDirectory, "manifest.json");
    const originalManifest = await fileSystem.readText(sourceManifestPath);
    return {
      status: "ready",
      exitCode: 0,
      repositoryRoot,
      sourceDirectory,
      destinationDirectory,
      sourceManifestPath,
      stagedManifestPath: path.join(sourceDirectory, stagedManifestName),
      originalManifest,
      migratedManifest: migratedManifest(originalManifest),
      diagnostics: [
        ...canonical.diagnostics,
        {
          code: "AFMG007",
          severity: "success",
          message: "Legacy .agentfold storage is ready to migrate atomically to .briefonce.",
        },
      ],
    };
  } catch (error: unknown) {
    return terminal(
      "invalid-installation",
      2,
      [
        {
          code: "AFMG006",
          severity: "error",
          message:
            error instanceof Error ? error.message : "Legacy storage could not be validated.",
          suggestion: "No files were changed.",
        },
      ],
      repositoryRoot,
    );
  }
}

export async function commitProjectStorageMigration(
  plan: ReadyProjectStorageMigrationPlan,
  fileSystem: FileSystem,
): Promise<readonly Diagnostic[]> {
  if (
    (await fileSystem.entryType(plan.sourceDirectory)) !== "directory" ||
    (await fileSystem.exists(plan.destinationDirectory)) ||
    (fileSystem.isSymbolicLink !== undefined &&
      ((await fileSystem.isSymbolicLink(plan.sourceDirectory)) ||
        (await fileSystem.isSymbolicLink(plan.destinationDirectory)))) ||
    (await fileSystem.exists(plan.stagedManifestPath)) ||
    (await fileSystem.readText(plan.sourceManifestPath)) !== plan.originalManifest
  ) {
    throw new ProjectStorageMigrationConflictError(
      "Project storage changed after migration preparation.",
    );
  }

  try {
    await fileSystem.writeTextAndFlush(plan.stagedManifestPath, plan.migratedManifest);
  } catch (error: unknown) {
    await fileSystem.remove(plan.stagedManifestPath);
    throw error;
  }
  try {
    await fileSystem.rename(plan.sourceDirectory, plan.destinationDirectory);
  } catch (error: unknown) {
    await fileSystem.remove(plan.stagedManifestPath);
    throw error;
  }

  const migratedStagePath = path.join(plan.destinationDirectory, stagedManifestName);
  const migratedManifestPath = path.join(plan.destinationDirectory, "manifest.json");
  try {
    await fileSystem.rename(migratedStagePath, migratedManifestPath);
  } catch (error: unknown) {
    try {
      await fileSystem.remove(migratedStagePath);
      await fileSystem.rename(plan.destinationDirectory, plan.sourceDirectory);
    } catch (rollbackError: unknown) {
      throw new ProjectStorageMigrationRollbackError(
        "Storage migration and rollback both failed; inspect .briefonce and .agentfold manually.",
        rollbackError,
      );
    }
    throw error;
  }

  return [
    ...plan.diagnostics,
    {
      code: "AFMG008",
      severity: "success",
      message:
        "Renamed .agentfold to .briefonce and normalized manifest paths. Project content was preserved.",
    },
  ];
}
