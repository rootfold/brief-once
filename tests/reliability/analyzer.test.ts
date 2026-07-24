import { describe, expect, it } from "vitest";

import { analyzeReliability } from "../../src/core/reliability/analyze-reliability.js";
import {
  reliabilityEventSchema,
  type ReliabilityEvent,
  type ReliabilityEventType,
} from "../../src/core/reliability/event-schema.js";

const repositoryId = "0123456789abcdef01234567";

function events(
  types: readonly ReliabilityEventType[],
  overrides: Partial<ReliabilityEvent> = {},
): ReliabilityEvent[] {
  return types.map((eventType, index) =>
    reliabilityEventSchema.parse({
      schemaVersion: 1,
      eventId: `event-${index + 1}`,
      sequence: index + 1,
      occurredAt: new Date(Date.UTC(2026, 6, 24, 10, index)).toISOString(),
      repositoryId,
      eventType,
      host: "codex",
      client: "codex-desktop",
      agent: "codex",
      sessionId: "session-1",
      taskId: "AF-20260724-001",
      outcome: eventType === "recovery_checkpoint_failed" ? "failure" : "success",
      ...overrides,
    }),
  );
}

describe("deterministic reliability analysis", () => {
  it("returns unknown when AgentFold observed no lifecycle activity", () => {
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T10:00:00.000Z",
      events: [],
    });
    expect(report.continuityQuality).toBe("unknown");
    expect(report.qualityReasonCodes).toEqual(["NO_OBSERVED_ACTIVITY"]);
    expect(report.totals.observedSessions).toBe(0);
  });

  it("rates a fresh reported checkpoint and normal finish as excellent", () => {
    const input = events([
      "session_opened",
      "task_continued",
      "progress_report_submitted",
      "checkpoint_created",
      "task_finished",
      "session_closed",
    ]).map((event) =>
      event.eventType === "checkpoint_created"
        ? { ...event, checkpointId: "CP-001", semanticFreshness: "current" as const }
        : event.eventType === "task_finished"
          ? {
              ...event,
              checkpointId: "CP-002",
              safeMetadata: { validationPassedCount: 1 },
            }
          : event,
    );
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T11:00:00.000Z",
      events: input,
    });
    expect(report.continuityQuality).toBe("excellent");
    expect(report.semanticFreshness).toBe("current");
    expect(report.hosts[0]?.observedLifecycleCompletionPercent).toBe(100);
    expect(report.warnings).toEqual([]);
  });

  it("rates interruption recovery and reused semantics as degraded", () => {
    const input = events([
      "session_opened",
      "task_continued",
      "session_interrupted",
      "recovery_checkpoint_created",
    ]).map((event) =>
      event.eventType === "recovery_checkpoint_created"
        ? { ...event, checkpointId: "CP-014", semanticFreshness: "reused" as const }
        : event,
    );
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T11:00:00.000Z",
      events: input,
    });
    expect(report.continuityQuality).toBe("degraded");
    expect(report.qualityReasonCodes).toContain("SESSION_INTERRUPTED");
    expect(report.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["AFRELW003", "AFRELW004", "AFRELW005"]),
    );
  });

  it("rates failed pending recovery as poor with deterministic reasons", () => {
    const input = events([
      "session_opened",
      "session_interrupted",
      "recovery_checkpoint_failed",
      "recovery_pending",
    ]).map((event) =>
      event.eventType === "recovery_checkpoint_failed"
        ? { ...event, safeMetadata: { recoveryAttempt: 3 } }
        : event,
    );
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T11:00:00.000Z",
      events: input,
      pendingSessionIds: ["session-1"],
    });
    expect(report.continuityQuality).toBe("poor");
    expect(report.qualityReasonCodes).toContain("RECOVERY_PENDING");
    expect(report.totals.failedRecoveries).toBe(1);
    expect(report.warnings.some((warning) => warning.code === "AFRELW008")).toBe(true);
  });

  it("uses only AgentFold-observed sessions in completion percentages", () => {
    const input = [
      ...events(["session_opened", "session_closed"]),
      ...events(["service_started"]).map((event, index) => ({
        ...event,
        eventId: `unobserved-${index}`,
        sequence: 10 + index,
        sessionId: undefined,
        host: "antigravity" as const,
      })),
    ];
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T11:00:00.000Z",
      events: input,
    });
    expect(report.totals.observedSessions).toBe(1);
    expect(
      report.hosts.find((host) => host.host === "codex")?.observedLifecycleCompletionPercent,
    ).toBe(100);
    expect(report.hosts.find((host) => host.host === "antigravity")?.observedSessions).toBe(0);
  });

  it("emits only safe bounded event summaries", () => {
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T11:00:00.000Z",
      events: events(["session_opened", "task_continued", "checkpoint_created"]).map((event) => ({
        ...event,
        checkpointId: event.eventType === "checkpoint_created" ? "CP-001" : undefined,
      })),
      includeEvents: true,
      limit: 2,
    });
    expect(report.events).toHaveLength(2);
    expect(JSON.stringify(report)).not.toMatch(
      /repositoryRoot|prompt|reportText|sourceContent|changedPaths|diff|token/iu,
    );
  });

  it("detects an observed long session with no task activity", () => {
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T11:00:00.000Z",
      events: events(["session_opened", "session_closed"]),
    });
    expect(report.continuityQuality).toBe("good");
    expect(report.warnings.map((warning) => warning.code)).toContain("AFRELW001");
  });

  it("warns when durable task activity has no semantic report or normal close", () => {
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T11:00:00.000Z",
      events: events(["session_opened", "task_started", "checkpoint_created"]).map((event) =>
        event.eventType === "checkpoint_created"
          ? { ...event, checkpointId: "CP-001", semanticFreshness: "absent" as const }
          : event,
      ),
    });
    expect(report.continuityQuality).toBe("degraded");
    expect(report.qualityReasonCodes).toContain("SEMANTIC_STATE_ABSENT");
    expect(report.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["AFRELW002", "AFRELW006", "AFRELW009"]),
    );
  });

  it("warns when a task finishes without a successful validation entry", () => {
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T11:00:00.000Z",
      events: events([
        "session_opened",
        "progress_report_submitted",
        "checkpoint_created",
        "task_finished",
      ]).map((event) =>
        event.eventType === "checkpoint_created"
          ? { ...event, checkpointId: "CP-001", semanticFreshness: "current" as const }
          : event.eventType === "task_finished"
            ? {
                ...event,
                checkpointId: "CP-002",
                safeMetadata: { validationPassedCount: 0, validationFailedCount: 1 },
              }
            : event,
      ),
    });
    expect(report.warnings.map((warning) => warning.code)).toContain("AFRELW007");
  });

  it("summarizes agent-switch recovery without inventing unobserved sessions", () => {
    const report = analyzeReliability({
      repositoryId,
      generatedAt: "2026-07-24T11:00:00.000Z",
      events: events([
        "session_opened",
        "agent_switch_detected",
        "agent_switch_checkpoint_created",
        "session_superseded",
      ]).map((event) =>
        event.eventType === "agent_switch_checkpoint_created"
          ? { ...event, checkpointId: "CP-001", semanticFreshness: "current" as const }
          : event,
      ),
    });
    expect(report.totals.observedSessions).toBe(1);
    expect(report.hosts).toHaveLength(1);
    expect(report.hosts[0]?.observedSessions).toBe(1);
  });
});
