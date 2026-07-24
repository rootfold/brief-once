import type { ReliabilityEvent, ReliabilityHost, SemanticFreshness } from "./event-schema.js";
import {
  reliabilityReportSchema,
  type ReliabilityEventSummary,
  type ReliabilityHostSummary,
  type ReliabilityQuality,
  type ReliabilityReport,
  type ReliabilityWarning,
} from "./report-schema.js";

export interface ReliabilityTaskSummary {
  readonly taskId: string;
  readonly title: string;
}

export interface ReliabilityCompletedTaskSummary extends ReliabilityTaskSummary {
  readonly finishedAt: string;
  readonly finalCheckpointId: string;
}

export interface AnalyzeReliabilityInput {
  readonly repositoryId: string;
  readonly generatedAt: string;
  readonly events: readonly ReliabilityEvent[];
  readonly currentTask?: ReliabilityTaskSummary;
  readonly latestCompletedTask?: ReliabilityCompletedTaskSummary;
  readonly pendingSessionIds?: readonly string[];
  readonly serviceAvailability?: "running" | "stopped" | "unknown";
  readonly includeEvents?: boolean;
  readonly limit?: number;
}

interface SessionEvents {
  readonly sessionId: string;
  readonly events: readonly ReliabilityEvent[];
}

function warning(
  code: string,
  message: string,
  event: ReliabilityEvent,
  severity: ReliabilityWarning["severity"] = "warning",
): ReliabilityWarning {
  return {
    code,
    severity,
    message,
    ...(event.host === undefined ? {} : { host: event.host }),
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
  } as ReliabilityWarning;
}

function groupedSessions(events: readonly ReliabilityEvent[]): readonly SessionEvents[] {
  const grouped = new Map<string, ReliabilityEvent[]>();
  for (const event of events) {
    if (event.sessionId === undefined) continue;
    const current = grouped.get(event.sessionId) ?? [];
    current.push(event);
    grouped.set(event.sessionId, current);
  }
  return [...grouped.entries()].map(([sessionId, sessionEvents]) => ({
    sessionId,
    events: sessionEvents.sort((left, right) => left.sequence - right.sequence),
  }));
}

function hostSummary(
  host: ReliabilityHost,
  events: readonly ReliabilityEvent[],
): ReliabilityHostSummary {
  const hostEvents = events.filter((event) => (event.host ?? "unknown") === host);
  const count = (type: ReliabilityEvent["eventType"]): number =>
    hostEvents.filter((event) => event.eventType === type).length;
  const observedSessions = count("session_opened");
  const normalClosures = count("session_closed");
  const finishedTasks = count("task_finished");
  const completedSessions = new Set(
    hostEvents
      .filter(
        (event) => event.eventType === "session_closed" || event.eventType === "task_finished",
      )
      .map((event) => event.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== undefined),
  ).size;
  return {
    host,
    observedSessions,
    normalClosures,
    finishedTasks,
    detachedSessions: count("session_detached"),
    timedOutSessions: count("session_timed_out"),
    interruptedSessions: count("session_interrupted"),
    progressReports: count("progress_report_submitted"),
    checkpoints: count("checkpoint_created"),
    recoveryCheckpoints: count("recovery_checkpoint_created"),
    failedRecoveries: count("recovery_checkpoint_failed"),
    observedLifecycleCompletionPercent:
      observedSessions === 0 ? null : Math.round((completedSessions / observedSessions) * 100),
  };
}

function latestFreshness(events: readonly ReliabilityEvent[]): SemanticFreshness | "unknown" {
  return (
    [...events].reverse().find((event) => event.semanticFreshness !== undefined)
      ?.semanticFreshness ?? "unknown"
  );
}

function analyzeWarnings(
  events: readonly ReliabilityEvent[],
  pendingSessionIds: ReadonlySet<string>,
): readonly ReliabilityWarning[] {
  const warnings: ReliabilityWarning[] = [];
  for (const session of groupedSessions(events)) {
    const first = session.events[0];
    if (first === undefined) continue;
    const types = new Set(session.events.map((event) => event.eventType));
    const durationSeconds = Math.max(
      0,
      Math.floor(
        (Date.parse(session.events.at(-1)?.occurredAt ?? first.occurredAt) -
          Date.parse(first.occurredAt)) /
          1_000,
      ),
    );
    const hasTaskActivity = session.events.some((event) =>
      [
        "task_started",
        "task_continued",
        "progress_report_submitted",
        "checkpoint_created",
        "task_finished",
      ].includes(event.eventType),
    );
    const ended = session.events.some((event) =>
      [
        "session_closed",
        "session_detached",
        "session_timed_out",
        "session_interrupted",
        "session_superseded",
      ].includes(event.eventType),
    );
    if (types.has("session_opened") && ended && !hasTaskActivity && durationSeconds >= 60) {
      warnings.push(
        warning(
          "AFRELW001",
          "This observed session opened but recorded no task activity.",
          first,
          "info",
        ),
      );
    }
    const durableActivity = types.has("checkpoint_created") || types.has("task_finished");
    if (durableActivity && !types.has("progress_report_submitted")) {
      warnings.push(
        warning(
          "AFRELW002",
          "This observed session recorded task activity without a semantic progress report.",
          first,
        ),
      );
    }
    if (
      types.has("session_detached") ||
      types.has("session_timed_out") ||
      types.has("session_interrupted")
    ) {
      warnings.push(
        warning("AFRELW003", "This observed session disappeared without a normal close.", first),
      );
    }
    if (
      durableActivity &&
      !types.has("progress_report_submitted") &&
      !types.has("session_closed")
    ) {
      warnings.push(
        warning(
          "AFRELW009",
          "This observed session did not complete the recommended BriefOnce lifecycle.",
          first,
        ),
      );
    }
  }

  const lastRecovery = [...events]
    .reverse()
    .find((event) => event.eventType === "recovery_checkpoint_created");
  if (lastRecovery !== undefined) {
    warnings.push(
      warning(
        "AFRELW004",
        "The latest durable continuity may depend on an interruption-recovery checkpoint.",
        lastRecovery,
      ),
    );
  }
  const lastFreshnessEvent = [...events]
    .reverse()
    .find((event) => event.semanticFreshness !== undefined);
  if (lastFreshnessEvent?.semanticFreshness === "reused") {
    warnings.push(
      warning(
        "AFRELW005",
        "The latest checkpoint reused earlier semantic context.",
        lastFreshnessEvent,
      ),
    );
  }
  if (lastFreshnessEvent?.semanticFreshness === "absent") {
    warnings.push(
      warning(
        "AFRELW006",
        "The latest checkpoint has no semantic progress context.",
        lastFreshnessEvent,
      ),
    );
  }
  for (const event of events.filter(
    (candidate) =>
      candidate.eventType === "task_finished" &&
      (candidate.safeMetadata?.validationPassedCount ?? 0) === 0,
  )) {
    warnings.push(
      warning("AFRELW007", "The task finished without a recorded successful validation.", event),
    );
  }
  for (const sessionId of pendingSessionIds) {
    const event =
      [...events].reverse().find((candidate) => candidate.sessionId === sessionId) ?? events.at(-1);
    if (event !== undefined) {
      warnings.push(
        warning(
          "AFRELW008",
          "Interrupted-session recovery remains pending after a failed attempt.",
          event,
          "error",
        ),
      );
    }
  }
  return warnings;
}

function quality(
  events: readonly ReliabilityEvent[],
  warnings: readonly ReliabilityWarning[],
  freshness: SemanticFreshness | "unknown",
  pendingCount: number,
): { readonly value: ReliabilityQuality; readonly reasons: readonly string[] } {
  if (events.length === 0) return { value: "unknown", reasons: ["NO_OBSERVED_ACTIVITY"] };
  const types = new Set(events.map((event) => event.eventType));
  const hasCheckpoint =
    types.has("checkpoint_created") ||
    types.has("recovery_checkpoint_created") ||
    events.some((event) => event.eventType === "task_finished" && event.checkpointId !== undefined);
  if (
    pendingCount > 0 ||
    types.has("recovery_checkpoint_failed") ||
    warnings.some((item) => item.severity === "error") ||
    (freshness === "absent" && !hasCheckpoint)
  ) {
    return {
      value: "poor",
      reasons: [
        ...(pendingCount > 0 ? ["RECOVERY_PENDING"] : []),
        ...(types.has("recovery_checkpoint_failed") ? ["RECOVERY_FAILED"] : []),
        ...(!hasCheckpoint ? ["NO_USABLE_CHECKPOINT"] : []),
        ...(freshness === "absent" ? ["SEMANTIC_STATE_ABSENT"] : []),
      ],
    };
  }
  if (
    types.has("session_interrupted") ||
    types.has("session_timed_out") ||
    types.has("recovery_checkpoint_created") ||
    freshness === "reused" ||
    freshness === "absent"
  ) {
    return {
      value: "degraded",
      reasons: [
        ...(types.has("session_interrupted") ? ["SESSION_INTERRUPTED"] : []),
        ...(types.has("session_timed_out") ? ["SESSION_TIMED_OUT"] : []),
        ...(types.has("recovery_checkpoint_created") ? ["RECOVERY_USED"] : []),
        ...(freshness === "reused" ? ["SEMANTIC_STATE_REUSED"] : []),
        ...(freshness === "absent" ? ["SEMANTIC_STATE_ABSENT"] : []),
      ],
    };
  }
  const normalCompletion = types.has("session_closed") || types.has("task_finished");
  if (
    normalCompletion &&
    freshness === "current" &&
    hasCheckpoint &&
    types.has("progress_report_submitted")
  ) {
    return {
      value: "excellent",
      reasons: ["NORMAL_COMPLETION", "FRESH_SEMANTICS", "USABLE_CHECKPOINT"],
    };
  }
  if (hasCheckpoint || normalCompletion) {
    return {
      value: "good",
      reasons: [
        ...(normalCompletion ? ["NORMAL_COMPLETION"] : []),
        ...(hasCheckpoint ? ["USABLE_CHECKPOINT"] : []),
        ...(freshness === "current" ? ["FRESH_SEMANTICS"] : []),
      ],
    };
  }
  return { value: "degraded", reasons: ["INCOMPLETE_CONTINUITY"] };
}

function safeEventSummary(event: ReliabilityEvent): ReliabilityEventSummary {
  return {
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    eventType: event.eventType,
    outcome: event.outcome,
    ...(event.host === undefined ? {} : { host: event.host }),
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.checkpointId === undefined ? {} : { checkpointId: event.checkpointId }),
    ...(event.semanticFreshness === undefined
      ? {}
      : { semanticFreshness: event.semanticFreshness }),
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
  };
}

export function analyzeReliability(input: AnalyzeReliabilityInput): ReliabilityReport {
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const hosts = [...new Set(events.map((event) => event.host ?? "unknown"))]
    .sort()
    .map((host) => hostSummary(host, events));
  const pendingSessionIds = new Set(input.pendingSessionIds ?? []);
  const freshness = latestFreshness(events);
  const warnings = analyzeWarnings(events, pendingSessionIds);
  const rating = quality(events, warnings, freshness, pendingSessionIds.size);
  const totals = {
    observedSessions: hosts.reduce((sum, host) => sum + host.observedSessions, 0),
    normalClosures: hosts.reduce((sum, host) => sum + host.normalClosures, 0),
    finishedTasks: hosts.reduce((sum, host) => sum + host.finishedTasks, 0),
    detachedSessions: hosts.reduce((sum, host) => sum + host.detachedSessions, 0),
    timedOutSessions: hosts.reduce((sum, host) => sum + host.timedOutSessions, 0),
    interruptedSessions: hosts.reduce((sum, host) => sum + host.interruptedSessions, 0),
    recoveryCheckpoints: hosts.reduce((sum, host) => sum + host.recoveryCheckpoints, 0),
    failedRecoveries: hosts.reduce((sum, host) => sum + host.failedRecoveries, 0),
    reportsSubmitted: hosts.reduce((sum, host) => sum + host.progressReports, 0),
    recoveryPendingSessions: pendingSessionIds.size,
  };
  const limitedEvents = input.includeEvents
    ? events.slice(-Math.max(1, input.limit ?? 50)).map(safeEventSummary)
    : undefined;
  return reliabilityReportSchema.parse({
    schemaVersion: 1,
    repositoryId: input.repositoryId,
    generatedAt: input.generatedAt,
    ...(input.currentTask === undefined ? {} : { currentTask: input.currentTask }),
    ...(input.latestCompletedTask === undefined
      ? {}
      : { latestCompletedTask: input.latestCompletedTask }),
    hosts,
    continuityQuality: rating.value,
    qualityReasonCodes: rating.reasons,
    semanticFreshness: freshness,
    serviceAvailability: input.serviceAvailability ?? "unknown",
    warnings,
    totals,
    ...(limitedEvents === undefined ? {} : { events: limitedEvents }),
  });
}
