import { Option, type Command } from "commander";

import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import {
  applyAntigravityDisconnect,
  prepareAntigravityDisconnect,
} from "../../integrations/connectors/antigravity/antigravity-disconnect.js";
import {
  applyCodexDisconnect,
  prepareCodexDisconnect,
} from "../../integrations/connectors/codex/codex-disconnect.js";
import type { ConnectorCommandDependencies } from "../../integrations/connectors/connector-command-dependencies.js";
import {
  connectorSurfaces,
  type ConnectorSurface,
} from "../../integrations/connectors/connector-types.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";

interface DisconnectOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly surface: ConnectorSurface;
}

export function registerDisconnectCommand(
  program: Command,
  dependencies: ConnectorCommandDependencies,
  output: CliOutput,
): void {
  program
    .command("disconnect")
    .description("Preview or remove connector-owned host configuration")
    .argument("<host>", "host connector name")
    .addOption(new Option("--dry-run", "preview removal without writing files").conflicts("yes"))
    .addOption(new Option("--yes", "apply the validated removal plan").conflicts("dryRun"))
    .addOption(
      new Option("--surface <surface>", "host surface")
        .choices([...connectorSurfaces])
        .default("auto"),
    )
    .action(async (host: string, options: DisconnectOptions) => {
      if (host !== "antigravity" && host !== "codex") {
        writeLine(output, `Unsupported connector host: ${host}`);
        throw new CliCommandError(2, "Unsupported connector host");
      }
      writeLine(output, `BriefOnce ${host === "codex" ? "Codex" : "Antigravity"} disconnect`);
      writeLine(output);
      if (host === "antigravity") {
        const plan = await prepareAntigravityDisconnect(dependencies.antigravity, options.surface);
        for (const item of plan.diagnostics)
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        if (!plan.safe) throw new CliCommandError(plan.exitCode, "Disconnect planning failed");
        for (const action of plan.actions) {
          writeLine(output, `  ${action.description}`);
          writeLine(output, `    ${action.target}`);
        }
        writeLine(output);
        if (options.yes !== true) {
          writeLine(
            output,
            options.dryRun === true
              ? "Disconnect dry run complete. No files were changed."
              : "No files were changed. Run again with --yes to remove proven connector content.",
          );
          return;
        }
        if (plan.actions.length === 0) return;
        const result = await applyAntigravityDisconnect(plan, dependencies.antigravity);
        for (const item of result.diagnostics)
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        if (result.exitCode !== 0) throw new CliCommandError(result.exitCode, "Disconnect failed");
      } else {
        const plan = await prepareCodexDisconnect(dependencies.codex, options.surface);
        for (const item of plan.diagnostics)
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        if (!plan.safe) throw new CliCommandError(plan.exitCode, "Disconnect planning failed");
        for (const action of plan.actions) {
          writeLine(output, `  ${action.description}`);
          writeLine(output, `    ${action.target}`);
        }
        writeLine(output);
        if (options.yes !== true) {
          writeLine(
            output,
            options.dryRun === true
              ? "Disconnect dry run complete. No files were changed."
              : "No files were changed. Run again with --yes to remove proven connector content.",
          );
          return;
        }
        if (plan.actions.length === 0) return;
        const result = await applyCodexDisconnect(plan, dependencies.codex);
        for (const item of result.diagnostics)
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        if (result.exitCode !== 0) throw new CliCommandError(result.exitCode, "Disconnect failed");
      }
      writeLine(output, "The shared BriefOnce service was left running.");
    });
}
