import { z } from "zod";

import { reliabilityHosts, type ReliabilityHost } from "../../core/reliability/event-schema.js";

const privateIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const persistentSessionStates = [
  "open",
  "detached",
  "recovery_pending",
  "interrupted",
] as const;

export const persistentLifecycleEvents = [
  "session_opened",
  "task_started",
  "task_continued",
  "report_submitted",
  "checkpoint_created",
  "resume_requested",
  "detached",
] as const;

export const persistentSessionRecordSchema = z
  .object({
    sessionId: privateIdentifierSchema,
    repositoryId: z.string().regex(/^[a-f0-9]{24,64}$/u),
    canonicalRepositoryRoot: z.string().trim().min(1).max(32_768),
    host: z.enum(reliabilityHosts),
    client: privateIdentifierSchema.max(100),
    agent: privateIdentifierSchema.max(100),
    taskId: z
      .string()
      .regex(/^AF-\d{8}-\d{3}$/u)
      .optional(),
    openedAt: z.string().datetime({ offset: true }),
    lastHeartbeatAt: z.string().datetime({ offset: true }),
    leaseExpiresAt: z.string().datetime({ offset: true }),
    state: z.enum(persistentSessionStates),
    lastLifecycleEvent: z.enum(persistentLifecycleEvents),
    lastCheckpointId: z
      .string()
      .regex(/^CP-\d{3}$/u)
      .optional(),
    semanticRevision: z.number().int().min(0).max(1_000_000).optional(),
    reportCount: z.number().int().min(0).max(1_000_000),
    checkpointCount: z.number().int().min(0).max(1_000_000),
    recoveryAttempts: z.number().int().min(0).max(3),
    nextRecoveryAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const persistentSessionJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    serviceInstanceId: privateIdentifierSchema,
    writtenAt: z.string().datetime({ offset: true }),
    sessions: z.array(persistentSessionRecordSchema).max(1_000),
  })
  .strict()
  .superRefine((journal, context) => {
    const ids = journal.sessions.map((session) => session.sessionId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "Session identifiers must be unique",
      });
    }
  });

export type PersistentSessionRecord = z.infer<typeof persistentSessionRecordSchema>;
export type PersistentSessionJournal = z.infer<typeof persistentSessionJournalSchema>;
export type PersistentSessionState = (typeof persistentSessionStates)[number];
export type PersistentLifecycleEvent = (typeof persistentLifecycleEvents)[number];

export interface SafePersistentSessionSummary {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly host: ReliabilityHost;
  readonly taskId?: string;
  readonly state: PersistentSessionState;
  readonly lastHeartbeatAt: string;
  readonly reportCount: number;
  readonly checkpointCount: number;
  readonly recoveryAttempts: number;
}

export function safePersistentSessionSummary(
  record: PersistentSessionRecord,
): SafePersistentSessionSummary {
  return {
    sessionId: record.sessionId,
    repositoryId: record.repositoryId,
    host: record.host,
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    state: record.state,
    lastHeartbeatAt: record.lastHeartbeatAt,
    reportCount: record.reportCount,
    checkpointCount: record.checkpointCount,
    recoveryAttempts: record.recoveryAttempts,
  };
}
