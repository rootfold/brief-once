import { z } from "zod";

export const reliabilityEventTypes = [
  "service_started",
  "service_stopped",
  "service_restarted_with_interrupted_sessions",
  "session_opened",
  "session_heartbeat",
  "session_detached",
  "session_superseded",
  "session_closed",
  "session_interrupted",
  "session_timed_out",
  "task_started",
  "task_continued",
  "task_finished",
  "progress_report_submitted",
  "checkpoint_created",
  "checkpoint_duplicate",
  "checkpoint_skipped_interval",
  "agent_switch_detected",
  "agent_switch_checkpoint_created",
  "agent_switch_checkpoint_failed",
  "recovery_pending",
  "recovery_checkpoint_created",
  "recovery_checkpoint_duplicate",
  "recovery_checkpoint_not_needed",
  "recovery_checkpoint_failed",
  "resume_packet_requested",
  "resume_packet_current",
  "resume_packet_reused",
  "resume_packet_absent",
] as const;

export const reliabilityHosts = ["codex", "antigravity", "cli", "mcp", "unknown"] as const;
export const reliabilityOutcomes = [
  "success",
  "warning",
  "failure",
  "recovered",
  "skipped",
] as const;
export const semanticFreshnessValues = ["current", "reused", "absent"] as const;

const boundedIdentity = z.string().trim().min(1).max(200);
const safeMetadataSchema = z
  .object({
    reportCount: z.number().int().min(0).max(1_000_000).optional(),
    checkpointCount: z.number().int().min(0).max(1_000_000).optional(),
    changedPathCount: z.number().int().min(0).max(1_000_000).optional(),
    validationPassedCount: z.number().int().min(0).max(1_000_000).optional(),
    validationFailedCount: z.number().int().min(0).max(1_000_000).optional(),
    leaseAgeSeconds: z.number().int().min(0).max(31_536_000).optional(),
    recoveryAttempt: z.number().int().min(0).max(100).optional(),
    heartbeatCount: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const reliabilityEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: boundedIdentity,
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime({ offset: true }),
    repositoryId: z.string().regex(/^[a-f0-9]{24,64}$/u),
    eventType: z.enum(reliabilityEventTypes),
    host: z.enum(reliabilityHosts).optional(),
    client: z.string().trim().min(1).max(100).optional(),
    agent: z.string().trim().min(1).max(100).optional(),
    sessionId: boundedIdentity.optional(),
    taskId: z
      .string()
      .regex(/^AF-\d{8}-\d{3}$/u)
      .optional(),
    checkpointId: z
      .string()
      .regex(/^CP-\d{3}$/u)
      .optional(),
    semanticRevision: z.number().int().min(0).max(1_000_000).optional(),
    semanticFreshness: z.enum(semanticFreshnessValues).optional(),
    outcome: z.enum(reliabilityOutcomes),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,99}$/u)
      .optional(),
    safeMetadata: safeMetadataSchema.optional(),
  })
  .strict();

export const reliabilityEventStoreSchema = z
  .object({
    schemaVersion: z.literal(1),
    repositoryId: z.string().regex(/^[a-f0-9]{24,64}$/u),
    nextSequence: z.number().int().positive(),
    events: z.array(reliabilityEventSchema).max(10_000),
  })
  .strict()
  .superRefine((store, context) => {
    if (store.events.some((event) => event.repositoryId !== store.repositoryId)) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "Every event must match the store repository identifier",
      });
    }
    for (let index = 1; index < store.events.length; index += 1) {
      const current = store.events[index];
      const previous = store.events[index - 1];
      if (
        current !== undefined &&
        previous !== undefined &&
        current.sequence <= previous.sequence
      ) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "sequence"],
          message: "Event sequences must be strictly increasing",
        });
      }
    }
    const latestSequence = store.events.at(-1)?.sequence ?? 0;
    if (store.nextSequence <= latestSequence) {
      context.addIssue({
        code: "custom",
        path: ["nextSequence"],
        message: "nextSequence must be greater than every retained event sequence",
      });
    }
  });

export type ReliabilityEventType = (typeof reliabilityEventTypes)[number];
export type ReliabilityHost = (typeof reliabilityHosts)[number];
export type ReliabilityOutcome = (typeof reliabilityOutcomes)[number];
export type SemanticFreshness = (typeof semanticFreshnessValues)[number];
export type ReliabilityEvent = z.infer<typeof reliabilityEventSchema>;
export type ReliabilityEventStore = z.infer<typeof reliabilityEventStoreSchema>;
export type ReliabilitySafeMetadata = z.infer<typeof safeMetadataSchema>;

export type ReliabilityEventInput = Omit<
  ReliabilityEvent,
  "schemaVersion" | "eventId" | "sequence" | "occurredAt" | "repositoryId"
>;
