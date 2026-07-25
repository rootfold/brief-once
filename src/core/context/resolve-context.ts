import type { AgentFoldConfig } from "../config/types.js";
import { resolveAutomationPolicy } from "../config/automation-policy.js";
import { resolveReliabilityPolicy } from "../config/reliability-policy.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { CanonicalContextDocuments, CanonicalProjectContext } from "./types.js";
import {
  legacyProjectDirectory,
  type ProjectStorageDirectory,
} from "../storage/project-storage.js";

function enabledAdapters(
  adapters: AgentFoldConfig["adapters"],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return Object.fromEntries(
    Object.entries(adapters ?? {}).filter(([, options]) => options.enabled === true),
  );
}

export function resolveCanonicalContext(
  repositoryRoot: string,
  storageDirectory: ProjectStorageDirectory,
  config: AgentFoldConfig,
  context: CanonicalContextDocuments,
  diagnostics: readonly Diagnostic[],
): CanonicalProjectContext {
  return {
    schemaVersion: config.version,
    repositoryRoot,
    storage: {
      directory: storageDirectory,
      legacy: storageDirectory === legacyProjectDirectory,
    },
    project: config.project,
    runtime: config.runtime,
    ...(config.package_manager === undefined ? {} : { packageManager: config.package_manager }),
    commands: config.commands,
    paths: {
      source: config.paths?.source ?? [],
      tests: config.paths?.tests ?? [],
      documentation: config.paths?.documentation ?? [],
      generated: config.paths?.generated ?? [],
    },
    context,
    safety: {
      respectGitignore: config.safety.respect_gitignore,
      excludedPaths: config.safety.excluded_paths,
    },
    state: config.state,
    automation: resolveAutomationPolicy(config.automation),
    reliability: resolveReliabilityPolicy(config.reliability),
    enabledAdapters: enabledAdapters(config.adapters),
    diagnostics,
  };
}
