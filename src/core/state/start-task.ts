import path from "node:path";

import { loadCanonicalContext } from "../context/load-context.js";
import { isPathInside } from "../context/path-boundary.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { AtomicTextFileWriter } from "../filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../filesystem/filesystem.js";
import type { GitInspector, GitWorkingFacts } from "../git/git-inspector.js";
import type { GitRepositoryLocator } from "../git/git-repository-locator.js";
import { portablePath } from "../initialization/paths.js";
import {
  projectStorageAbsolutePath,
  type ProjectStorageDirectory,
} from "../storage/project-storage.js";
import { activeTaskSchema } from "./active-state-schema.js";
import { canonicalContextFailureExitCode } from "./context-requirement.js";
import { activeStateDirectoryRelativePathFor, loadActiveState } from "./load-active-state.js";
import { serializeActiveState } from "./serialize-active-state.js";
import { generateTaskId } from "./task-id.js";
import type { ActiveTask } from "./types.js";
import { agentNameSchema, objectiveSchema, taskTitleSchema } from "./value-schemas.js";

interface BaseTaskStartPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
  readonly repositoryRoot?: string;
}

export interface ReadyTaskStartPlan extends BaseTaskStartPlan {
  readonly status: "ready";
  readonly exitCode: 0;
  readonly repositoryRoot: string;
  readonly statePath: string;
  readonly visibility: "local" | "tracked";
  readonly state: ActiveTask;
  readonly serializedState: string;
  readonly gitFacts: GitWorkingFacts;
}

export interface TerminalTaskStartPlan extends BaseTaskStartPlan {
  readonly status:
    | "invalid-title"
    | "invalid-objective"
    | "invalid-agent"
    | "invalid-context"
    | "invalid-state"
    | "conflict"
    | "git-error"
    | "filesystem-error";
}

export type TaskStartPlan = ReadyTaskStartPlan | TerminalTaskStartPlan;

export interface PrepareTaskStartDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now?: () => Date;
  readonly startDirectory?: string;
}

export interface PrepareTaskStartInput {
  readonly title: string;
  readonly objective?: string;
  readonly agent?: string;
}

function terminal(
  status: TerminalTaskStartPlan["status"],
  exitCode: number,
  diagnostics: readonly Diagnostic[],
  repositoryRoot?: string,
): TerminalTaskStartPlan {
  return {
    status,
    exitCode,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    diagnostics,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function existingHistoryTaskIds(
  fileSystem: FileSystem,
  repositoryRoot: string,
  storageDirectory: ProjectStorageDirectory,
): Promise<readonly string[]> {
  const taskIds: string[] = [];
  for (const leaf of ["history", "completed"] as const) {
    const directory = projectStorageAbsolutePath(repositoryRoot, storageDirectory, `state/${leaf}`);
    if ((await fileSystem.entryType(directory)) !== "directory") continue;
    const [realRoot, realDirectory] = await Promise.all([
      fileSystem.realPath(repositoryRoot),
      fileSystem.realPath(directory),
    ]);
    if (!isPathInside(realRoot, realDirectory)) {
      throw new Error(`The ${leaf} state directory resolves outside the Git repository.`);
    }
    taskIds.push(
      ...(await fileSystem.listDirectory(realDirectory))
        .map((entry) => entry.match(/AF-\d{8}-\d{3}/u)?.[0])
        .filter((taskId): taskId is string => taskId !== undefined),
    );
  }
  return [...new Set(taskIds)];
}

function repositoryWorkingContext(repositoryRoot: string, workingDirectory: string): string {
  if (!isPathInside(repositoryRoot, workingDirectory)) {
    throw new Error("The working directory is outside the resolved Git repository.");
  }

  const relative = path.relative(repositoryRoot, workingDirectory);
  return relative.length === 0 ? "." : portablePath(relative);
}

export async function prepareTaskStart(
  dependencies: PrepareTaskStartDependencies,
  input: PrepareTaskStartInput,
): Promise<TaskStartPlan> {
  const titleResult = taskTitleSchema.safeParse(input.title);
  if (!titleResult.success) {
    return terminal("invalid-title", 2, [
      {
        code: "AFS001",
        severity: "error",
        message: "Task title must contain 1 to 200 characters after trimming.",
        suggestion: "Provide a concise task objective as the positional argument.",
      },
    ]);
  }

  const agentResult =
    input.agent === undefined ? undefined : agentNameSchema.safeParse(input.agent);
  if (agentResult !== undefined && !agentResult.success) {
    return terminal("invalid-agent", 2, [
      {
        code: "AFS002",
        severity: "error",
        message: "Starting agent must contain 1 to 100 characters after trimming.",
      },
    ]);
  }

  const objectiveResult = objectiveSchema.safeParse(input.objective ?? titleResult.data);
  if (!objectiveResult.success) {
    return terminal("invalid-objective", 2, [
      {
        code: "AFS010",
        severity: "error",
        message: "Task objective must contain 1 to 4,000 characters after trimming.",
        suggestion: "Provide a concise engineering objective without transcripts or secrets.",
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
  const storageDirectory = contextResult.context.storage.directory;
  const stateDirectoryRelativePath = activeStateDirectoryRelativePathFor(storageDirectory);
  const loadedState = await loadActiveState(
    dependencies.fileSystem,
    repositoryRoot,
    storageDirectory,
  );
  if (loadedState.status === "success") {
    return terminal(
      "conflict",
      5,
      [
        {
          code: "AFS003",
          severity: "error",
          message: `Active task ${loadedState.state.taskId} already exists.`,
          suggestion:
            "Use the future resume or finish workflow; start never overwrites active state.",
        },
      ],
      repositoryRoot,
    );
  }

  if (loadedState.status === "error") {
    return terminal("invalid-state", 2, loadedState.diagnostics, repositoryRoot);
  }

  try {
    const now = (dependencies.now ?? (() => new Date()))();
    const [gitFacts, historyTaskIds] = await Promise.all([
      dependencies.gitInspector.readWorkingFacts(repositoryRoot),
      existingHistoryTaskIds(dependencies.fileSystem, repositoryRoot, storageDirectory),
    ]);
    const workingDirectory =
      dependencies.startDirectory ?? dependencies.fileSystem.currentWorkingDirectory();
    const taskId = generateTaskId(now, historyTaskIds);
    const agent = agentResult?.success === true ? agentResult.data : undefined;
    const timestamp = now.toISOString();
    const state = activeTaskSchema.parse({
      schemaVersion: 1,
      taskId,
      title: titleResult.data,
      status: "active",
      startedAt: timestamp,
      updatedAt: timestamp,
      workingContext: repositoryWorkingContext(repositoryRoot, workingDirectory),
      startingBranch: gitFacts.branch,
      currentBranch: gitFacts.branch,
      startingCommit: gitFacts.commit,
      currentCommit: gitFacts.commit,
      ...(agent === undefined ? {} : { startingAgent: agent, lastAgent: agent }),
      reportRevision: 0,
      latestReportAt: null,
      objective: objectiveResult.data,
      completed: [],
      inProgress: [],
      decisions: [],
      failedAttempts: [],
      blockers: [],
      nextActions: [],
      validation: [],
      assumptions: [],
      checkpointHistory: {
        count: 0,
        latestCheckpointAt: null,
        latestCheckpointId: null,
        latestFingerprint: null,
        latestSemanticRevision: 0,
      },
    });
    const diagnostics: Diagnostic[] = [
      ...contextResult.diagnostics,
      {
        code: "AFS004",
        severity: "success",
        message: `Task prepared: ${taskId}`,
      },
    ];

    if (
      contextResult.context.state.visibility === "local" &&
      !(await dependencies.gitInspector.isPathIgnored(repositoryRoot, stateDirectoryRelativePath))
    ) {
      diagnostics.push({
        code: "AFS005",
        severity: "warning",
        message: "Local active state is not ignored by Git.",
        suggestion: `Add only ${stateDirectoryRelativePath} to .gitignore; BriefOnce did not edit it.`,
      });
    }

    return {
      status: "ready",
      exitCode: 0,
      repositoryRoot,
      statePath: projectStorageAbsolutePath(repositoryRoot, storageDirectory, "state/current.md"),
      visibility: contextResult.context.state.visibility,
      state,
      serializedState: serializeActiveState(state),
      gitFacts,
      diagnostics,
    };
  } catch (error: unknown) {
    const gitError = error instanceof Error && error.name === "GitInspectionError";
    return terminal(
      gitError ? "git-error" : "filesystem-error",
      gitError ? 6 : 1,
      [
        {
          code: gitError ? "AFS006" : "AFS008",
          severity: "error",
          message: gitError
            ? "Could not capture the current Git branch and commit."
            : `Could not prepare active task state: ${errorMessage(error)}`,
          suggestion: "No task state was written.",
        },
      ],
      repositoryRoot,
    );
  }
}

export async function commitTaskStart(
  plan: ReadyTaskStartPlan,
  writer: AtomicTextFileWriter,
): Promise<readonly Diagnostic[]> {
  await writer.write(plan.statePath, plan.serializedState, "create");

  return [
    ...plan.diagnostics,
    {
      code: "AFS007",
      severity: "success",
      message: `Created ${portablePath(path.relative(plan.repositoryRoot, plan.statePath))}`,
    },
  ];
}
