import path from "node:path";
import { z } from "zod";

import { loadCanonicalContext } from "../context/load-context.js";
import { isPathInside } from "../context/path-boundary.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import {
  AtomicFileConflictError,
  type AtomicTextFileWriter,
} from "../filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import type { GitInspector } from "../git/git-inspector.js";
import type { GitRepositoryLocator } from "../git/git-repository-locator.js";
import { portablePath } from "../initialization/paths.js";
import { activeTaskContainsSecretLikeText } from "../reports/redact-secrets.js";
import { activeTaskSchema } from "../state/active-state-schema.js";
import { canonicalContextFailureExitCode } from "../state/context-requirement.js";
import {
  activeStateDirectoryRelativePath,
  activeStateRelativePath,
  loadActiveState,
} from "../state/load-active-state.js";
import { serializeActiveState } from "../state/serialize-active-state.js";
import type { ActiveTask } from "../state/types.js";
import { agentNameSchema } from "../state/value-schemas.js";
import { assembleCheckpoint } from "./assemble-checkpoint.js";
import {
  allocateCheckpointId,
  CheckpointSequenceExhaustedError,
  checkpointSequenceFromFileName,
} from "./checkpoint-id.js";
import { serializeCheckpoint } from "./serialize-checkpoint.js";
import type { Checkpoint } from "./types.js";

export const checkpointHistoryRelativePath = ".agentfold/state/history";

interface BaseCheckpointPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
  readonly repositoryRoot?: string;
}

export interface ReadyCheckpointPlan extends BaseCheckpointPlan {
  readonly status: "ready";
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly visibility: "local" | "tracked";
  readonly checkpoint: Checkpoint;
  readonly updatedState: ActiveTask;
  readonly historyPath: string;
  readonly statePath: string;
  readonly serializedCheckpoint: string;
  readonly serializedState: string;
}

export interface DuplicateCheckpointPlan extends BaseCheckpointPlan {
  readonly status: "duplicate";
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly visibility: "local" | "tracked";
  readonly checkpoint: Checkpoint;
}

export interface TerminalCheckpointPlan extends BaseCheckpointPlan {
  readonly status:
    | "invalid-agent"
    | "invalid-context"
    | "missing-state"
    | "invalid-state"
    | "invalid-checkpoint"
    | "unsafe-state"
    | "history-conflict"
    | "git-error"
    | "filesystem-error";
}

export type CheckpointPlan = ReadyCheckpointPlan | DuplicateCheckpointPlan | TerminalCheckpointPlan;

export interface PrepareCheckpointDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now?: () => Date;
  readonly startDirectory?: string;
}

export interface PrepareCheckpointInput {
  readonly agent?: string;
}

export type CheckpointCommitResult =
  | {
      readonly status: "success";
      readonly exitCode: 0;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly status: "history-conflict" | "write-failure" | "rollback-failure";
      readonly exitCode: 1 | 5;
      readonly diagnostics: readonly Diagnostic[];
    };

function terminal(
  status: TerminalCheckpointPlan["status"],
  exitCode: number,
  diagnostics: readonly Diagnostic[],
  repositoryRoot?: string,
): TerminalCheckpointPlan {
  return {
    status,
    exitCode,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    diagnostics,
  };
}

export async function listCheckpointHistoryFileNames(
  fileSystem: FileSystem,
  repositoryRoot: string,
): Promise<readonly string[]> {
  const historyDirectory = path.join(repositoryRoot, ...checkpointHistoryRelativePath.split("/"));
  const entryType = await fileSystem.entryType(historyDirectory);
  if (entryType === undefined) {
    const [realRoot, realStateDirectory] = await Promise.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(path.dirname(historyDirectory)),
    ]);
    if (!isPathInside(realRoot, realStateDirectory)) {
      throw new Error("The active-state directory resolves outside the Git repository.");
    }
    return [];
  }
  if (entryType !== "directory") {
    throw new AtomicFileConflictError(historyDirectory);
  }
  const [realRoot, realHistoryDirectory] = await Promise.all([
    fileSystem.realPath(repositoryRoot),
    fileSystem.realPath(historyDirectory),
  ]);
  if (!isPathInside(realRoot, realHistoryDirectory)) {
    throw new Error("The checkpoint-history directory resolves outside the Git repository.");
  }
  return fileSystem.listDirectory(realHistoryDirectory);
}

function checkpointDiagnostics(
  contextDiagnostics: readonly Diagnostic[],
  gitDiagnostics: readonly Diagnostic[],
  checkpoint: Checkpoint,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [
    ...contextDiagnostics,
    ...gitDiagnostics,
    {
      code: "AFCP001",
      severity: "success",
      message: `Active task: ${checkpoint.taskId} — ${checkpoint.taskTitle}`,
    },
  ];
  if (checkpoint.semanticFreshness === "none") {
    diagnostics.push({
      code: "AFCP004",
      severity: "warning",
      message: "No semantic report has been submitted; this is a Git-only checkpoint.",
      suggestion: "Submit agentfold report --stdin when semantic progress is available.",
    });
  } else if (checkpoint.semanticFreshness === "reused") {
    diagnostics.push({
      code: "AFCP005",
      severity: "info",
      message: `No new semantic report exists; revision ${checkpoint.semanticRevision} is reused.`,
    });
  }
  if (checkpoint.observedGit.changedPaths.untracked.length > 0) {
    diagnostics.push({
      code: "AFCP006",
      severity: "warning",
      message: "Untracked paths were recorded, but their contents were not inspected.",
    });
  }
  return diagnostics;
}

export async function prepareCheckpoint(
  dependencies: PrepareCheckpointDependencies,
  input: PrepareCheckpointInput = {},
): Promise<CheckpointPlan> {
  const agentResult =
    input.agent === undefined ? undefined : agentNameSchema.safeParse(input.agent);
  if (agentResult !== undefined && !agentResult.success) {
    return terminal("invalid-agent", 2, [
      {
        code: "AFCP002",
        severity: "error",
        message: "Checkpointing agent must contain 1 to 100 characters after trimming.",
      },
    ]);
  }

  const contextResult = await loadCanonicalContext({
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
    ...(dependencies.startDirectory === undefined
      ? {}
      : { startDirectory: dependencies.startDirectory }),
  });
  if (contextResult.status === "error") {
    return terminal(
      "invalid-context",
      canonicalContextFailureExitCode(contextResult),
      contextResult.diagnostics,
      contextResult.repositoryRoot,
    );
  }

  const repositoryRoot = contextResult.repositoryRoot;
  const loadedState = await loadActiveState(dependencies.fileSystem, repositoryRoot);
  if (loadedState.status === "missing") {
    return terminal(
      "missing-state",
      5,
      [
        {
          code: "AFCP003",
          severity: "error",
          message: "No active task exists to checkpoint.",
          suggestion: "Run agentfold start before creating a checkpoint.",
        },
      ],
      repositoryRoot,
    );
  }
  if (loadedState.status === "error") {
    return terminal(
      "invalid-state",
      2,
      [
        {
          code: "AFCP018",
          severity: "error",
          message: "The active task is invalid and cannot be checkpointed.",
          suggestion: "Correct the active state; BriefOnce did not modify it.",
        },
        ...loadedState.diagnostics,
      ],
      repositoryRoot,
    );
  }
  if (activeTaskContainsSecretLikeText(loadedState.state)) {
    return terminal(
      "unsafe-state",
      4,
      [
        {
          code: "AFCP008",
          severity: "error",
          message: "Secret-like content was found in semantic active-task state.",
          suggestion: "Edit or redact the active state before checkpointing; no value was copied.",
        },
      ],
      repositoryRoot,
    );
  }

  try {
    const [historyEntries, gitObservation] = await Promise.all([
      listCheckpointHistoryFileNames(dependencies.fileSystem, repositoryRoot),
      dependencies.gitInspector.readCheckpointFacts(repositoryRoot, {
        startingCommit: loadedState.state.startingCommit,
        startedAt: loadedState.state.startedAt,
      }),
    ]);
    const entriesForAllocation =
      loadedState.state.checkpointHistory.latestCheckpointId === null
        ? historyEntries
        : [
            ...historyEntries,
            `${loadedState.state.taskId}-${loadedState.state.checkpointHistory.latestCheckpointId}.md`,
          ];
    const allocated = allocateCheckpointId(
      loadedState.state.taskId,
      loadedState.state.checkpointHistory.count,
      entriesForAllocation,
    );
    const timestamp = (dependencies.now ?? (() => new Date()))().toISOString();
    const checkpoint = assembleCheckpoint({
      activeTask: loadedState.state,
      gitFacts: gitObservation.facts,
      checkpointId: allocated.checkpointId,
      createdAt: timestamp,
      ...(agentResult?.success === true ? { checkpointAgent: agentResult.data } : {}),
    });
    const diagnostics = checkpointDiagnostics(
      contextResult.diagnostics,
      gitObservation.diagnostics,
      checkpoint,
    );

    if (contextResult.context.state.visibility === "local") {
      if (
        !(await dependencies.gitInspector.isPathIgnored(
          repositoryRoot,
          activeStateDirectoryRelativePath,
        ))
      ) {
        diagnostics.push({
          code: "AFCP009",
          severity: "warning",
          message: "Local checkpoint state is not ignored by Git.",
          suggestion: "Add only .agentfold/state/ to .gitignore; BriefOnce did not edit it.",
        });
      }
    }

    if (
      loadedState.state.checkpointHistory.latestFingerprint === checkpoint.fingerprint &&
      loadedState.state.checkpointHistory.latestCheckpointId !== null
    ) {
      const latestHistoryPath = path.join(
        repositoryRoot,
        ...checkpointHistoryRelativePath.split("/"),
        `${loadedState.state.taskId}-${loadedState.state.checkpointHistory.latestCheckpointId}.md`,
      );
      if (await dependencies.fileSystem.exists(latestHistoryPath)) {
        diagnostics.push({
          code: "AFCP007",
          severity: "info",
          message: `No meaningful Git or semantic state changed since ${loadedState.state.checkpointHistory.latestCheckpointId}.`,
          suggestion: "No checkpoint was created and existing files were left unchanged.",
        });
        return {
          status: "duplicate",
          exitCode: 0,
          repositoryRoot,
          visibility: contextResult.context.state.visibility,
          checkpoint,
          diagnostics,
        };
      }
    }

    const historyPath = path.join(
      repositoryRoot,
      ...checkpointHistoryRelativePath.split("/"),
      allocated.fileName,
    );
    if (await dependencies.fileSystem.exists(historyPath)) {
      return terminal(
        "history-conflict",
        5,
        [
          ...diagnostics,
          {
            code: "AFCP010",
            severity: "error",
            message: `Checkpoint history already exists: ${portablePath(path.relative(repositoryRoot, historyPath))}`,
            suggestion: "No existing history file was overwritten.",
          },
        ],
        repositoryRoot,
      );
    }

    const matchingHistoryCount = historyEntries.filter(
      (entry) => checkpointSequenceFromFileName(loadedState.state.taskId, entry) !== null,
    ).length;
    const updatedState = activeTaskSchema.parse({
      ...loadedState.state,
      currentBranch: gitObservation.facts.branch,
      currentCommit: gitObservation.facts.commit,
      updatedAt: timestamp,
      checkpointHistory: {
        count: Math.max(loadedState.state.checkpointHistory.count, matchingHistoryCount) + 1,
        latestCheckpointAt: timestamp,
        latestCheckpointId: checkpoint.checkpointId,
        latestFingerprint: checkpoint.fingerprint,
        latestSemanticRevision: loadedState.state.reportRevision,
      },
    });

    return {
      status: "ready",
      exitCode: 0,
      repositoryRoot,
      visibility: contextResult.context.state.visibility,
      checkpoint,
      updatedState,
      historyPath,
      statePath: path.join(repositoryRoot, ...activeStateRelativePath.split("/")),
      serializedCheckpoint: serializeCheckpoint(checkpoint),
      serializedState: serializeActiveState(updatedState),
      diagnostics,
    };
  } catch (error: unknown) {
    if (error instanceof CheckpointSequenceExhaustedError) {
      return terminal(
        "history-conflict",
        5,
        [
          {
            code: "AFCP019",
            severity: "error",
            message: "The checkpoint sequence has reached its CP-999 limit.",
            suggestion: "Finish the active task before creating more checkpoint history.",
          },
        ],
        repositoryRoot,
      );
    }
    if (error instanceof z.ZodError) {
      return terminal(
        "invalid-checkpoint",
        2,
        [
          {
            code: "AFCP020",
            severity: "error",
            message: "Observed facts and active state did not form a valid checkpoint model.",
            suggestion: "Correct the repository or active state; nothing was written.",
          },
        ],
        repositoryRoot,
      );
    }
    if (error instanceof AtomicFileConflictError) {
      return terminal(
        "history-conflict",
        5,
        [
          {
            code: "AFCP010",
            severity: "error",
            message: "Checkpoint history path conflicts with an existing file.",
            suggestion: "Review .agentfold/state/history; nothing was written.",
          },
        ],
        repositoryRoot,
      );
    }
    const gitError =
      error instanceof Error &&
      ["GitInspectionError", "GitStatusParseError", "GitNumstatParseError"].includes(error.name);
    return terminal(
      gitError ? "git-error" : "filesystem-error",
      gitError ? 6 : 1,
      [
        {
          code: gitError ? "AFCP011" : "AFCP012",
          severity: "error",
          message: gitError
            ? "Git checkpoint facts could not be captured safely."
            : "Checkpoint preparation failed before any files were written.",
          suggestion: "Correct the repository or filesystem state and retry.",
        },
      ],
      repositoryRoot,
    );
  }
}

export async function commitCheckpoint(
  plan: ReadyCheckpointPlan,
  fileSystem: FileSystem,
  writer: AtomicTextFileWriter,
): Promise<CheckpointCommitResult> {
  try {
    await writer.write(plan.historyPath, plan.serializedCheckpoint, "create");
  } catch (error: unknown) {
    const conflict = error instanceof AtomicFileConflictError;
    return {
      status: conflict ? "history-conflict" : "write-failure",
      exitCode: conflict ? 5 : 1,
      diagnostics: [
        ...plan.diagnostics,
        {
          code: conflict ? "AFCP010" : "AFCP012",
          severity: "error",
          message: conflict
            ? "Checkpoint history appeared before the atomic create completed."
            : "Checkpoint history could not be created atomically.",
          suggestion: "Existing history and active state were not modified.",
        },
      ],
    };
  }

  try {
    await writer.write(plan.statePath, plan.serializedState, "replace");
  } catch {
    try {
      await fileSystem.remove(plan.historyPath);
    } catch {
      return {
        status: "rollback-failure",
        exitCode: 1,
        diagnostics: [
          ...plan.diagnostics,
          {
            code: "AFCP013",
            severity: "error",
            message: "Active-state update and checkpoint rollback both failed.",
            suggestion: `Remove only ${portablePath(path.relative(plan.repositoryRoot, plan.historyPath))}, verify ${activeStateRelativePath}, and retry.`,
          },
        ],
      };
    }
    return {
      status: "write-failure",
      exitCode: 1,
      diagnostics: [
        ...plan.diagnostics,
        {
          code: "AFCP014",
          severity: "error",
          message: "Active state could not be updated; the new history file was rolled back.",
          suggestion: "The previous active state was preserved. Check permissions and retry.",
        },
      ],
    };
  }

  return {
    status: "success",
    exitCode: 0,
    diagnostics: [
      ...plan.diagnostics,
      {
        code: "AFCP015",
        severity: "success",
        message: `Created ${portablePath(path.relative(plan.repositoryRoot, plan.historyPath))}`,
      },
      {
        code: "AFCP016",
        severity: "success",
        message: `Updated ${activeStateRelativePath}`,
      },
    ],
  };
}
