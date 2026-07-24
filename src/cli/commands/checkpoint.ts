import type { Command } from "commander";

import {
  commitCheckpoint,
  prepareCheckpoint,
  type CheckpointPlan,
  type PrepareCheckpointDependencies,
} from "../../core/checkpoints/create-checkpoint.js";
import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import { AtomicTextFileWriter } from "../../core/filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";
import { recordCliReliability } from "../../integrations/reliability/record-cli-event.js";

export interface CheckpointDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now?: () => Date;
  readonly reliabilityStateDirectory?: string;
  readonly reliabilityPersistence?: boolean;
}

interface CheckpointOptions {
  readonly agent?: string;
  readonly dryRun?: boolean;
}

function coreDependencies(dependencies: CheckpointDependencies): PrepareCheckpointDependencies {
  return {
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
    gitInspector: dependencies.gitInspector,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
}

function changedPathCount(
  plan: Extract<CheckpointPlan, { status: "ready" | "duplicate" }>,
): number {
  const paths = plan.checkpoint.observedGit.changedPaths;
  return (
    paths.added.length +
    paths.modified.length +
    paths.deleted.length +
    paths.renamed.length +
    paths.copied.length +
    paths.untracked.length +
    paths.unmerged.length
  );
}

function writeFacts(
  output: CliOutput,
  plan: Extract<CheckpointPlan, { status: "ready" | "duplicate" }>,
): void {
  const checkpoint = plan.checkpoint;
  const git = checkpoint.observedGit;
  writeLine(output);
  writeLine(output, `Checkpoint: ${checkpoint.checkpointId}`);
  writeLine(output, `Branch: ${git.currentBranch}`);
  writeLine(output, `Commit: ${git.currentCommit ?? "no commits"}`);
  writeLine(output, `Branch changed since start: ${git.branchChanged ? "yes" : "no"}`);
  writeLine(output, `HEAD changed since start: ${git.headChanged ? "yes" : "no"}`);
  writeLine(output, `Working tree: ${git.workingTree}`);
  writeLine(output, `Changed paths: ${changedPathCount(plan)}`);
  writeLine(
    output,
    `Diff: +${git.diffStatistics.insertions} -${git.diffStatistics.deletions}; ${git.diffStatistics.binaryFiles} binary`,
  );
  writeLine(output, `Semantic revision: ${checkpoint.semanticRevision}`);
}

export function registerCheckpointCommand(
  program: Command,
  dependencies: CheckpointDependencies,
  output: CliOutput,
): void {
  program
    .command("checkpoint")
    .description("Capture Git facts and semantic state in immutable checkpoint history")
    .option("--agent <agent>", "agent or integration creating the checkpoint")
    .option("--dry-run", "capture and preview without writing state")
    .action(async (options: CheckpointOptions) => {
      const plan = await prepareCheckpoint(coreDependencies(dependencies), {
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      });

      writeLine(output, "BriefOnce checkpoint");
      writeLine(output);
      for (const diagnostic of plan.diagnostics) {
        writeLine(output, formatDiagnostic(diagnostic, { color: output.useColor }));
      }

      if (plan.exitCode !== 0) {
        throw new CliCommandError(plan.exitCode, "BriefOnce checkpoint could not proceed");
      }
      if (plan.status === "duplicate") {
        for (const item of await recordCliReliability({
          repositoryRoot: plan.repositoryRoot,
          fileSystem: dependencies.fileSystem,
          gitRepositoryLocator: dependencies.gitRepositoryLocator,
          ...(dependencies.reliabilityStateDirectory === undefined
            ? {}
            : { stateDirectory: dependencies.reliabilityStateDirectory }),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
          event: {
            eventType: "checkpoint_duplicate",
            ...(options.agent === undefined ? {} : { agent: options.agent }),
            taskId: plan.checkpoint.taskId,
            checkpointId: plan.checkpoint.checkpointId,
            semanticRevision: plan.checkpoint.semanticRevision,
            semanticFreshness:
              plan.checkpoint.semanticFreshness === "new"
                ? "current"
                : plan.checkpoint.semanticFreshness === "none"
                  ? "absent"
                  : "reused",
            outcome: "skipped",
            reasonCode: "DUPLICATE_FINGERPRINT",
          },
          enabled: dependencies.reliabilityPersistence,
        })) {
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        }
        return;
      }
      if (plan.status !== "ready") {
        return;
      }

      writeFacts(output, plan);
      if (options.dryRun === true) {
        writeLine(output);
        writeLine(
          output,
          formatDiagnostic(
            {
              code: "AFCP017",
              severity: "success",
              message: "Dry run complete. No checkpoint or active state was written.",
            },
            { color: output.useColor },
          ),
        );
        return;
      }

      const result = await commitCheckpoint(
        plan,
        dependencies.fileSystem,
        new AtomicTextFileWriter(dependencies.fileSystem),
      );
      for (const diagnostic of result.diagnostics.slice(plan.diagnostics.length)) {
        writeLine(output, formatDiagnostic(diagnostic, { color: output.useColor }));
      }
      if (result.exitCode !== 0) {
        throw new CliCommandError(result.exitCode, "BriefOnce checkpoint could not be persisted");
      }
      for (const item of await recordCliReliability({
        repositoryRoot: plan.repositoryRoot,
        fileSystem: dependencies.fileSystem,
        gitRepositoryLocator: dependencies.gitRepositoryLocator,
        ...(dependencies.reliabilityStateDirectory === undefined
          ? {}
          : { stateDirectory: dependencies.reliabilityStateDirectory }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        event: {
          eventType: "checkpoint_created",
          ...(options.agent === undefined ? {} : { agent: options.agent }),
          taskId: plan.checkpoint.taskId,
          checkpointId: plan.checkpoint.checkpointId,
          semanticRevision: plan.checkpoint.semanticRevision,
          semanticFreshness:
            plan.checkpoint.semanticFreshness === "new"
              ? "current"
              : plan.checkpoint.semanticFreshness === "none"
                ? "absent"
                : "reused",
          outcome: "success",
          safeMetadata: { checkpointCount: 1, changedPathCount: changedPathCount(plan) },
        },
        enabled: dependencies.reliabilityPersistence,
      })) {
        writeLine(output, formatDiagnostic(item, { color: output.useColor }));
      }
    });
}
