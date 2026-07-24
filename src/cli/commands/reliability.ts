import type { Command } from "commander";
import { z } from "zod";

import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { reliabilityHosts, type ReliabilityHost } from "../../core/reliability/event-schema.js";
import type { ReliabilityReport } from "../../core/reliability/report-schema.js";
import { checkAgentFoldServiceAvailability } from "../../integrations/service/service-client.js";
import { loadReliabilityReport } from "../../integrations/reliability/load-report.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";

export interface ReliabilityCommandDependencies {
  readonly version: string;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly reliabilityStateDirectory?: string;
  readonly now?: () => Date;
  readonly inspectService?: typeof checkAgentFoldServiceAvailability;
}

interface ReliabilityOptions {
  readonly host?: string;
  readonly task?: string;
  readonly session?: string;
  readonly limit?: string;
  readonly json?: boolean;
  readonly includeEvents?: boolean;
}

const taskIdSchema = z.string().regex(/^AF-\d{8}-\d{3}$/u);
const sessionIdSchema = z.string().trim().min(1).max(200);
const limitSchema = z.coerce.number().int().min(1).max(1_000);

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function renderHuman(output: CliOutput, report: ReliabilityReport): void {
  writeLine(output, "AgentFold reliability");
  writeLine(output);
  if (report.currentTask !== undefined) {
    writeLine(output, "Current task");
    writeLine(output, `  ${report.currentTask.taskId} — ${report.currentTask.title}`);
    writeLine(output);
  } else if (report.latestCompletedTask !== undefined) {
    writeLine(output, "Latest completed task");
    writeLine(
      output,
      `  ${report.latestCompletedTask.taskId} — ${report.latestCompletedTask.title}`,
    );
    writeLine(output);
  }
  if (report.hosts.length === 0) {
    writeLine(output, "No AgentFold lifecycle activity has been recorded for this repository.");
  }
  for (const host of report.hosts) {
    writeLine(output, titleCase(host.host));
    writeLine(output, `  Observed sessions: ${host.observedSessions}`);
    writeLine(output, `  Normal closures: ${host.normalClosures}`);
    writeLine(output, `  Progress reports: ${host.progressReports}`);
    writeLine(output, `  Checkpoints: ${host.checkpoints}`);
    if (host.interruptedSessions > 0) {
      writeLine(output, `  Interrupted sessions: ${host.interruptedSessions}`);
    }
    if (host.recoveryCheckpoints > 0) {
      writeLine(output, `  Recovery checkpoints: ${host.recoveryCheckpoints}`);
    }
    writeLine(
      output,
      `  Observed lifecycle completion: ${
        host.observedLifecycleCompletionPercent === null
          ? "unknown"
          : `${host.observedLifecycleCompletionPercent}%`
      }`,
    );
    writeLine(output);
  }
  writeLine(output, "Continuity quality");
  writeLine(output, `  ${titleCase(report.continuityQuality)}`);
  writeLine(output);
  writeLine(output, "Semantic freshness");
  writeLine(output, `  ${titleCase(report.semanticFreshness)}`);
  writeLine(output);
  writeLine(output, `Recovery events: ${report.totals.recoveryCheckpoints}`);
  writeLine(output, `Service: ${report.serviceAvailability}`);
  if (report.warnings.length > 0) {
    writeLine(output);
    writeLine(output, "Warnings");
    for (const warning of report.warnings) {
      writeLine(output, `  ${warning.code}: ${warning.message}`);
    }
  }
  if (report.events !== undefined && report.events.length > 0) {
    writeLine(output);
    writeLine(output, "Recent events");
    for (const event of report.events) {
      writeLine(
        output,
        `  ${event.sequence}. ${event.eventType} — ${event.outcome}${
          event.host === undefined ? "" : ` (${event.host})`
        }`,
      );
    }
  }
}

export function registerReliabilityCommand(
  program: Command,
  dependencies: ReliabilityCommandDependencies,
  output: CliOutput,
): void {
  program
    .command("reliability")
    .description("Inspect read-only AgentFold lifecycle reliability history")
    .option("--host <host>", `filter by host: ${reliabilityHosts.join(", ")}`)
    .option("--task <task-id>", "filter by AgentFold task identifier")
    .option("--session <session-id>", "filter by observed session identifier")
    .option("--limit <number>", "maximum recent events to analyze", "100")
    .option("--json", "emit stable JSON")
    .option("--include-events", "include safe summarized lifecycle events")
    .action(async (options: ReliabilityOptions) => {
      const host =
        options.host === undefined ? undefined : z.enum(reliabilityHosts).safeParse(options.host);
      const task = options.task === undefined ? undefined : taskIdSchema.safeParse(options.task);
      const session =
        options.session === undefined ? undefined : sessionIdSchema.safeParse(options.session);
      const limit = limitSchema.safeParse(options.limit ?? "100");
      if (
        host?.success === false ||
        task?.success === false ||
        session?.success === false ||
        !limit.success
      ) {
        const message =
          host?.success === false
            ? "Unknown reliability host filter."
            : "The reliability task, session, or limit filter is invalid.";
        writeLine(
          output,
          formatDiagnostic(
            {
              code: host?.success === false ? "AFREL016" : "AFREL017",
              severity: "error",
              message,
            },
            { color: output.useColor },
          ),
        );
        throw new CliCommandError(2, message);
      }
      const service = await (dependencies.inspectService ?? checkAgentFoldServiceAvailability)({
        fileSystem: dependencies.fileSystem,
        clientVersion: dependencies.version,
      });
      const result = await loadReliabilityReport({
        fileSystem: dependencies.fileSystem,
        gitRepositoryLocator: dependencies.gitRepositoryLocator,
        ...(dependencies.reliabilityStateDirectory === undefined
          ? {}
          : { stateDirectory: dependencies.reliabilityStateDirectory }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(host?.success === true ? { host: host.data as ReliabilityHost } : {}),
        ...(task?.success === true ? { taskId: task.data } : {}),
        ...(session?.success === true ? { sessionId: session.data } : {}),
        limit: limit.data,
        includeEvents: options.includeEvents ?? false,
        serviceAvailability: service.available ? "running" : "stopped",
      });
      if (result.status === "error") {
        for (const item of result.diagnostics) {
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        }
        throw new CliCommandError(result.exitCode, "Reliability inspection failed");
      }
      if (options.json === true) {
        output.write(`${JSON.stringify(result.report, undefined, 2)}\n`);
      } else {
        renderHuman(output, result.report);
        for (const item of result.diagnostics) {
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        }
      }
    });
}
