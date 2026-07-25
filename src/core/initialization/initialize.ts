import { ConfigValidationError } from "../config/parse-config.js";
import { serializeConfig } from "../config/serialize-config.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../git/git-repository-locator.js";
import { scanRepositoryMetadata } from "../scanners/repository-metadata.js";
import type { RepositoryMetadata } from "../scanners/types.js";
import type { AtomicInitializationWriter, InitializationFile } from "./atomic-writer.js";
import { createInitialConfig } from "./create-initial-config.js";
import { inspectInstallation, type InstallationInspection } from "./inspect-installation.js";
import { createManifest, serializeManifest } from "./manifest.js";
import { briefOncePath } from "./paths.js";
import { createContextTemplates } from "./templates.js";

interface BaseInitializationPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
  readonly inspection?: InstallationInspection;
  readonly repositoryRoot?: string;
}

export interface ReadyInitializationPlan extends BaseInitializationPlan {
  readonly status: "ready";
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly inspection: InstallationInspection;
  readonly metadata: RepositoryMetadata;
  readonly files: readonly InitializationFile[];
}

export interface TerminalInitializationPlan extends BaseInitializationPlan {
  readonly status: "not-git" | "already-initialized" | "conflict" | "invalid-configuration";
}

export type InitializationPlan = ReadyInitializationPlan | TerminalInitializationPlan;

export interface PrepareInitializationDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly agentfoldVersion: string;
  readonly now?: () => Date;
}

function inspectionDetail(inspection: InstallationInspection): string {
  const present =
    inspection.presentFiles.length === 0 ? "none" : inspection.presentFiles.join(", ");
  const missing =
    inspection.missingFiles.length === 0 ? "none" : inspection.missingFiles.join(", ");
  return `Present: ${present}. Missing: ${missing}.`;
}

function invalidConfigurationPlan(
  repositoryRoot: string,
  inspection: InstallationInspection,
  error: ConfigValidationError,
): TerminalInitializationPlan {
  return {
    status: "invalid-configuration",
    exitCode: 2,
    repositoryRoot,
    inspection,
    diagnostics: [
      {
        code: "AFI004",
        severity: "error",
        message: error.message,
      },
    ],
  };
}

export async function prepareInitialization(
  dependencies: PrepareInitializationDependencies,
): Promise<InitializationPlan> {
  const { fileSystem, gitRepositoryLocator } = dependencies;
  const workingDirectory = fileSystem.currentWorkingDirectory();
  const repositoryRoot = await gitRepositoryLocator.findRoot(workingDirectory);

  if (repositoryRoot === undefined) {
    return {
      status: "not-git",
      exitCode: 6,
      diagnostics: [
        {
          code: "AFI001",
          severity: "error",
          message: "BriefOnce initialization requires an existing Git repository.",
          suggestion: "Run init from inside a Git repository.",
        },
      ],
    };
  }

  const inspection = await inspectInstallation(fileSystem, repositoryRoot);

  if (inspection.storageConflict) {
    return {
      status: "conflict",
      exitCode: 5,
      repositoryRoot,
      inspection,
      diagnostics: [
        {
          code: "AFI002",
          severity: "error",
          message:
            "Both .briefonce and legacy .agentfold project directories exist. BriefOnce will not merge them automatically.",
          suggestion:
            "Review both directories and keep one canonical project store before retrying.",
        },
      ],
    };
  }

  if (inspection.configExists) {
    return {
      status: "already-initialized",
      exitCode: 0,
      repositoryRoot,
      inspection,
      diagnostics: [
        {
          code: "AFI002",
          severity: "info",
          message: `BriefOnce appears to be initialized${inspection.legacyStorage ? " in the legacy .agentfold directory" : ""}. ${inspectionDetail(inspection)}`,
          suggestion: inspection.legacyStorage
            ? "No files were changed. Run b1 migrate to preview the storage rebrand."
            : "No files were changed. Run b1 doctor to validate the installation.",
        },
      ],
    };
  }

  if (inspection.directoryExists || inspection.presentFiles.length > 0) {
    return {
      status: "conflict",
      exitCode: 5,
      repositoryRoot,
      inspection,
      diagnostics: [
        {
          code: "AFI002",
          severity: "error",
          message: `A partial BriefOnce installation already exists. ${inspectionDetail(inspection)}`,
          suggestion: "Review the existing files manually; init will not overwrite them.",
        },
      ],
    };
  }

  const metadata = await scanRepositoryMetadata(fileSystem, repositoryRoot);

  try {
    const config = createInitialConfig(metadata);
    const templates = createContextTemplates(config, metadata);
    const generatedPayload: Readonly<Record<string, string>> = {
      "config.yaml": serializeConfig(config),
      ...templates,
    };
    const manifest = createManifest(
      generatedPayload,
      dependencies.agentfoldVersion,
      (dependencies.now ?? (() => new Date()))(),
    );
    const files = Object.entries({
      ...generatedPayload,
      "manifest.json": serializeManifest(manifest),
    }).map(([relativePath, content]) => ({ relativePath, content }));

    return {
      status: "ready",
      exitCode: 0,
      repositoryRoot,
      inspection,
      metadata,
      files,
      diagnostics: [
        {
          code: "AFI001",
          severity: "success",
          message: `Git repository detected at ${repositoryRoot}`,
        },
        {
          code: "AFI003",
          severity: "success",
          message: "Safe repository metadata was detected without executing project code.",
        },
        {
          code: "AFI004",
          severity: "success",
          message: `${files.length} BriefOnce files are ready to create.`,
        },
      ],
    };
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) {
      return invalidConfigurationPlan(repositoryRoot, inspection, error);
    }

    throw error;
  }
}

export async function commitInitialization(
  plan: ReadyInitializationPlan,
  writer: AtomicInitializationWriter,
): Promise<readonly Diagnostic[]> {
  await writer.write(plan.repositoryRoot, plan.files);

  return [
    ...plan.diagnostics,
    {
      code: "AFI005",
      severity: "success",
      message: `${briefOncePath("config.yaml")} and canonical context files were created.`,
    },
  ];
}
