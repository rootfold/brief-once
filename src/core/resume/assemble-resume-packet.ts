import type { Checkpoint } from "../checkpoints/types.js";
import { normalizeRepositoryPath } from "../config/repository-path.js";
import type { CanonicalProjectContext } from "../context/types.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type { ActiveTask } from "../state/types.js";
import { resumePacketSchema } from "./resume-packet-schema.js";
import { targetInstruction } from "./target-instructions.js";
import type { ResumePacket, ResumeTarget } from "./types.js";

const commandNames = ["install", "dev", "build", "test", "lint", "typecheck"] as const;

export interface AssembleResumePacketInput {
  readonly canonicalContext: CanonicalProjectContext;
  readonly activeTask: ActiveTask;
  readonly checkpoint: Checkpoint;
  readonly isLatestCheckpoint: boolean;
  readonly target?: ResumeTarget;
  readonly availableInstructionFiles?: readonly string[];
}

export interface AssembleResumePacketResult {
  readonly packet: ResumePacket;
  readonly diagnostics: readonly Diagnostic[];
}

function safetyBulletItems(markdown: string): readonly string[] {
  let includeSection = true;
  return markdown
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .flatMap((line) => {
      const heading = line.match(/^##\s+(.+)$/u);
      if (heading !== null) {
        includeSection = heading[1]?.trim().toLowerCase() !== "excluded paths";
        return [];
      }
      return includeSection && /^\s*-\s+\S/u.test(line)
        ? [line.replace(/^\s*-\s+/u, "").trim()]
        : [];
    });
}

function emptyOmissions(): ResumePacket["omitted"] {
  return {
    projectSummaryCharacters: 0,
    safetyInstructions: 0,
    excludedPaths: 0,
    projectCommands: 0,
    changedPaths: {
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      copied: 0,
      untracked: 0,
      unmerged: 0,
    },
    recentCommits: 0,
    semantic: {
      completed: 0,
      inProgress: 0,
      decisions: 0,
      failedAttempts: 0,
      blockers: 0,
      nextActions: 0,
      validation: 0,
      assumptions: 0,
    },
  };
}

export function assembleResumePacket(input: AssembleResumePacketInput): AssembleResumePacketResult {
  const { canonicalContext, activeTask, checkpoint } = input;
  if (checkpoint.taskId !== activeTask.taskId) {
    throw new Error("Checkpoint task does not match the active task");
  }

  const diagnostics: Diagnostic[] = [];
  const projectCommands = Object.fromEntries(
    commandNames.flatMap((name) => {
      const command = canonicalContext.commands[name];
      return command === undefined ? [] : [[name, command]];
    }),
  );
  const excludedPaths = canonicalContext.safety.excludedPaths.flatMap((excludedPath) => {
    const normalized = normalizeRepositoryPath(excludedPath);
    if (normalized.success) return [normalized.path];
    diagnostics.push({
      code: "AFR012",
      severity: "warning",
      message: "A non-portable safety exclusion was omitted from the resume packet.",
      suggestion: `Use repository-relative excluded paths in ${canonicalContext.storage.directory}/config.yaml.`,
    });
    return [];
  });
  const safetyInstructions = [
    "Inspect the repository and confirm its current state before changing code.",
    "Preserve existing uncommitted work.",
    "Do not create Git commits or push unless the developer explicitly requests it.",
    ...safetyBulletItems(canonicalContext.context.safety),
  ];
  const reportedState =
    checkpoint.semanticFreshness === "none"
      ? {
          completed: [],
          inProgress: [],
          decisions: [],
          failedAttempts: [],
          blockers: [],
          nextActions: [],
          validation: [],
          assumptions: [],
        }
      : checkpoint.reportedState;

  const packet = resumePacketSchema.parse({
    schemaVersion: 1,
    project: {
      name: canonicalContext.project.name,
      summary: canonicalContext.project.summary.replace(/\s+/gu, " ").trim(),
    },
    task: {
      taskId: checkpoint.taskId,
      checkpointId: checkpoint.checkpointId,
      checkpointCreatedAt: checkpoint.createdAt,
      isLatestCheckpoint: input.isLatestCheckpoint,
      title: checkpoint.taskTitle,
      objective: checkpoint.taskObjective,
      status: activeTask.status,
    },
    ...(input.target === undefined
      ? {}
      : {
          target: targetInstruction(input.target, input.availableInstructionFiles ?? []),
        }),
    observedGitState: checkpoint.observedGit,
    semanticState: {
      revision: checkpoint.semanticRevision,
      freshness: checkpoint.semanticFreshness,
      ...(checkpoint.lastReportingAgent === undefined
        ? {}
        : { lastReportingAgent: checkpoint.lastReportingAgent }),
      ...(checkpoint.checkpointAgent === undefined
        ? {}
        : { checkpointAgent: checkpoint.checkpointAgent }),
      ...reportedState,
    },
    projectCommands,
    safety: {
      instructions: [...new Set(safetyInstructions)],
      excludedPaths: [...new Set(excludedPaths)],
    },
    omitted: emptyOmissions(),
  });

  return { packet, diagnostics };
}
