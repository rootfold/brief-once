import { z } from "zod";

import { normalizeGitPath } from "../git/git-path.js";
import {
  agentNameSchema,
  decisionSchema,
  failedAttemptSchema,
  objectiveSchema,
  semanticTextSchema,
  taskTitleSchema,
  validationResultSchema,
} from "../state/value-schemas.js";

const timestampSchema = z.iso.datetime({ offset: true });
const commitSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/iu, "Must be a Git commit ID")
  .nullable();
const branchSchema = z.string().trim().min(1).max(500);
const checkpointPathSchema = z.string().transform((value, context) => {
  try {
    return normalizeGitPath(value);
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid repository path",
    });
    return z.NEVER;
  }
});
const moveSchema = z.object({ from: checkpointPathSchema, to: checkpointPathSchema }).strict();

export const changedPathGroupsSchema = z
  .object({
    added: z.array(checkpointPathSchema),
    modified: z.array(checkpointPathSchema),
    deleted: z.array(checkpointPathSchema),
    renamed: z.array(moveSchema),
    copied: z.array(moveSchema),
    untracked: z.array(checkpointPathSchema),
    unmerged: z.array(checkpointPathSchema),
  })
  .strict();

export const diffStatisticsSchema = z
  .object({
    filesChanged: z.number().int().nonnegative(),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binaryFiles: z.number().int().nonnegative(),
    untrackedFiles: z.number().int().nonnegative(),
  })
  .strict();

export const recentCommitSchema = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{7,64}$/iu),
    subject: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const checkpointGitFactsSchema = z
  .object({
    startingBranch: branchSchema,
    currentBranch: branchSchema,
    startingCommit: commitSchema,
    currentCommit: commitSchema,
    detached: z.boolean(),
    branchChanged: z.boolean(),
    headChanged: z.boolean(),
    workingTree: z.enum(["clean", "dirty"]),
    hasStagedChanges: z.boolean(),
    hasUnstagedChanges: z.boolean(),
    changedPaths: changedPathGroupsSchema,
    diffStatistics: diffStatisticsSchema,
    recentCommits: z.array(recentCommitSchema).max(50),
    untrackedFilesExcludedFromLineStatistics: z.literal(true),
  })
  .strict();

export const checkpointReportedStateSchema = z
  .object({
    completed: z.array(semanticTextSchema).max(1_000),
    inProgress: z.array(semanticTextSchema).max(1_000),
    decisions: z.array(decisionSchema).max(1_000),
    failedAttempts: z.array(failedAttemptSchema).max(1_000),
    blockers: z.array(semanticTextSchema).max(1_000),
    nextActions: z.array(semanticTextSchema).max(1_000),
    validation: z.array(validationResultSchema).max(1_000),
    assumptions: z.array(semanticTextSchema).max(1_000),
  })
  .strict();

export const checkpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(["progress", "final"]).default("progress"),
    taskStatus: z.literal("completed").optional(),
    checkpointId: z.string().regex(/^CP-\d{3}$/u, "Must be a valid checkpoint ID"),
    taskId: z.string().regex(/^AF-\d{8}-\d{3}$/u, "Must be a valid BriefOnce task ID"),
    taskTitle: taskTitleSchema,
    taskObjective: objectiveSchema,
    createdAt: timestampSchema,
    checkpointAgent: agentNameSchema.optional(),
    lastReportingAgent: agentNameSchema.optional(),
    semanticRevision: z.number().int().nonnegative(),
    semanticFreshness: z.enum(["none", "new", "reused"]),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    observedGit: checkpointGitFactsSchema,
    reportedState: checkpointReportedStateSchema,
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (checkpoint.kind === "final" && checkpoint.taskStatus !== "completed") {
      context.addIssue({
        code: "custom",
        path: ["taskStatus"],
        message: "Final checkpoints must record completed task status",
      });
    }
    if (checkpoint.kind === "progress" && checkpoint.taskStatus !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["taskStatus"],
        message: "Progress checkpoints cannot record completed task status",
      });
    }
    if (checkpoint.semanticRevision === 0 && checkpoint.semanticFreshness !== "none") {
      context.addIssue({
        code: "custom",
        path: ["semanticFreshness"],
        message: "Revision 0 must use semantic freshness none",
      });
    }
    if (checkpoint.semanticRevision > 0 && checkpoint.semanticFreshness === "none") {
      context.addIssue({
        code: "custom",
        path: ["semanticFreshness"],
        message: "Reported semantic state cannot use freshness none",
      });
    }
    const git = checkpoint.observedGit;
    if (git.branchChanged !== (git.startingBranch !== git.currentBranch)) {
      context.addIssue({
        code: "custom",
        path: ["observedGit", "branchChanged"],
        message: "Branch-change flag does not match the observed branches",
      });
    }
    if (git.headChanged !== (git.startingCommit !== git.currentCommit)) {
      context.addIssue({
        code: "custom",
        path: ["observedGit", "headChanged"],
        message: "HEAD-change flag does not match the observed commits",
      });
    }
    if (git.diffStatistics.untrackedFiles !== git.changedPaths.untracked.length) {
      context.addIssue({
        code: "custom",
        path: ["observedGit", "diffStatistics", "untrackedFiles"],
        message: "Untracked-file count does not match the observed paths",
      });
    }
    const trackedPaths = new Set([
      ...git.changedPaths.added,
      ...git.changedPaths.modified,
      ...git.changedPaths.deleted,
      ...git.changedPaths.unmerged,
      ...git.changedPaths.renamed.map((move) => move.to),
      ...git.changedPaths.copied.map((move) => move.to),
    ]);
    if (git.diffStatistics.filesChanged !== trackedPaths.size) {
      context.addIssue({
        code: "custom",
        path: ["observedGit", "diffStatistics", "filesChanged"],
        message: "Tracked-file count does not match the observed paths",
      });
    }
    if (git.diffStatistics.binaryFiles > git.diffStatistics.filesChanged) {
      context.addIssue({
        code: "custom",
        path: ["observedGit", "diffStatistics", "binaryFiles"],
        message: "Binary-file count cannot exceed tracked files changed",
      });
    }
    const changedPathCount = trackedPaths.size + git.changedPaths.untracked.length;
    if ((changedPathCount === 0) !== (git.workingTree === "clean")) {
      context.addIssue({
        code: "custom",
        path: ["observedGit", "workingTree"],
        message: "Working-tree state does not match the observed changed paths",
      });
    }
  });
