import { z } from "zod";

import {
  agentNameSchema,
  decisionSchema,
  failedAttemptSchema,
  objectiveSchema,
  repositoryWorkingContextSchema,
  semanticTextSchema,
  taskTitleSchema,
  validationResultSchema,
} from "./value-schemas.js";

const timestampSchema = z.iso.datetime({ offset: true });
const commitSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/iu, "Must be a Git commit ID")
  .nullable();
const branchSchema = z.string().trim().min(1).max(500);

export const taskStatuses = ["active"] as const;

export const checkpointHistoryMetadataSchema = z
  .object({
    count: z.number().int().nonnegative(),
    latestCheckpointAt: timestampSchema.nullable(),
    latestCheckpointId: z
      .string()
      .regex(/^CP-\d{3}$/u)
      .nullable()
      .default(null),
    latestFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable()
      .default(null),
    latestSemanticRevision: z.number().int().nonnegative().default(0),
  })
  .strict();

export const activeTaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().regex(/^AF-\d{8}-\d{3}$/u, "Must be a valid BriefOnce task ID"),
    title: taskTitleSchema,
    status: z.enum(taskStatuses),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    workingContext: repositoryWorkingContextSchema,
    startingBranch: branchSchema,
    currentBranch: branchSchema,
    startingCommit: commitSchema,
    currentCommit: commitSchema,
    startingAgent: agentNameSchema.optional(),
    lastAgent: agentNameSchema.optional(),
    reportRevision: z.number().int().nonnegative().default(0),
    latestReportAt: timestampSchema.nullable().default(null),
    objective: objectiveSchema,
    completed: z.array(semanticTextSchema).max(1_000),
    inProgress: z.array(semanticTextSchema).max(1_000),
    decisions: z.array(decisionSchema).max(1_000),
    failedAttempts: z.array(failedAttemptSchema).max(1_000),
    blockers: z.array(semanticTextSchema).max(1_000),
    nextActions: z.array(semanticTextSchema).max(1_000),
    validation: z.array(validationResultSchema).max(1_000),
    assumptions: z.array(semanticTextSchema).max(1_000),
    checkpointHistory: checkpointHistoryMetadataSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.checkpointHistory.latestSemanticRevision > state.reportRevision) {
      context.addIssue({
        code: "custom",
        path: ["checkpointHistory", "latestSemanticRevision"],
        message: "Latest checkpoint semantic revision cannot exceed report revision",
      });
    }
  });
