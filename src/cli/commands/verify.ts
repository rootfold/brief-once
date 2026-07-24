import type { Command } from "commander";

import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import { verifyAntigravityConnection } from "../../integrations/connectors/antigravity/antigravity-verification.js";
import { verifyCodexConnection } from "../../integrations/connectors/codex/codex-verification.js";
import type { ConnectorCommandDependencies } from "../../integrations/connectors/connector-command-dependencies.js";
import { resolveAgentFoldLaunchDescriptor } from "../../integrations/connectors/executable-descriptor.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";

export function registerVerifyCommand(
  program: Command,
  dependencies: ConnectorCommandDependencies,
  output: CliOutput,
): void {
  program
    .command("verify")
    .description("Verify a host connector without modifying host configuration")
    .argument("<host>", "host connector name")
    .action(async (host: string) => {
      if (host !== "antigravity" && host !== "codex") {
        writeLine(output, `Unsupported connector host: ${host}`);
        throw new CliCommandError(2, "Unsupported connector host");
      }
      const current = host === "codex" ? dependencies.codex : dependencies.antigravity;
      const resolveDescriptor = () =>
        (current.resolveLaunchDescriptor ?? resolveAgentFoldLaunchDescriptor)({
          fileSystem: current.fileSystem,
          processRunner: current.processRunner,
          ...(current.executable === undefined ? {} : { executable: current.executable }),
          ...(current.modulePath === undefined ? {} : { modulePath: current.modulePath }),
          ...(current.allowTemporaryLaunchPath === undefined
            ? {}
            : { allowTemporaryPath: current.allowTemporaryLaunchPath }),
        });
      const result =
        host === "codex"
          ? await (dependencies.codex.verifyConnection ?? verifyCodexConnection)({
              fileSystem: dependencies.codex.fileSystem,
              gitRepositoryLocator: dependencies.codex.gitRepositoryLocator,
              processRunner: dependencies.codex.processRunner,
              version: dependencies.codex.version,
              ...(dependencies.codex.platform === undefined
                ? {}
                : { platform: dependencies.codex.platform }),
              ...(dependencies.codex.stateDirectory === undefined
                ? {}
                : { stateDirectory: dependencies.codex.stateDirectory }),
              ...(dependencies.codex.runtimeDirectory === undefined
                ? {}
                : { runtimeDirectory: dependencies.codex.runtimeDirectory }),
              ...(dependencies.codex.codexHome === undefined
                ? {}
                : { codexHome: dependencies.codex.codexHome }),
              resolveDescriptor,
              ...(dependencies.codex.launchMcp === undefined
                ? {}
                : { launchMcp: dependencies.codex.launchMcp }),
              ...(dependencies.codex.environment === undefined
                ? {}
                : { environment: dependencies.codex.environment }),
            })
          : await (dependencies.antigravity.verifyConnection ?? verifyAntigravityConnection)({
              fileSystem: dependencies.antigravity.fileSystem,
              gitRepositoryLocator: dependencies.antigravity.gitRepositoryLocator,
              version: dependencies.antigravity.version,
              ...(dependencies.antigravity.platform === undefined
                ? {}
                : { platform: dependencies.antigravity.platform }),
              ...(dependencies.antigravity.stateDirectory === undefined
                ? {}
                : { stateDirectory: dependencies.antigravity.stateDirectory }),
              ...(dependencies.antigravity.runtimeDirectory === undefined
                ? {}
                : { runtimeDirectory: dependencies.antigravity.runtimeDirectory }),
              resolveDescriptor,
              ...(dependencies.antigravity.launchMcp === undefined
                ? {}
                : { launchMcp: dependencies.antigravity.launchMcp }),
              ...(dependencies.antigravity.environment === undefined
                ? {}
                : { environment: dependencies.antigravity.environment }),
            });
      writeLine(output, `BriefOnce ${host === "codex" ? "Codex" : "Antigravity"} verification`);
      writeLine(output);
      for (const item of result.diagnostics)
        writeLine(output, formatDiagnostic(item, { color: output.useColor }));
      if (!result.valid)
        throw new CliCommandError(result.exitCode, "Connector verification failed");
      writeLine(output, `Tools: ${result.toolsAvailable}`);
      writeLine(output, `Shared service: ${result.serviceAvailable ? "available" : "unavailable"}`);
      writeLine(output);
      writeLine(
        output,
        host === "codex"
          ? "Restart Codex or its IDE extension and confirm `agentfold` is enabled in MCP servers."
          : "Refresh Installed MCP Servers in Antigravity and confirm `agentfold` appears.",
      );
    });
}
