import type { Command } from "commander";

import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import { AtomicTextFileWriter } from "../../core/filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { commitResumeOutput } from "../../core/resume/output-path.js";
import { prepareResume } from "../../core/resume/prepare-resume.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { recordCliReliability } from "../../integrations/reliability/record-cli-event.js";

export interface ResumeDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly reliabilityStateDirectory?: string;
  readonly reliabilityPersistence?: boolean;
}

interface ResumeOptions {
  readonly for?: string;
  readonly format?: string;
  readonly checkpoint?: string;
  readonly output?: string;
}

function writeDiagnostics(
  output: CliOutput,
  diagnostics: readonly Parameters<typeof formatDiagnostic>[0][],
): void {
  for (const diagnostic of diagnostics) {
    output.writeError(`${formatDiagnostic(diagnostic, { color: output.useColor })}\n`);
  }
}

export function registerResumeCommand(
  program: Command,
  dependencies: ResumeDependencies,
  output: CliOutput,
): void {
  program
    .command("resume")
    .description("Render a bounded continuation packet from an immutable checkpoint")
    .option("--for <target>", "target hint: codex, antigravity, claude, gemini, or generic")
    .option("--format <format>", "output format: markdown or json", "markdown")
    .option("--checkpoint <checkpoint>", "select CP-NNN or a complete task checkpoint identity")
    .option("--output <path>", "atomically create a repository-relative output file")
    .action(async (options: ResumeOptions) => {
      const plan = await prepareResume(dependencies, {
        ...(options.for === undefined ? {} : { target: options.for }),
        ...(options.format === undefined ? {} : { format: options.format }),
        ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
        ...(options.output === undefined ? {} : { output: options.output }),
      });
      writeDiagnostics(output, plan.diagnostics);
      if (plan.status !== "ready") {
        throw new CliCommandError(plan.exitCode, "AgentFold resume could not proceed");
      }

      if (plan.output === undefined) {
        output.write(plan.content);
      } else {
        const result = await commitResumeOutput(
          new AtomicTextFileWriter(dependencies.fileSystem),
          plan.output.destination,
          plan.output.relativePath,
          plan.content,
        );
        if (result.status === "error") {
          writeDiagnostics(output, result.diagnostics);
          throw new CliCommandError(
            result.exitCode,
            "AgentFold resume output could not be created",
          );
        }
        for (const diagnostic of result.diagnostics) {
          output.write(`${formatDiagnostic(diagnostic, { color: output.useColor })}\n`);
        }
      }
      const semanticFreshness =
        plan.packet.semanticState.freshness === "new"
          ? "current"
          : plan.packet.semanticState.freshness === "none"
            ? "absent"
            : "reused";
      for (const eventType of [
        "resume_packet_requested",
        `resume_packet_${semanticFreshness}`,
      ] as const) {
        for (const item of await recordCliReliability({
          repositoryRoot: plan.repositoryRoot,
          fileSystem: dependencies.fileSystem,
          gitRepositoryLocator: dependencies.gitRepositoryLocator,
          ...(dependencies.reliabilityStateDirectory === undefined
            ? {}
            : { stateDirectory: dependencies.reliabilityStateDirectory }),
          event: {
            eventType,
            taskId: plan.packet.task.taskId,
            checkpointId: plan.packet.task.checkpointId,
            semanticRevision: plan.packet.semanticState.revision,
            semanticFreshness,
            outcome: "success",
          },
          enabled: dependencies.reliabilityPersistence,
        })) {
          output.writeError(`${formatDiagnostic(item, { color: output.useColor })}\n`);
        }
      }
    });
}
