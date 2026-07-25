import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { PackageManager } from "../scanners/types.js";
import type { AutomationPolicy } from "../config/automation-policy.js";
import type { ReliabilityPolicy } from "../config/reliability-policy.js";
import type { ProjectStorageDirectory } from "../storage/project-storage.js";

export interface CanonicalPathGroups {
  readonly source: readonly string[];
  readonly tests: readonly string[];
  readonly documentation: readonly string[];
  readonly generated: readonly string[];
}

export interface CanonicalContextDocuments {
  readonly project: string;
  readonly architecture: string;
  readonly commands: string;
  readonly conventions: string;
  readonly safety: string;
}

export interface CanonicalProjectContext {
  readonly schemaVersion: 1;
  readonly repositoryRoot: string;
  readonly storage: {
    readonly directory: ProjectStorageDirectory;
    readonly legacy: boolean;
  };
  readonly project: {
    readonly name: string;
    readonly summary: string;
  };
  readonly runtime: {
    readonly node: string;
  };
  readonly packageManager?: PackageManager;
  readonly commands: Readonly<Record<string, string>>;
  readonly paths: CanonicalPathGroups;
  readonly context: CanonicalContextDocuments;
  readonly safety: {
    readonly respectGitignore: boolean;
    readonly excludedPaths: readonly string[];
  };
  readonly state: {
    readonly visibility: "local" | "tracked";
  };
  readonly automation: AutomationPolicy;
  readonly reliability: ReliabilityPolicy;
  readonly enabledAdapters: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CanonicalContextSuccess {
  readonly status: "success";
  readonly repositoryRoot: string;
  readonly context: CanonicalProjectContext;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CanonicalContextFailure {
  readonly status: "error";
  readonly repositoryRoot?: string;
  readonly diagnostics: readonly Diagnostic[];
}

export type CanonicalContextLoadResult = CanonicalContextSuccess | CanonicalContextFailure;
