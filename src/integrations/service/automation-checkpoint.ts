import { commitCheckpoint, prepareCheckpoint } from "../../core/checkpoints/create-checkpoint.js";
import type { AutomationPolicy } from "../../core/config/automation-policy.js";
import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import { AtomicTextFileWriter } from "../../core/filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { loadActiveState } from "../../core/state/load-active-state.js";

export type AutomaticCheckpointTrigger = "agent_switch" | "heartbeat_timeout" | "service_restart";

function reliabilityFreshness(
  freshness: "new" | "reused" | "none",
): "current" | "reused" | "absent" {
  return freshness === "new" ? "current" : freshness === "none" ? "absent" : "reused";
}

export interface AutomaticCheckpointInput {
  readonly repositoryRoot: string;
  readonly agent: string;
  readonly policy: AutomationPolicy;
  readonly trigger: AutomaticCheckpointTrigger;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now: () => Date;
}

export type AutomaticCheckpointResult =
  | {
      readonly status: "created" | "duplicate" | "interval_skipped" | "no_active_task";
      readonly diagnostics: readonly Diagnostic[];
      readonly checkpointId?: string;
      readonly semanticRevision?: number;
      readonly semanticFreshness?: "current" | "reused" | "absent";
      readonly changedPathCount?: number;
    }
  | { readonly status: "failed"; readonly diagnostics: readonly Diagnostic[] };

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  suggestion?: string,
): Diagnostic {
  return { code, severity, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

export async function createAutomaticCheckpoint(
  input: AutomaticCheckpointInput,
): Promise<AutomaticCheckpointResult> {
  const loaded = await loadActiveState(input.fileSystem, input.repositoryRoot);
  if (loaded.status === "missing") {
    return {
      status: "no_active_task",
      diagnostics: [
        diagnostic(
          "AFSV020",
          "info",
          "No active task exists, so no automatic checkpoint was created.",
        ),
      ],
    };
  }
  if (loaded.status === "error") return { status: "failed", diagnostics: loaded.diagnostics };

  const latestAt = loaded.state.checkpointHistory.latestCheckpointAt;
  const minimumMilliseconds = input.policy.checkpoints.minimumIntervalSeconds * 1_000;
  if (
    input.trigger !== "service_restart" &&
    minimumMilliseconds > 0 &&
    latestAt !== null &&
    input.now().getTime() - Date.parse(latestAt) < minimumMilliseconds
  ) {
    return {
      status: "interval_skipped",
      diagnostics: [
        diagnostic(
          "AFSV021",
          "info",
          "The automatic checkpoint was skipped by the configured minimum interval.",
        ),
      ],
    };
  }

  const plan = await prepareCheckpoint(
    {
      fileSystem: input.fileSystem,
      gitRepositoryLocator: input.gitRepositoryLocator,
      gitInspector: input.gitInspector,
      now: input.now,
      startDirectory: input.repositoryRoot,
    },
    { agent: input.agent },
  );
  if (plan.status === "duplicate") {
    return {
      status: "duplicate",
      checkpointId: plan.checkpoint.checkpointId,
      semanticRevision: plan.checkpoint.semanticRevision,
      semanticFreshness: reliabilityFreshness(plan.checkpoint.semanticFreshness),
      diagnostics: [
        ...plan.diagnostics,
        diagnostic("AFSV022", "info", "The automatic checkpoint matched existing history."),
      ],
    };
  }
  if (plan.status !== "ready") return { status: "failed", diagnostics: plan.diagnostics };
  const committed = await commitCheckpoint(
    plan,
    input.fileSystem,
    new AtomicTextFileWriter(input.fileSystem),
  );
  if (committed.status !== "success") {
    return { status: "failed", diagnostics: committed.diagnostics };
  }
  return {
    status: "created",
    checkpointId: plan.checkpoint.checkpointId,
    semanticRevision: plan.checkpoint.semanticRevision,
    semanticFreshness: reliabilityFreshness(plan.checkpoint.semanticFreshness),
    changedPathCount: Object.values(plan.checkpoint.observedGit.changedPaths).reduce(
      (count, paths) => count + paths.length,
      0,
    ),
    diagnostics: [
      ...committed.diagnostics,
      diagnostic(
        input.trigger === "agent_switch" ? "AFSV023" : "AFSV024",
        "success",
        input.trigger === "agent_switch"
          ? "An automatic agent-switch checkpoint was created."
          : input.trigger === "service_restart"
            ? "An interrupted-session recovery checkpoint was created."
            : "A stale-session recovery checkpoint was created.",
      ),
    ],
  };
}
