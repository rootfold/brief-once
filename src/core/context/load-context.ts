import path from "node:path";

import { ConfigSyntaxError, loadConfig } from "../config/load-config.js";
import { ConfigValidationError } from "../config/parse-config.js";
import type { AgentFoldConfig } from "../config/types.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../git/git-repository-locator.js";
import { canonicalContextFileEntries, type CanonicalContextFileName } from "./context-files.js";
import { isPathInside, resolvePortableRepositoryPath } from "./path-boundary.js";
import { resolveCanonicalContext } from "./resolve-context.js";
import type { CanonicalContextDocuments, CanonicalContextLoadResult } from "./types.js";

export interface LoadCanonicalContextDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly startDirectory?: string;
}

interface RepositoryBoundary {
  readonly lexicalRoot: string;
  readonly realRoot: string;
}

const configuredPathGroups = ["source", "tests", "documentation", "generated"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown filesystem error";
}

function failure(
  diagnostics: readonly Diagnostic[],
  repositoryRoot?: string,
): CanonicalContextLoadResult {
  return {
    status: "error",
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    diagnostics,
  };
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function normalizeContextContent(content: string): string {
  return content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

async function safeExistingRealPath(
  fileSystem: FileSystem,
  boundary: RepositoryBoundary,
  candidate: string,
): Promise<string | undefined> {
  if (!isPathInside(boundary.lexicalRoot, candidate)) {
    return undefined;
  }

  const realCandidate = await fileSystem.realPath(candidate);
  return isPathInside(boundary.realRoot, realCandidate) ? realCandidate : undefined;
}

function configValidationDiagnostics(error: ConfigValidationError): readonly Diagnostic[] {
  return error.issues.map((issue) => {
    const unsafePath = issue.path === "paths" || issue.path.startsWith("paths.");

    return {
      code: unsafePath ? "AFC007" : "AFC004",
      severity: "error",
      message: `${issue.path}: ${issue.message}`,
      suggestion: unsafePath
        ? "Use normalized repository-relative paths without absolute prefixes or parent traversal."
        : "Correct .agentfold/config.yaml and run the command again.",
    };
  });
}

async function loadValidatedConfig(
  fileSystem: FileSystem,
  boundary: RepositoryBoundary,
  diagnostics: Diagnostic[],
): Promise<AgentFoldConfig | undefined> {
  const configPath = path.join(boundary.lexicalRoot, ".agentfold", "config.yaml");

  try {
    if (!(await fileSystem.exists(configPath))) {
      diagnostics.push({
        code: "AFC002",
        severity: "error",
        message: ".agentfold/config.yaml was not found.",
        suggestion: "Run agentfold init from inside the repository.",
      });
      return undefined;
    }

    const safeConfigPath = await safeExistingRealPath(fileSystem, boundary, configPath);
    if (safeConfigPath === undefined) {
      diagnostics.push({
        code: "AFC010",
        severity: "error",
        message: ".agentfold/config.yaml resolves outside the Git repository.",
        suggestion: "Replace the escaping symbolic link with a file inside the repository.",
      });
      return undefined;
    }

    return await loadConfig(fileSystem, safeConfigPath);
  } catch (error: unknown) {
    if (error instanceof ConfigSyntaxError) {
      diagnostics.push({
        code: "AFC003",
        severity: "error",
        message: error.message,
        suggestion: "Correct the YAML syntax in .agentfold/config.yaml.",
      });
      return undefined;
    }

    if (error instanceof ConfigValidationError) {
      diagnostics.push(...configValidationDiagnostics(error));
      return undefined;
    }

    diagnostics.push({
      code: "AFC009",
      severity: "error",
      message: `Could not load .agentfold/config.yaml: ${errorMessage(error)}`,
      suggestion: "Check the file type and repository permissions, then retry.",
    });
    return undefined;
  }
}

async function loadContextDocuments(
  fileSystem: FileSystem,
  boundary: RepositoryBoundary,
  diagnostics: Diagnostic[],
): Promise<Partial<CanonicalContextDocuments>> {
  const documents: Partial<Record<CanonicalContextFileName, string>> = {};

  for (const [name, relativePath] of canonicalContextFileEntries) {
    const contextPath = resolvePortableRepositoryPath(boundary.lexicalRoot, relativePath);

    try {
      if (!(await fileSystem.exists(contextPath))) {
        diagnostics.push({
          code: "AFC005",
          severity: "error",
          message: `Required canonical context file is missing: ${relativePath}`,
          suggestion: "Restore the file inside .agentfold/context; loading never recreates it.",
        });
        continue;
      }

      const safeContextPath = await safeExistingRealPath(fileSystem, boundary, contextPath);
      if (safeContextPath === undefined) {
        diagnostics.push({
          code: "AFC010",
          severity: "error",
          message: `${relativePath} resolves outside the Git repository.`,
          suggestion: "Replace the escaping symbolic link with a file inside the repository.",
        });
        continue;
      }

      const content = normalizeContextContent(await fileSystem.readText(safeContextPath));
      documents[name] = content;

      if (content.trim().length === 0) {
        diagnostics.push({
          code: "AFC006",
          severity: "warning",
          message: `Canonical context file is empty: ${relativePath}`,
          suggestion: "Add concise project guidance before generating adapter instructions.",
        });
      }
    } catch (error: unknown) {
      diagnostics.push({
        code: "AFC009",
        severity: "error",
        message: `Could not read ${relativePath}: ${errorMessage(error)}`,
        suggestion: "Check the file type and repository permissions, then retry.",
      });
    }
  }

  return documents;
}

async function inspectConfiguredPaths(
  fileSystem: FileSystem,
  boundary: RepositoryBoundary,
  config: AgentFoldConfig,
  diagnostics: Diagnostic[],
): Promise<void> {
  for (const group of configuredPathGroups) {
    for (const configuredPath of config.paths?.[group] ?? []) {
      const candidate = resolvePortableRepositoryPath(boundary.lexicalRoot, configuredPath);

      try {
        if (!isPathInside(boundary.lexicalRoot, candidate)) {
          diagnostics.push({
            code: "AFC007",
            severity: "error",
            message: `Configured ${group} path escapes the repository: ${configuredPath}`,
            suggestion: "Use a normalized repository-relative path.",
          });
          continue;
        }

        if (!(await fileSystem.exists(candidate))) {
          diagnostics.push({
            code: "AFC008",
            severity: "warning",
            message: `Configured ${group} path does not exist: ${configuredPath}`,
            suggestion: "Create the path or remove it from .agentfold/config.yaml.",
          });
          continue;
        }

        if ((await safeExistingRealPath(fileSystem, boundary, candidate)) === undefined) {
          diagnostics.push({
            code: "AFC007",
            severity: "error",
            message: `Configured ${group} path resolves outside the repository: ${configuredPath}`,
            suggestion: "Replace the escaping symbolic link or remove the configured path.",
          });
        }
      } catch (error: unknown) {
        diagnostics.push({
          code: "AFC009",
          severity: "error",
          message: `Could not inspect configured ${group} path ${configuredPath}: ${errorMessage(error)}`,
          suggestion: "Check repository permissions and the configured path, then retry.",
        });
      }
    }
  }
}

function completeDocuments(
  documents: Partial<CanonicalContextDocuments>,
): documents is CanonicalContextDocuments {
  return canonicalContextFileEntries.every(([name]) => documents[name] !== undefined);
}

export async function loadCanonicalContext(
  dependencies: LoadCanonicalContextDependencies,
): Promise<CanonicalContextLoadResult> {
  const { fileSystem, gitRepositoryLocator } = dependencies;
  const diagnostics: Diagnostic[] = [];
  let startDirectory: string;

  try {
    startDirectory = dependencies.startDirectory ?? fileSystem.currentWorkingDirectory();
  } catch (error: unknown) {
    diagnostics.push({
      code: "AFC009",
      severity: "error",
      message: `Could not determine the working directory: ${errorMessage(error)}`,
      suggestion: "Run BriefOnce from an accessible directory.",
    });
    return failure(diagnostics);
  }

  let repositoryRoot: string | undefined;

  try {
    repositoryRoot = await gitRepositoryLocator.findRoot(startDirectory);
  } catch (error: unknown) {
    diagnostics.push({
      code: "AFC009",
      severity: "error",
      message: `Git repository detection failed: ${errorMessage(error)}`,
      suggestion: "Check repository permissions and retry.",
    });
    return failure(diagnostics);
  }

  if (repositoryRoot === undefined) {
    diagnostics.push({
      code: "AFC001",
      severity: "error",
      message: "Canonical context resolution requires an existing Git repository.",
      suggestion: "Run the command from inside a Git repository.",
    });
    return failure(diagnostics);
  }

  const lexicalRoot = path.resolve(repositoryRoot);
  let realRoot: string;

  try {
    realRoot = await fileSystem.realPath(lexicalRoot);
  } catch (error: unknown) {
    diagnostics.push({
      code: "AFC009",
      severity: "error",
      message: `Could not resolve the Git repository root: ${errorMessage(error)}`,
      suggestion: "Check repository permissions and retry.",
    });
    return failure(diagnostics, lexicalRoot);
  }

  const boundary = { lexicalRoot, realRoot };
  const config = await loadValidatedConfig(fileSystem, boundary, diagnostics);

  if (config === undefined) {
    return failure(diagnostics, lexicalRoot);
  }

  const documents = await loadContextDocuments(fileSystem, boundary, diagnostics);
  await inspectConfiguredPaths(fileSystem, boundary, config, diagnostics);

  if (hasErrors(diagnostics) || !completeDocuments(documents)) {
    return failure(diagnostics, lexicalRoot);
  }

  const context = resolveCanonicalContext(lexicalRoot, config, documents, diagnostics);

  return {
    status: "success",
    repositoryRoot: lexicalRoot,
    context,
    diagnostics,
  };
}
