import { z } from "zod";

import {
  reliabilityEventTypes,
  reliabilityHosts,
  reliabilityOutcomes,
  semanticFreshnessValues,
} from "./event-schema.js";

export const reliabilityQualities = ["excellent", "good", "degraded", "poor", "unknown"] as const;
export const reliabilityWarningSeverities = ["info", "warning", "error"] as const;

export const reliabilityWarningSchema = z
  .object({
    code: z.string().regex(/^AFRELW\d{3}$/u),
    severity: z.enum(reliabilityWarningSeverities),
    message: z.string().trim().min(1).max(500),
    host: z.enum(reliabilityHosts).optional(),
    taskId: z
      .string()
      .regex(/^AF-\d{8}-\d{3}$/u)
      .optional(),
    sessionId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const reliabilityEventSummarySchema = z
  .object({
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime({ offset: true }),
    eventType: z.enum(reliabilityEventTypes),
    outcome: z.enum(reliabilityOutcomes),
    host: z.enum(reliabilityHosts).optional(),
    taskId: z
      .string()
      .regex(/^AF-\d{8}-\d{3}$/u)
      .optional(),
    sessionId: z.string().trim().min(1).max(200).optional(),
    checkpointId: z
      .string()
      .regex(/^CP-\d{3}$/u)
      .optional(),
    semanticFreshness: z.enum(semanticFreshnessValues).optional(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,99}$/u)
      .optional(),
  })
  .strict();

export const reliabilityHostSummarySchema = z
  .object({
    host: z.enum(reliabilityHosts),
    observedSessions: z.number().int().min(0),
    normalClosures: z.number().int().min(0),
    finishedTasks: z.number().int().min(0),
    detachedSessions: z.number().int().min(0),
    timedOutSessions: z.number().int().min(0),
    interruptedSessions: z.number().int().min(0),
    progressReports: z.number().int().min(0),
    checkpoints: z.number().int().min(0),
    recoveryCheckpoints: z.number().int().min(0),
    failedRecoveries: z.number().int().min(0),
    observedLifecycleCompletionPercent: z.number().min(0).max(100).nullable(),
  })
  .strict();

const taskSummarySchema = z
  .object({
    taskId: z.string().regex(/^AF-\d{8}-\d{3}$/u),
    title: z.string().trim().min(1).max(200),
  })
  .strict();

export const reliabilityReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    repositoryId: z.string().regex(/^[a-f0-9]{24,64}$/u),
    generatedAt: z.string().datetime({ offset: true }),
    currentTask: taskSummarySchema.optional(),
    latestCompletedTask: taskSummarySchema
      .extend({
        finishedAt: z.string().datetime({ offset: true }),
        finalCheckpointId: z.string().regex(/^CP-\d{3}$/u),
      })
      .optional(),
    hosts: z.array(reliabilityHostSummarySchema),
    continuityQuality: z.enum(reliabilityQualities),
    qualityReasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/u)),
    semanticFreshness: z.enum([...semanticFreshnessValues, "unknown"]),
    serviceAvailability: z.enum(["running", "stopped", "unknown"]),
    warnings: z.array(reliabilityWarningSchema),
    totals: z
      .object({
        observedSessions: z.number().int().min(0),
        normalClosures: z.number().int().min(0),
        finishedTasks: z.number().int().min(0),
        detachedSessions: z.number().int().min(0),
        timedOutSessions: z.number().int().min(0),
        interruptedSessions: z.number().int().min(0),
        recoveryCheckpoints: z.number().int().min(0),
        failedRecoveries: z.number().int().min(0),
        reportsSubmitted: z.number().int().min(0),
        recoveryPendingSessions: z.number().int().min(0),
      })
      .strict(),
    events: z.array(reliabilityEventSummarySchema).optional(),
  })
  .strict();

export type ReliabilityQuality = (typeof reliabilityQualities)[number];
export type ReliabilityWarning = z.infer<typeof reliabilityWarningSchema>;
export type ReliabilityEventSummary = z.infer<typeof reliabilityEventSummarySchema>;
export type ReliabilityHostSummary = z.infer<typeof reliabilityHostSummarySchema>;
export type ReliabilityReport = z.infer<typeof reliabilityReportSchema>;
