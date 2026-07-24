import { Option, type Command } from "commander";

import { formatDiagnostic } from "../../core/diagnostics/format-diagnostic.js";
import {
  applyAntigravityConnection,
  prepareAntigravityConnection,
} from "../../integrations/connectors/antigravity/antigravity-connector.js";
import {
  applyCodexConnection,
  prepareCodexConnection,
} from "../../integrations/connectors/codex/codex-connector.js";
import type { ConnectorCommandDependencies } from "../../integrations/connectors/connector-command-dependencies.js";
import {
  connectorHosts,
  connectorSurfaces,
  type ConnectorHost,
  type ConnectorSurface,
} from "../../integrations/connectors/connector-types.js";
import { productBrand } from "../../product-brand.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";
import { writeLine } from "../output/cli-output.js";

interface ConnectOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly surface: ConnectorSurface;
}

function validateHost(host: string, output: CliOutput): asserts host is ConnectorHost {
  if ((connectorHosts as readonly string[]).includes(host)) return;
  writeLine(output, `Unsupported connector host: ${host}`);
  throw new CliCommandError(2, "Unsupported connector host");
}

function writePlan(
  output: CliOutput,
  plan: {
    readonly diagnostics: readonly Parameters<typeof formatDiagnostic>[0][];
    readonly actions: readonly { readonly description: string; readonly target: string }[];
  },
): void {
  for (const item of plan.diagnostics) {
    writeLine(output, formatDiagnostic(item, { color: output.useColor }));
  }
  writeLine(output);
  writeLine(output, "Planned changes");
  if (plan.actions.length === 0) writeLine(output, "  No changes required");
  for (const action of plan.actions) {
    writeLine(output, `  ${action.description}`);
    writeLine(output, `    ${action.target}`);
  }
  writeLine(output);
  writeLine(output, "MCP launch");
  writeLine(
    output,
    `  ${productBrand.primaryCommand} mcp --service required --ensure-service --workspace-mode auto`,
  );
  writeLine(output);
}

export function registerConnectCommand(
  program: Command,
  dependencies: ConnectorCommandDependencies,
  output: CliOutput,
): void {
  program
    .command("connect")
    .description("Preview or install a safe host connector")
    .argument("<host>", "host connector name")
    .addOption(new Option("--dry-run", "preview without writing files").conflicts("yes"))
    .addOption(new Option("--yes", "apply the validated plan").conflicts("dryRun"))
    .addOption(
      new Option("--surface <surface>", "host surface")
        .choices([...connectorSurfaces])
        .default("auto"),
    )
    .action(async (host: string, options: ConnectOptions) => {
      validateHost(host, output);
      writeLine(
        output,
        `${productBrand.productName} ${host === "codex" ? "Codex" : "Antigravity"} connector`,
      );
      writeLine(output);
      if (host === "antigravity") {
        const plan = await prepareAntigravityConnection(dependencies.antigravity, options.surface);
        writePlan(output, plan);
        if (!plan.safe) throw new CliCommandError(plan.exitCode, "Connector planning failed");
        if (options.yes !== true) {
          writeLine(
            output,
            options.dryRun === true
              ? "Dry run complete. No files were changed."
              : "No files were changed. Run again with --yes to apply this plan.",
          );
          return;
        }
        const result = await applyAntigravityConnection(plan, dependencies.antigravity);
        for (const item of result.diagnostics)
          writeLine(output, formatDiagnostic(item, { color: output.useColor }));
        if (result.exitCode !== 0)
          throw new CliCommandError(result.exitCode, "Connector install failed");
        writeLine(output);
        writeLine(
          output,
          `${productBrand.productName} runs locally over stdio and authenticated local IPC.`,
        );
        writeLine(output, "In Antigravity, refresh Installed MCP Servers and inspect `agentfold`.");
        return;
      }
      const plan = await prepareCodexConnection(dependencies.codex, options.surface);
      writePlan(output, plan);
      if (!plan.safe) throw new CliCommandError(plan.exitCode, "Connector planning failed");
      if (options.yes !== true) {
        writeLine(
          output,
          options.dryRun === true
            ? "Dry run complete. No files were changed."
            : "No files were changed. Run again with --yes to apply this plan.",
        );
        return;
      }
      const result = await applyCodexConnection(plan, dependencies.codex);
      for (const item of result.diagnostics)
        writeLine(output, formatDiagnostic(item, { color: output.useColor }));
      if (result.exitCode !== 0)
        throw new CliCommandError(result.exitCode, "Connector install failed");
      writeLine(output);
      writeLine(
        output,
        `${productBrand.productName} runs locally over stdio and authenticated local IPC.`,
      );
      writeLine(
        output,
        "Restart Codex or its IDE extension, then confirm `agentfold` is enabled in MCP servers.",
      );
    });
}
