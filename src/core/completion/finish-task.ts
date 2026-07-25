import path from "node:path";
import { z } from "zod";

import { assembleCheckpoint } from "../checkpoints/assemble-checkpoint.js";
import {
  checkpointHistoryRelativePathFor,
  listCheckpointHistoryFileNames,
} from "../checkpoints/create-checkpoint.js";
import {
  allocateCheckpointId,
  CheckpointSequenceExhaustedError,
  checkpointSequenceFromFileName,
} from "../checkpoints/checkpoint-id.js";
import { parseCheckpoint } from "../checkpoints/parse-checkpoint.js";
import { serializeCheckpoint } from "../checkpoints/serialize-checkpoint.js";
import type { Checkpoint } from "../checkpoints/types.js";
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
import {
  projectStorageAbsolutePath,
  type ProjectStorageDirectory,
} from "../storage/project-storage.js";
import { mergeAgentReport } from "../reports/merge-report.js";
import {
  activeTaskContainsSecretLikeText,
  checkpointContainsSecretLikeText,
  containsSecretLikeText,
  redactAgentReport,
  redactSecretLikeText,
} from "../reports/redact-secrets.js";
import type { AgentReport } from "../reports/types.js";
import { activeTaskSchema } from "../state/active-state-schema.js";
import { canonicalContextFailureExitCode } from "../state/context-requirement.js";
import { loadActiveState } from "../state/load-active-state.js";
import type { ActiveTask } from "../state/types.js";
import { agentNameSchema } from "../state/value-schemas.js";
import {
  CompletionInputValidationError,
  parseCompletionInput,
  type CompletionInput,
} from "./completion-input-schema.js";
import { completedTaskSchema } from "./completed-task-schema.js";
import { completedTasksRelativePathFor } from "./load-completed-task.js";
import { serializeCompletedTask } from "./serialize-completed-task.js";
import type { CompletedTask } from "./types.js";

interface BaseFinishPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
  readonly repositoryRoot?: string;
}

export interface ReadyFinishPlan extends BaseFinishPlan {
  readonly status: "ready";
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly visibility: "local" | "tracked";
  readonly task: CompletedTask;
  readonly checkpoint: Checkpoint;
  readonly statePath: string;
  readonly historyPath: string;
  readonly completedPath: string;
  readonly originalStateSource: string;
  readonly serializedCheckpoint: string;
  readonly serializedCompletedTask: string;
  readonly redactionCount: number;
}

export interface TerminalFinishPlan extends BaseFinishPlan {
  readonly status:
    | "invalid-context"
    | "missing-state"
    | "invalid-state"
    | "invalid-json"
    | "invalid-input"
    | "unsafe-content"
    | "not-ready"
    | "history-conflict"
    | "completed-conflict"
    | "git-error"
    | "filesystem-error";
  readonly unresolvedInProgress?: readonly string[];
  readonly unresolvedBlockers?: readonly string[];
}

export type FinishPlan = ReadyFinishPlan | TerminalFinishPlan;

export interface PrepareTaskFinishDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now?: () => Date;
  readonly startDirectory?: string;
}

export interface PrepareTaskFinishInput {
  readonly json?: string;
  readonly completion?: unknown;
  readonly agentOverride?: string;
}

export type FinishCommitResult =
  | {
      readonly status: "success";
      readonly exitCode: 0;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly status:
        | "state-changed"
        | "history-conflict"
        | "completed-conflict"
        | "write-failure"
        | "rollback-failure";
      readonly exitCode: 1 | 5;
      readonly diagnostics: readonly Diagnostic[];
    };

function terminal(
  status: TerminalFinishPlan["status"],
  exitCode: number,
  diagnostics: readonly Diagnostic[],
  repositoryRoot?: string,
  unresolved?: {
    readonly inProgress: readonly string[];
    readonly blockers: readonly string[];
  },
): TerminalFinishPlan {
  return {
    status,
    exitCode,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    ...(unresolved === undefined
      ? {}
      : {
          unresolvedInProgress: unresolved.inProgress,
          unresolvedBlockers: unresolved.blockers,
        }),
    diagnostics,
  };
}

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  suggestion?: string,
): Diagnostic {
  return { code, severity, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function defaultSummary(state: ActiveTask): string {
  return state.completed.at(-1) ?? `Completed ${state.title}.`;
}

function parseInput(input: PrepareTaskFinishInput, state: ActiveTask): CompletionInput {
  if (input.json !== undefined && input.completion !== undefined) {
    throw new CompletionInputValidationError([
      { path: "<root>", message: "Provide either JSON or a completion value, not both" },
    ]);
  }
  let value = input.completion;
  if (input.json !== undefined) {
    try {
      value = JSON.parse(input.json.replace(/^\uFEFF/u, ""));
    } catch {
      const error = new Error("Completion input is not valid JSON.");
      error.name = "CompletionJsonError";
      throw error;
    }
  }
  if (value === undefined) {
    return parseCompletionInput({ summary: defaultSummary(state) });
  }
  return parseCompletionInput(value);
}

function redactCompletion(
  input: CompletionInput,
  finishingAgent: string,
): { readonly input: CompletionInput; readonly redactionCount: number; readonly safe: boolean } {
  let redactionCount = 0;
  let safe = true;
  const text = (value: string): string => {
    const redacted = redactSecretLikeText(value);
    redactionCount += redacted.redactionCount;
    safe &&= redacted.safe;
    return redacted.value;
  };
  const redactedAgent = text(finishingAgent);
  const report = input.finalReport;
  let finalReport: CompletionInput["finalReport"];
  if (report !== undefined) {
    const redacted = redactAgentReport({ ...report, agent: redactedAgent });
    redactionCount += redacted.redactionCount;
    safe &&= redacted.safe;
    finalReport = {
      completed: redacted.value.completed,
      inProgress: redacted.value.inProgress,
      decisions: redacted.value.decisions,
      failedAttempts: redacted.value.failedAttempts,
      blockers: redacted.value.blockers,
      nextActions: redacted.value.nextActions,
      validation: redacted.value.validation,
      assumptions: redacted.value.assumptions,
    };
  }
  return {
    input: parseCompletionInput({
      agent: redactedAgent,
      summary: text(input.summary),
      ...(finalReport === undefined ? {} : { finalReport }),
      resolvedInProgress: input.resolvedInProgress.map(text),
      resolvedBlockers: input.resolvedBlockers.map(text),
      followUp: input.followUp.map(text),
    }),
    redactionCount,
    safe,
  };
}

function reportFromCompletion(input: CompletionInput): AgentReport {
  return {
    ...(input.finalReport === undefined ? {} : { agent: input.agent }),
    completed: input.finalReport?.completed ?? [],
    inProgress: input.finalReport?.inProgress ?? [],
    decisions: input.finalReport?.decisions ?? [],
    failedAttempts: input.finalReport?.failedAttempts ?? [],
    blockers: input.finalReport?.blockers ?? [],
    nextActions: input.finalReport?.nextActions ?? [],
    validation: input.finalReport?.validation ?? [],
    assumptions: input.finalReport?.assumptions ?? [],
  };
}

function resolveFinalState(
  original: ActiveTask,
  completion: CompletionInput,
  timestamp: string,
  gitFacts: { readonly branch: string; readonly commit: string | null; readonly detached: boolean },
):
  | { readonly status: "success"; readonly state: ActiveTask }
  | {
      readonly status: "unknown-resolution";
      readonly unknownInProgress: readonly string[];
      readonly unknownBlockers: readonly string[];
    } {
  const merged = mergeAgentReport(original, reportFromCompletion(completion), {
    updatedAt: timestamp,
    gitFacts,
  }).state;
  const resolvedInProgress = unique(completion.resolvedInProgress);
  const resolvedBlockers = unique(completion.resolvedBlockers);
  const unknownInProgress = resolvedInProgress.filter((item) => !merged.inProgress.includes(item));
  const unknownBlockers = resolvedBlockers.filter((item) => !merged.blockers.includes(item));
  if (unknownInProgress.length > 0 || unknownBlockers.length > 0) {
    return { status: "unknown-resolution", unknownInProgress, unknownBlockers };
  }
  const resolutionChanged = resolvedInProgress.length > 0 || resolvedBlockers.length > 0;
  const reportChanged = merged.reportRevision !== original.reportRevision;
  const semanticChanged = reportChanged || resolutionChanged;
  return {
    status: "success",
    state: activeTaskSchema.parse({
      ...merged,
      updatedAt: timestamp,
      currentBranch: gitFacts.branch,
      currentCommit: gitFacts.commit,
      ...(semanticChanged ? { lastAgent: completion.agent ?? "agentfold-cli" } : {}),
      reportRevision: original.reportRevision + (semanticChanged ? 1 : 0),
      latestReportAt: semanticChanged ? timestamp : original.latestReportAt,
      completed: unique([...merged.completed, ...resolvedInProgress]),
      inProgress: merged.inProgress.filter((item) => !resolvedInProgress.includes(item)),
      blockers: merged.blockers.filter((item) => !resolvedBlockers.includes(item)),
    }),
  };
}

async function validateManagedDirectory(
  fileSystem: FileSystem,
  repositoryRoot: string,
  directory: string,
): Promise<void> {
  const type = await fileSystem.entryType(directory);
  const boundary = type === undefined ? path.dirname(directory) : directory;
  if (type !== undefined && type !== "directory") {
    throw new AtomicFileConflictError(directory);
  }
  const [realRoot, realBoundary] = await Promise.all([
    fileSystem.realPath(repositoryRoot),
    fileSystem.realPath(boundary),
  ]);
  if (!isPathInside(realRoot, realBoundary)) {
    throw new Error("Managed completion path resolves outside the Git repository.");
  }
}

async function hasFinalCheckpoint(
  fileSystem: FileSystem,
  repositoryRoot: string,
  storageDirectory: ProjectStorageDirectory,
  taskId: string,
  entries: readonly string[],
): Promise<boolean> {
  for (const entry of entries) {
    if (checkpointSequenceFromFileName(taskId, entry) === null) continue;
    const candidate = projectStorageAbsolutePath(
      repositoryRoot,
      storageDirectory,
      `state/history/${entry}`,
    );
    const realCandidate = await fileSystem.realPath(candidate);
    const realRoot = await fileSystem.realPath(repositoryRoot);
    if (!isPathInside(realRoot, realCandidate)) {
      throw new Error("Checkpoint history file resolves outside the Git repository.");
    }
    if (parseCheckpoint(await fileSystem.readText(realCandidate), taskId).kind === "final") {
      return true;
    }
  }
  return false;
}

export async function prepareTaskFinish(
  dependencies: PrepareTaskFinishDependencies,
  input: PrepareTaskFinishInput = {},
): Promise<FinishPlan> {
  const context = await loadCanonicalContext({
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
    ...(dependencies.startDirectory === undefined
      ? {}
      : { startDirectory: dependencies.startDirectory }),
  });
  if (context.status === "error") {
    return terminal(
      "invalid-context",
      canonicalContextFailureExitCode(context),
      context.diagnostics,
      context.repositoryRoot,
    );
  }
  const repositoryRoot = context.repositoryRoot;
  const storageDirectory = context.context.storage.directory;
  const historyRelativePath = checkpointHistoryRelativePathFor(storageDirectory);
  const completedRelativePath = completedTasksRelativePathFor(storageDirectory);
  const loaded = await loadActiveState(dependencies.fileSystem, repositoryRoot, storageDirectory);
  if (loaded.status === "missing") {
    return terminal(
      "missing-state",
      5,
      [
        diagnostic(
          "AFF001",
          "error",
          "No active task exists to finish.",
          "Begin a new task for new implementation work.",
        ),
      ],
      repositoryRoot,
    );
  }
  if (loaded.status === "error") {
    return terminal("invalid-state", 2, loaded.diagnostics, repositoryRoot);
  }
  if (activeTaskContainsSecretLikeText(loaded.state)) {
    return terminal(
      "unsafe-content",
      4,
      [
        diagnostic(
          "AFF002",
          "error",
          "Secret-like content was found in active semantic state.",
          "Redact the active state before finishing; nothing was copied.",
        ),
      ],
      repositoryRoot,
    );
  }

  let completion: CompletionInput;
  let completionRedactionCount = 0;
  try {
    const parsed = parseInput(input, loaded.state);
    const finishingAgent = agentNameSchema.parse(
      parsed.agent ??
        input.agentOverride ??
        loaded.state.lastAgent ??
        loaded.state.startingAgent ??
        "agentfold-cli",
    );
    const redacted = redactCompletion(parsed, finishingAgent);
    if (!redacted.safe) throw new Error("Unsafe completion content could not be redacted.");
    completion = redacted.input;
    completionRedactionCount = redacted.redactionCount;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "CompletionJsonError") {
      return terminal(
        "invalid-json",
        2,
        [diagnostic("AFF003", "error", error.message, "Provide one JSON object through --stdin.")],
        repositoryRoot,
      );
    }
    if (error instanceof CompletionInputValidationError || error instanceof z.ZodError) {
      return terminal(
        "invalid-input",
        2,
        [
          diagnostic(
            "AFF004",
            "error",
            error.message,
            "Provide a bounded summary and concise final semantic report.",
          ),
        ],
        repositoryRoot,
      );
    }
    return terminal(
      "unsafe-content",
      4,
      [diagnostic("AFF005", "error", "Completion content could not be persisted safely.")],
      repositoryRoot,
    );
  }

  try {
    const timestamp = (dependencies.now ?? (() => new Date()))().toISOString();
    const finishingAgent = completion.agent ?? "agentfold-cli";
    const statePath = loaded.statePath;
    const originalStateSource = await dependencies.fileSystem.readText(statePath);
    const [historyEntries, gitObservation] = await Promise.all([
      listCheckpointHistoryFileNames(dependencies.fileSystem, repositoryRoot, storageDirectory),
      dependencies.gitInspector.readCheckpointFacts(repositoryRoot, {
        startingCommit: loaded.state.startingCommit,
        startedAt: loaded.state.startedAt,
      }),
    ]);
    if (
      await hasFinalCheckpoint(
        dependencies.fileSystem,
        repositoryRoot,
        storageDirectory,
        loaded.state.taskId,
        historyEntries,
      )
    ) {
      return terminal(
        "history-conflict",
        5,
        [diagnostic("AFF006", "error", "A final checkpoint already exists for the active task.")],
        repositoryRoot,
      );
    }
    const resolved = resolveFinalState(loaded.state, completion, timestamp, gitObservation.facts);
    if (resolved.status === "unknown-resolution") {
      const unknown = [...resolved.unknownInProgress, ...resolved.unknownBlockers];
      return terminal(
        "invalid-input",
        2,
        [
          diagnostic(
            "AFF007",
            "error",
            `Unknown resolution entries: ${unknown.join("; ")}`,
            "Resolution entries must exactly match current in-progress work or blockers.",
          ),
        ],
        repositoryRoot,
      );
    }
    if (resolved.state.inProgress.length > 0 || resolved.state.blockers.length > 0) {
      return terminal(
        "not-ready",
        5,
        [
          ...(resolved.state.inProgress.length === 0
            ? []
            : [
                diagnostic(
                  "AFF008",
                  "error",
                  `Unresolved in-progress work: ${resolved.state.inProgress.join("; ")}`,
                  "Complete the work or resolve exact entries explicitly.",
                ),
              ]),
          ...(resolved.state.blockers.length === 0
            ? []
            : [
                diagnostic(
                  "AFF009",
                  "error",
                  `Unresolved blockers: ${resolved.state.blockers.join("; ")}`,
                  "Resolve exact blocker entries before finishing.",
                ),
              ]),
        ],
        repositoryRoot,
        { inProgress: resolved.state.inProgress, blockers: resolved.state.blockers },
      );
    }
    const entriesForAllocation =
      loaded.state.checkpointHistory.latestCheckpointId === null
        ? historyEntries
        : [
            ...historyEntries,
            `${loaded.state.taskId}-${loaded.state.checkpointHistory.latestCheckpointId}.md`,
          ];
    const allocated = allocateCheckpointId(
      loaded.state.taskId,
      loaded.state.checkpointHistory.count,
      entriesForAllocation,
    );
    const checkpoint = assembleCheckpoint({
      activeTask: resolved.state,
      gitFacts: gitObservation.facts,
      checkpointId: allocated.checkpointId,
      createdAt: timestamp,
      checkpointAgent: finishingAgent,
      kind: "final",
    });
    const matchingHistoryCount = historyEntries.filter(
      (entry) => checkpointSequenceFromFileName(loaded.state.taskId, entry) !== null,
    ).length;
    const checkpointCount =
      Math.max(loaded.state.checkpointHistory.count, matchingHistoryCount) + 1;
    const task = completedTaskSchema.parse({
      schemaVersion: 1,
      taskId: resolved.state.taskId,
      title: resolved.state.title,
      objective: resolved.state.objective,
      status: "completed",
      startedAt: resolved.state.startedAt,
      finishedAt: timestamp,
      durationSeconds: Math.floor(
        Math.max(0, Date.parse(timestamp) - Date.parse(resolved.state.startedAt)) / 1_000,
      ),
      startingBranch: resolved.state.startingBranch,
      startingCommit: resolved.state.startingCommit,
      finalBranch: checkpoint.observedGit.currentBranch,
      finalCommit: checkpoint.observedGit.currentCommit,
      startingAgent: resolved.state.startingAgent ?? null,
      lastReportingAgent: resolved.state.lastAgent ?? null,
      finishingAgent,
      summary: completion.summary,
      completed: resolved.state.completed,
      decisions: resolved.state.decisions,
      failedAttempts: resolved.state.failedAttempts,
      validation: resolved.state.validation,
      assumptions: resolved.state.assumptions,
      finalCheckpointId: checkpoint.checkpointId,
      checkpointCount,
      semanticRevision: resolved.state.reportRevision,
      changedPaths: checkpoint.observedGit.changedPaths,
      diffStatistics: checkpoint.observedGit.diffStatistics,
      followUp: completion.followUp,
    });
    if (
      checkpointContainsSecretLikeText(checkpoint) ||
      containsSecretLikeText(JSON.stringify(task))
    ) {
      return terminal(
        "unsafe-content",
        4,
        [diagnostic("AFF010", "error", "Secret-like data was withheld from finish artifacts.")],
        repositoryRoot,
      );
    }
    const historyPath = path.join(
      repositoryRoot,
      ...historyRelativePath.split("/"),
      allocated.fileName,
    );
    const completedPath = path.join(
      repositoryRoot,
      ...completedRelativePath.split("/"),
      `${task.taskId}.md`,
    );
    await Promise.all([
      validateManagedDirectory(dependencies.fileSystem, repositoryRoot, path.dirname(historyPath)),
      validateManagedDirectory(
        dependencies.fileSystem,
        repositoryRoot,
        path.dirname(completedPath),
      ),
    ]);
    if (await dependencies.fileSystem.exists(historyPath)) {
      return terminal(
        "history-conflict",
        5,
        [diagnostic("AFF011", "error", "The final checkpoint destination already exists.")],
        repositoryRoot,
      );
    }
    if (await dependencies.fileSystem.exists(completedPath)) {
      return terminal(
        "completed-conflict",
        5,
        [diagnostic("AFF012", "error", "The completed-task record already exists.")],
        repositoryRoot,
      );
    }
    return {
      status: "ready",
      exitCode: 0,
      repositoryRoot,
      visibility: context.context.state.visibility,
      task,
      checkpoint,
      statePath,
      historyPath,
      completedPath,
      originalStateSource,
      serializedCheckpoint: serializeCheckpoint(checkpoint),
      serializedCompletedTask: serializeCompletedTask(task),
      redactionCount: completionRedactionCount,
      diagnostics: [
        ...context.diagnostics,
        ...gitObservation.diagnostics,
        diagnostic("AFF013", "success", `Task ready to finish: ${task.taskId} — ${task.title}`),
        ...(task.validation.some((item) => item.status === "failed")
          ? [
              diagnostic(
                "AFF014",
                "warning",
                "The completed record honestly retains failed validation results.",
              ),
            ]
          : []),
      ],
    };
  } catch (error: unknown) {
    if (error instanceof CheckpointSequenceExhaustedError) {
      return terminal(
        "history-conflict",
        5,
        [diagnostic("AFF015", "error", "The checkpoint sequence has reached CP-999.")],
        repositoryRoot,
      );
    }
    if (error instanceof AtomicFileConflictError) {
      return terminal(
        "history-conflict",
        5,
        [diagnostic("AFF016", "error", "A finish storage path conflicts with an existing file.")],
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
        diagnostic(
          gitError ? "AFF017" : "AFF018",
          "error",
          gitError
            ? "Final Git facts could not be captured safely."
            : "Task finish preparation failed before files were written.",
          "The active task and checkpoint history were not modified.",
        ),
      ],
      repositoryRoot,
    );
  }
}

async function safeRollback(
  fileSystem: FileSystem,
  artifacts: readonly { readonly path: string; readonly content: string }[],
): Promise<boolean> {
  let safe = true;
  for (const artifact of [...artifacts].reverse()) {
    try {
      if (!(await fileSystem.exists(artifact.path))) continue;
      if ((await fileSystem.readText(artifact.path)) !== artifact.content) {
        safe = false;
        continue;
      }
      await fileSystem.remove(artifact.path);
    } catch {
      safe = false;
    }
  }
  return safe;
}

export async function commitTaskFinish(
  plan: ReadyFinishPlan,
  fileSystem: FileSystem,
  writer: AtomicTextFileWriter,
): Promise<FinishCommitResult> {
  try {
    await Promise.all([
      validateManagedDirectory(fileSystem, plan.repositoryRoot, path.dirname(plan.historyPath)),
      validateManagedDirectory(fileSystem, plan.repositoryRoot, path.dirname(plan.completedPath)),
    ]);
    if ((await fileSystem.readText(plan.statePath)) !== plan.originalStateSource) {
      return {
        status: "state-changed",
        exitCode: 5,
        diagnostics: [
          ...plan.diagnostics,
          diagnostic(
            "AFF019",
            "error",
            "Active task state changed after finish preparation.",
            "Review the newer state and retry; nothing was written.",
          ),
        ],
      };
    }
    if (await fileSystem.exists(plan.historyPath)) {
      return {
        status: "history-conflict",
        exitCode: 5,
        diagnostics: [
          ...plan.diagnostics,
          diagnostic("AFF011", "error", "The final checkpoint destination appeared before commit."),
        ],
      };
    }
    if (await fileSystem.exists(plan.completedPath)) {
      return {
        status: "completed-conflict",
        exitCode: 5,
        diagnostics: [
          ...plan.diagnostics,
          diagnostic("AFF012", "error", "The completed-task record appeared before commit."),
        ],
      };
    }
  } catch {
    return {
      status: "write-failure",
      exitCode: 1,
      diagnostics: [
        ...plan.diagnostics,
        diagnostic("AFF020", "error", "Finish state could not be revalidated before mutation."),
      ],
    };
  }

  const created: { path: string; content: string }[] = [];
  try {
    await writer.write(plan.historyPath, plan.serializedCheckpoint, "create");
    created.push({ path: plan.historyPath, content: plan.serializedCheckpoint });
    await writer.write(plan.completedPath, plan.serializedCompletedTask, "create");
    created.push({ path: plan.completedPath, content: plan.serializedCompletedTask });
    if ((await fileSystem.readText(plan.statePath)) !== plan.originalStateSource) {
      throw new Error("Active task changed before removal.");
    }
    await fileSystem.remove(plan.statePath);
  } catch (error: unknown) {
    const rolledBack = await safeRollback(fileSystem, created);
    if (!rolledBack) {
      return {
        status: "rollback-failure",
        exitCode: 1,
        diagnostics: [
          ...plan.diagnostics,
          diagnostic(
            "AFF021",
            "error",
            "Task finish failed and newly created artifact rollback was incomplete.",
            "Inspect only the reported final checkpoint and completed-task paths; do not remove prior history.",
          ),
        ],
      };
    }
    const conflict = error instanceof AtomicFileConflictError;
    return {
      status: conflict ? "history-conflict" : "write-failure",
      exitCode: conflict ? 5 : 1,
      diagnostics: [
        ...plan.diagnostics,
        diagnostic(
          "AFF022",
          "error",
          "Task finish did not complete; newly created finish artifacts were rolled back.",
          `The active task remains at ${portablePath(path.relative(plan.repositoryRoot, plan.statePath))}.`,
        ),
      ],
    };
  }

  return {
    status: "success",
    exitCode: 0,
    diagnostics: [
      ...plan.diagnostics,
      diagnostic(
        "AFF023",
        "success",
        `Created ${portablePath(path.relative(plan.repositoryRoot, plan.historyPath))}`,
      ),
      diagnostic(
        "AFF024",
        "success",
        `Created ${portablePath(path.relative(plan.repositoryRoot, plan.completedPath))}`,
      ),
      diagnostic(
        "AFF025",
        "success",
        `Removed ${portablePath(path.relative(plan.repositoryRoot, plan.statePath))}`,
      ),
    ],
  };
}
