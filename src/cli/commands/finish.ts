import path from "node:path";

import { Option, type Command } from "commander";

import {
  commitTaskFinish,
  prepareTaskFinish,
  type FinishPlan,
  type PrepareTaskFinishDependencies,
} from "../../core/completion/finish-task.js";
import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import { AtomicTextFileWriter } from "../../core/filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { portablePath } from "../../core/initialization/paths.js";
import { CliCommandError } from "../command-error.js";
import type { StdinReader } from "../input/stdin-reader.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";
import { recordCliReliability } from "../../integrations/reliability/record-cli-event.js";
import { productBrand } from "../../product-brand.js";

export interface FinishDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly stdinReader: StdinReader;
  readonly now?: () => Date;
  readonly reliabilityStateDirectory?: string;
  readonly reliabilityPersistence?: boolean;
}

interface FinishOptions {
  readonly stdin?: boolean;
  readonly agent?: string;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
}

function coreDependencies(dependencies: FinishDependencies): PrepareTaskFinishDependencies {
  return {
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
    gitInspector: dependencies.gitInspector,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
}

function changedPathCount(plan: Extract<FinishPlan, { status: "ready" }>): number {
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

function writePlan(output: CliOutput, plan: FinishPlan): void {
  writeLine(output, `${productBrand.productName} finish`);
  writeLine(output);
  for (const item of plan.diagnostics) {
    writeLine(output, formatDiagnostic(item, { color: output.useColor }));
  }
  if (plan.status !== "ready") return;
  writeLine(output);
  writeLine(output, `Task: ${plan.task.taskId} — ${plan.task.title}`);
  writeLine(output, `Summary: ${plan.task.summary}`);
  writeLine(output, `Final checkpoint: ${plan.checkpoint.checkpointId} (${plan.checkpoint.kind})`);
  writeLine(output, `Semantic revision: ${plan.task.semanticRevision}`);
  writeLine(output, `Changed paths: ${changedPathCount(plan)}`);
  writeLine(
    output,
    `Validation: ${plan.task.validation.length} recorded; ${plan.task.validation.filter((item) => item.status === "failed").length} failed`,
  );
  writeLine(
    output,
    `Archive: ${portablePath(path.relative(plan.repositoryRoot, plan.completedPath))}`,
  );
  writeLine(output, `Visibility: ${plan.visibility}`);
}

export function registerFinishCommand(
  program: Command,
  dependencies: FinishDependencies,
  output: CliOutput,
): void {
  program
    .command("finish")
    .description("Preview or atomically complete and archive the active task")
    .option("--stdin", "read one structured completion JSON object from standard input")
    .option("--agent <agent>", "supply the finishing agent when input omits it")
    .addOption(new Option("--dry-run", "preview without writing finish artifacts").conflicts("yes"))
    .addOption(new Option("--yes", "finish the task non-interactively").conflicts("dryRun"))
    .action(async (options: FinishOptions) => {
      const json = options.stdin === true ? await dependencies.stdinReader.readAll() : undefined;
      const plan = await prepareTaskFinish(coreDependencies(dependencies), {
        ...(json === undefined ? {} : { json }),
        ...(options.agent === undefined ? {} : { agentOverride: options.agent }),
      });
      writePlan(output, plan);
      if (plan.exitCode !== 0) {
        throw new CliCommandError(
          plan.exitCode,
          `${productBrand.productName} task finish could not proceed`,
        );
      }
      if (plan.status !== "ready") return;
      if (options.yes !== true) {
        writeLine(output);
        writeLine(
          output,
          options.dryRun === true
            ? "Dry run complete. No checkpoint, archive, or active state was written."
            : "Preview complete. No files were changed; re-run with --yes to finish the task.",
        );
        return;
      }
      const result = await commitTaskFinish(
        plan,
        dependencies.fileSystem,
        new AtomicTextFileWriter(dependencies.fileSystem),
      );
      for (const item of result.diagnostics.slice(plan.diagnostics.length)) {
        writeLine(output, formatDiagnostic(item, { color: output.useColor }));
      }
      if (result.exitCode !== 0) {
        throw new CliCommandError(
          result.exitCode,
          `${productBrand.productName} task finish could not be persisted`,
        );
      }
      writeLine(output, `${productBrand.productName} task completed.`);
      for (const item of await recordCliReliability({
        repositoryRoot: plan.repositoryRoot,
        fileSystem: dependencies.fileSystem,
        gitRepositoryLocator: dependencies.gitRepositoryLocator,
        ...(dependencies.reliabilityStateDirectory === undefined
          ? {}
          : { stateDirectory: dependencies.reliabilityStateDirectory }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        event: {
          eventType: "task_finished",
          agent: plan.task.finishingAgent,
          taskId: plan.task.taskId,
          checkpointId: plan.task.finalCheckpointId,
          semanticRevision: plan.task.semanticRevision,
          outcome: "success",
          safeMetadata: {
            checkpointCount: 1,
            changedPathCount: changedPathCount(plan),
            validationPassedCount: plan.task.validation.filter(
              (validation) => validation.status === "passed",
            ).length,
            validationFailedCount: plan.task.validation.filter(
              (validation) => validation.status === "failed",
            ).length,
          },
        },
        enabled: dependencies.reliabilityPersistence,
      })) {
        writeLine(output, formatDiagnostic(item, { color: output.useColor }));
      }
    });
}
