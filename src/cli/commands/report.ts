import type { Command } from "commander";

import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import { AtomicTextFileWriter } from "../../core/filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import {
  commitAgentReport,
  prepareAgentReport,
  type PrepareAgentReportDependencies,
  type ReadyReportPlan,
} from "../../core/reports/apply-report.js";
import { CliCommandError } from "../command-error.js";
import type { StdinReader } from "../input/stdin-reader.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";
import { recordCliReliability } from "../../integrations/reliability/record-cli-event.js";

export interface ReportDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly stdinReader: StdinReader;
  readonly now?: () => Date;
  readonly reliabilityStateDirectory?: string;
  readonly reliabilityPersistence?: boolean;
}

interface ReportOptions {
  readonly stdin: boolean;
  readonly agent?: string;
}

function coreDependencies(dependencies: ReportDependencies): PrepareAgentReportDependencies {
  return {
    fileSystem: dependencies.fileSystem,
    gitRepositoryLocator: dependencies.gitRepositoryLocator,
    gitInspector: dependencies.gitInspector,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
}

function summaryLines(plan: ReadyReportPlan): readonly string[] {
  const labels: Readonly<Record<keyof ReadyReportPlan["summary"], string>> = {
    completed: "completed item",
    inProgress: "in-progress item",
    decisions: "decision",
    failedAttempts: "failed attempt",
    blockers: "blocker",
    nextActions: "next action",
    validation: "validation result",
    assumptions: "assumption",
  };

  return Object.entries(plan.summary)
    .filter((entry): entry is [keyof ReadyReportPlan["summary"], number] => entry[1] > 0)
    .map(([key, count]) => `Added ${count} ${labels[key]}${count === 1 ? "" : "s"}`);
}

export function registerReportCommand(
  program: Command,
  dependencies: ReportDependencies,
  output: CliOutput,
): void {
  program
    .command("report")
    .description("Merge a structured coding-agent report into the active task")
    .requiredOption("--stdin", "read one JSON report from standard input")
    .option("--agent <agent>", "override or supply the reporting agent")
    .action(async (options: ReportOptions) => {
      const json = await dependencies.stdinReader.readAll();
      const plan = await prepareAgentReport(coreDependencies(dependencies), {
        json,
        ...(options.agent === undefined ? {} : { agentOverride: options.agent }),
      });

      writeLine(output, "BriefOnce report");
      writeLine(output);
      for (const diagnostic of plan.diagnostics) {
        writeLine(output, formatDiagnostic(diagnostic, { color: output.useColor }));
      }

      if (plan.exitCode !== 0) {
        throw new CliCommandError(plan.exitCode, "BriefOnce report could not be applied");
      }

      if (plan.status !== "ready") {
        return;
      }

      for (const line of summaryLines(plan)) {
        writeLine(output, line);
      }

      const diagnostics = await commitAgentReport(
        plan,
        new AtomicTextFileWriter(dependencies.fileSystem),
      );
      const completion = diagnostics.at(-1);
      if (completion !== undefined) {
        writeLine(output, formatDiagnostic(completion, { color: output.useColor }));
      }
      if (plan.changed) {
        for (const item of await recordCliReliability({
          repositoryRoot: plan.repositoryRoot,
          fileSystem: dependencies.fileSystem,
          gitRepositoryLocator: dependencies.gitRepositoryLocator,
          ...(dependencies.reliabilityStateDirectory === undefined
            ? {}
            : { stateDirectory: dependencies.reliabilityStateDirectory }),
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
          event: {
            eventType: "progress_report_submitted",
            ...(plan.report.agent === undefined ? {} : { agent: plan.report.agent }),
            taskId: plan.taskId,
            semanticRevision: plan.newRevision,
            outcome: "success",
            safeMetadata: { reportCount: 1 },
          },
          enabled: dependencies.reliabilityPersistence,
        })) {
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        }
      }
    });
}
