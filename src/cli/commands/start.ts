import path from "node:path";

import { Option, type Command } from "commander";

import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import {
  AtomicFileConflictError,
  AtomicTextFileWriter,
} from "../../core/filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { portablePath } from "../../core/initialization/paths.js";
import {
  commitTaskStart,
  prepareTaskStart,
  type PrepareTaskStartDependencies,
  type TaskStartPlan,
} from "../../core/state/start-task.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";
import { recordCliReliability } from "../../integrations/reliability/record-cli-event.js";

export interface StartDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now?: () => Date;
  readonly reliabilityStateDirectory?: string;
  readonly reliabilityPersistence?: boolean;
}

interface StartOptions {
  readonly agent?: string;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
}

function coreDependencies(dependencies: StartDependencies): PrepareTaskStartDependencies {
  return {
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
    gitInspector: dependencies.gitInspector,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
}

function writePlan(output: CliOutput, plan: TaskStartPlan): void {
  writeLine(output, "AgentFold start");
  writeLine(output);

  for (const diagnostic of plan.diagnostics) {
    writeLine(output, formatDiagnostic(diagnostic, { color: output.useColor }));
  }

  if (plan.status === "ready") {
    writeLine(output);
    writeLine(output, `Task ID: ${plan.state.taskId}`);
    writeLine(output, `Objective: ${plan.state.objective}`);
    writeLine(output, `Branch: ${plan.state.currentBranch}`);
    writeLine(output, `Commit: ${plan.state.currentCommit ?? "no commits"}`);
    writeLine(output, `Working context: ${plan.state.workingContext}`);
    writeLine(output, `State: ${portablePath(path.relative(plan.repositoryRoot, plan.statePath))}`);
    writeLine(output, `Visibility: ${plan.visibility}`);
  }
}

export function registerStartCommand(
  program: Command,
  dependencies: StartDependencies,
  output: CliOutput,
): void {
  program
    .command("start")
    .description("Preview or create a new active AgentFold task")
    .argument("<title>", "concise task objective")
    .option("--agent <agent>", "starting coding agent")
    .addOption(new Option("--dry-run", "preview without writing state").conflicts("yes"))
    .addOption(new Option("--yes", "create active state non-interactively").conflicts("dryRun"))
    .action(async (title: string, options: StartOptions) => {
      const plan = await prepareTaskStart(coreDependencies(dependencies), {
        title,
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      });
      writePlan(output, plan);

      if (plan.exitCode !== 0) {
        throw new CliCommandError(plan.exitCode, "AgentFold task start could not proceed");
      }

      if (plan.status !== "ready") {
        return;
      }

      if (options.yes === true) {
        let diagnostics: readonly Diagnostic[];
        try {
          diagnostics = await commitTaskStart(
            plan,
            new AtomicTextFileWriter(dependencies.fileSystem),
          );
        } catch (error: unknown) {
          if (error instanceof AtomicFileConflictError) {
            writeLine(output);
            writeLine(
              output,
              formatDiagnostic(
                {
                  code: "AFS003",
                  severity: "error",
                  message: "An active task appeared before the atomic create completed.",
                  suggestion: "No existing task was overwritten.",
                },
                { color: output.useColor },
              ),
            );
            throw new CliCommandError(5, error.message);
          }
          throw error;
        }

        const completion = diagnostics.at(-1);
        if (completion !== undefined) {
          writeLine(output);
          writeLine(output, formatDiagnostic(completion, { color: output.useColor }));
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
            eventType: "task_started",
            ...(plan.state.startingAgent === null ? {} : { agent: plan.state.startingAgent }),
            taskId: plan.state.taskId,
            outcome: "success",
          },
          enabled: dependencies.reliabilityPersistence,
        })) {
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        }
        return;
      }

      writeLine(output);
      writeLine(
        output,
        options.dryRun === true
          ? "Dry run complete. No state was written."
          : "Preview complete. No state was written; re-run with --yes to create the task.",
      );
    });
}
