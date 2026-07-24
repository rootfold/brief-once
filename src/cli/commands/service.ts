import type { Command } from "commander";

import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { createMcpStderrLogger } from "../../integrations/mcp/mcp-context.js";
import {
  inspectAgentFoldService,
  startAgentFoldService,
  stopAgentFoldService,
} from "../../integrations/service/service-lifecycle.js";
import { runAgentFoldService } from "../../integrations/service/run-service.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";

export interface ServiceCommandDependencies {
  readonly version: string;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now?: () => Date;
  readonly runService?: typeof runAgentFoldService;
  readonly startService?: typeof startAgentFoldService;
  readonly inspectService?: typeof inspectAgentFoldService;
  readonly stopService?: typeof stopAgentFoldService;
}

interface ServiceRunOptions {
  readonly debug?: boolean;
}

function printDiagnostics(
  output: CliOutput,
  diagnostics: readonly Parameters<typeof formatDiagnostic>[0][],
): void {
  for (const diagnostic of diagnostics) {
    writeLine(output, formatDiagnostic(diagnostic, { color: output.useColor }));
  }
}

export function registerServiceCommand(
  program: Command,
  dependencies: ServiceCommandDependencies,
  output: CliOutput,
): void {
  const service = program
    .command("service")
    .description("Manage the shared local AgentFold service");

  service
    .command("run")
    .description("Run the shared AgentFold service in the foreground")
    .option("--debug", "write safe service lifecycle diagnostics to stderr")
    .action(async (_options: ServiceRunOptions, command: Command) => {
      const debug = command.optsWithGlobals<ServiceRunOptions>().debug === true;
      const exitCode = await (dependencies.runService ?? runAgentFoldService)({
        version: dependencies.version,
        fileSystem: dependencies.fileSystem,
        gitRepositoryLocator: dependencies.gitRepositoryLocator,
        gitInspector: dependencies.gitInspector,
        logger: createMcpStderrLogger((text) => output.writeError(text), debug),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      });
      if (exitCode !== 0) throw new CliCommandError(exitCode, "AgentFold service stopped");
    });

  service
    .command("start")
    .description("Start the shared AgentFold service in the background")
    .action(async () => {
      const result = await (dependencies.startService ?? startAgentFoldService)({
        fileSystem: dependencies.fileSystem,
        version: dependencies.version,
      });
      printDiagnostics(output, result.diagnostics);
      if (result.exitCode !== 0)
        throw new CliCommandError(result.exitCode, "AgentFold service could not start");
    });

  service
    .command("status")
    .description("Inspect the shared AgentFold service")
    .action(async () => {
      const result = await (dependencies.inspectService ?? inspectAgentFoldService)({
        fileSystem: dependencies.fileSystem,
        version: dependencies.version,
      });
      printDiagnostics(output, result.diagnostics);
      if ("serviceStatus" in result && result.serviceStatus !== undefined) {
        const status = result.serviceStatus;
        writeLine(output, `Running: ${status.running ? "yes" : "no"}`);
        writeLine(output, `Version: ${status.serviceVersion ?? "unknown"}`);
        writeLine(output, `Process ID: ${status.processId ?? "unknown"}`);
        writeLine(output, `Started: ${status.startedAt ?? "unknown"}`);
        writeLine(output, `Transport: ${status.endpointKind ?? "unknown"}`);
        writeLine(output, `Repositories: ${status.registeredRepositoryCount}`);
        writeLine(output, `Open sessions: ${status.openSessionCount}`);
        writeLine(output, `Stale/recovery sessions: ${status.staleOrRecoveryPendingSessionCount}`);
        writeLine(output, `Interrupted sessions: ${status.interruptedSessionCount}`);
        writeLine(output, `Recovery pending: ${status.recoveryPendingSessionCount}`);
        writeLine(output, `Recent recovery failures: ${status.recentRecoveryFailureCount}`);
        writeLine(
          output,
          `Reliability persistence: ${
            status.reliabilityPersistenceEnabled ? "enabled" : "disabled"
          }`,
        );
        writeLine(output, `Automation: ${status.automationEnabled ? "enabled" : "disabled"}`);
      }
      if (result.exitCode !== 0)
        throw new CliCommandError(result.exitCode, "AgentFold service status failed");
    });

  service
    .command("stop")
    .description("Stop the shared AgentFold service gracefully")
    .action(async () => {
      const result = await (dependencies.stopService ?? stopAgentFoldService)({
        fileSystem: dependencies.fileSystem,
        version: dependencies.version,
      });
      printDiagnostics(output, result.diagnostics);
      if (result.exitCode !== 0)
        throw new CliCommandError(result.exitCode, "AgentFold service could not stop");
    });
}
