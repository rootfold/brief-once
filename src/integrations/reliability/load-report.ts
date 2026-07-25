import { loadCanonicalContext } from "../../core/context/load-context.js";
import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { loadLatestCompletedTask } from "../../core/completion/load-completed-task.js";
import { canonicalRepositoryId } from "../../core/reliability/repository-identity.js";
import {
  analyzeReliability,
  type ReliabilityTaskSummary,
} from "../../core/reliability/analyze-reliability.js";
import type { ReliabilityEvent, ReliabilityHost } from "../../core/reliability/event-schema.js";
import type { ReliabilityReport } from "../../core/reliability/report-schema.js";
import { loadActiveState } from "../../core/state/load-active-state.js";
import type { ServicePlatformInput } from "../service/runtime-directory.js";
import { PersistentReliabilityEventStore } from "./event-store.js";
import { PersistentSessionJournalStore } from "./session-journal-store.js";
import { inspectReliabilityStateDirectory } from "./state-directory.js";

export interface LoadReliabilityReportInput {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly startDirectory?: string;
  readonly stateDirectory?: string;
  readonly platform?: ServicePlatformInput;
  readonly now?: () => Date;
  readonly host?: ReliabilityHost;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly limit?: number;
  readonly includeEvents?: boolean;
  readonly serviceAvailability?: "running" | "stopped" | "unknown";
}

export type LoadReliabilityReportResult =
  | {
      readonly status: "success";
      readonly report: ReliabilityReport;
      readonly diagnostics: readonly Diagnostic[];
      readonly exitCode: 0;
    }
  | {
      readonly status: "error";
      readonly diagnostics: readonly Diagnostic[];
      readonly exitCode: 1 | 2 | 6;
    };

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  suggestion?: string,
): Diagnostic {
  return { code, severity, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

export async function loadReliabilityReport(
  input: LoadReliabilityReportInput,
): Promise<LoadReliabilityReportResult> {
  let startDirectory: string;
  try {
    startDirectory = input.startDirectory ?? input.fileSystem.currentWorkingDirectory();
  } catch {
    return {
      status: "error",
      exitCode: 1,
      diagnostics: [
        diagnostic("AFREL003", "error", "The working directory could not be inspected."),
      ],
    };
  }
  const locatedRoot = await input.gitRepositoryLocator
    .findRoot(startDirectory)
    .catch(() => undefined);
  if (locatedRoot === undefined) {
    return {
      status: "error",
      exitCode: 6,
      diagnostics: [
        diagnostic(
          "AFREL014",
          "error",
          "Reliability inspection requires a Git repository.",
          "Run the command from inside an initialized BriefOnce repository.",
        ),
      ],
    };
  }
  const canonical = await loadCanonicalContext({
    fileSystem: input.fileSystem,
    gitRepositoryLocator: input.gitRepositoryLocator,
    startDirectory: locatedRoot,
  });
  if (canonical.status === "error") {
    return { status: "error", exitCode: 2, diagnostics: canonical.diagnostics };
  }
  const canonicalRoot = await input.fileSystem.realPath(canonical.repositoryRoot);
  const repositoryId = canonicalRepositoryId(
    canonicalRoot,
    input.platform?.platform ?? process.platform,
  );
  let events: ReliabilityEvent[] = [];
  let pendingSessionIds: string[] = [];
  const diagnostics: Diagnostic[] = [];
  if (!canonical.context.reliability.enabled) {
    diagnostics.push(
      diagnostic("AFREL002", "info", "Reliability event persistence is disabled by configuration."),
    );
  }
  if (input.serviceAvailability === "stopped") {
    diagnostics.push(
      diagnostic(
        "AFREL018",
        "info",
        "The shared service is unavailable; persisted reliability history was inspected read-only.",
      ),
    );
  }
  try {
    const state = await inspectReliabilityStateDirectory({
      fileSystem: input.fileSystem,
      gitRepositoryLocator: input.gitRepositoryLocator,
      ...(input.stateDirectory === undefined ? {} : { stateDirectory: input.stateDirectory }),
      ...(input.platform === undefined ? {} : { platform: input.platform }),
    });
    if (state.status === "available") {
      const eventStore = new PersistentReliabilityEventStore({
        fileSystem: input.fileSystem,
        stateDirectory: state.directory,
        repositoryId,
        maximumEvents: canonical.context.reliability.maximumEventsPerRepository,
      });
      events = [...((await eventStore.read())?.events ?? [])];
      const journal = await new PersistentSessionJournalStore({
        fileSystem: input.fileSystem,
        stateDirectory: state.directory,
      }).read();
      pendingSessionIds =
        journal?.sessions
          .filter(
            (session) =>
              session.repositoryId === repositoryId &&
              (session.state === "interrupted" || session.state === "recovery_pending") &&
              (input.host === undefined || session.host === input.host) &&
              (input.taskId === undefined || session.taskId === input.taskId),
          )
          .map((session) => session.sessionId) ?? [];
    }
  } catch {
    return {
      status: "error",
      exitCode: 2,
      diagnostics: [
        diagnostic(
          "AFREL004",
          "error",
          "Private reliability state is corrupt or unsafe.",
          "Review the user-scoped AgentFold compatibility state directory; no repository files were changed.",
        ),
      ],
    };
  }

  if (input.taskId !== undefined) {
    const matchingSessions = new Set(
      events
        .filter((event) => event.taskId === input.taskId && event.sessionId !== undefined)
        .map((event) => event.sessionId as string),
    );
    events = events.filter(
      (event) =>
        event.taskId === input.taskId ||
        (event.sessionId !== undefined && matchingSessions.has(event.sessionId)),
    );
  }
  if (input.sessionId !== undefined) {
    events = events.filter((event) => event.sessionId === input.sessionId);
    pendingSessionIds = pendingSessionIds.filter((sessionId) => sessionId === input.sessionId);
  }
  if (input.host !== undefined) {
    events = events.filter((event) => (event.host ?? "unknown") === input.host);
  }
  events = events.slice(-Math.max(1, input.limit ?? 100));

  const storageDirectory = canonical.context.storage.directory;
  const active = await loadActiveState(
    input.fileSystem,
    canonical.repositoryRoot,
    storageDirectory,
  );
  if (active.status === "error") {
    return { status: "error", exitCode: 2, diagnostics: active.diagnostics };
  }
  const currentTask: ReliabilityTaskSummary | undefined =
    active.status === "success" &&
    (input.taskId === undefined || active.state.taskId === input.taskId)
      ? { taskId: active.state.taskId, title: active.state.title }
      : undefined;
  const completed = await loadLatestCompletedTask(
    input.fileSystem,
    canonical.repositoryRoot,
    storageDirectory,
  );
  if (completed.status === "error") {
    return { status: "error", exitCode: 2, diagnostics: completed.diagnostics };
  }
  const latestCompletedTask =
    completed.status === "success" &&
    (input.taskId === undefined || completed.task.taskId === input.taskId)
      ? {
          taskId: completed.task.taskId,
          title: completed.task.title,
          finishedAt: completed.task.finishedAt,
          finalCheckpointId: completed.task.finalCheckpointId,
        }
      : undefined;
  if (events.length === 0) {
    diagnostics.push(
      diagnostic(
        input.taskId !== undefined || input.sessionId !== undefined ? "AFREL017" : "AFREL015",
        "info",
        input.host !== undefined || input.taskId !== undefined || input.sessionId !== undefined
          ? "No matching BriefOnce lifecycle activity was found."
          : "No BriefOnce lifecycle activity has been recorded for this repository.",
      ),
    );
  }
  return {
    status: "success",
    exitCode: 0,
    report: analyzeReliability({
      repositoryId,
      generatedAt: (input.now ?? (() => new Date()))().toISOString(),
      events,
      ...(currentTask === undefined ? {} : { currentTask }),
      ...(latestCompletedTask === undefined ? {} : { latestCompletedTask }),
      pendingSessionIds,
      serviceAvailability: input.serviceAvailability ?? "unknown",
      includeEvents: input.includeEvents ?? false,
      limit: input.limit ?? 100,
    }),
    diagnostics,
  };
}
