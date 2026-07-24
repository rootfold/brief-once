import { Option, type Command } from "commander";

import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import { createMcpStderrLogger } from "../../integrations/mcp/mcp-context.js";
import { runMcpServer, type RunMcpServerInput } from "../../integrations/mcp/run-mcp-server.js";
import { workspaceModes, type WorkspaceMode } from "../../integrations/mcp/workspace-mode.js";
import { serviceModes, type ServiceMode } from "../../integrations/service/service-mode.js";
import { CliCommandError } from "../command-error.js";
import type { CliOutput } from "../output/cli-output.js";

export interface McpCommandDependencies {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly version: string;
  readonly now?: () => Date;
  readonly runServer?: (input: RunMcpServerInput) => Promise<number>;
}

interface McpCommandOptions {
  readonly workspace?: string;
  readonly debug?: boolean;
  readonly service: ServiceMode;
  readonly ensureService?: boolean;
  readonly workspaceMode?: WorkspaceMode;
}

export function registerMcpCommand(
  program: Command,
  dependencies: McpCommandDependencies,
  output: CliOutput,
): void {
  program
    .command("mcp")
    .description("Run the local BriefOnce MCP server over stdio")
    .option("--workspace <path>", "single repository workspace served by this process")
    .addOption(
      new Option("--workspace-mode <mode>", "workspace selection mode").choices([
        ...workspaceModes,
      ]),
    )
    .addOption(
      new Option("--service <mode>", "shared service mode")
        .choices([...serviceModes])
        .default("auto"),
    )
    .option("--ensure-service", "start the shared service when it is not running")
    .option("--debug", "write safe MCP lifecycle diagnostics to stderr")
    .action(async (options: McpCommandOptions, command: Command) => {
      const debug = command.optsWithGlobals<McpCommandOptions>().debug === true;
      const logger = createMcpStderrLogger((text) => output.writeError(text), debug);
      if (options.ensureService === true && options.service === "disabled") {
        output.writeError(
          "Error: --ensure-service requires --service auto or --service required.\n",
        );
        throw new CliCommandError(2, "Invalid MCP service options");
      }
      const exitCode = await (dependencies.runServer ?? runMcpServer)({
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        debug,
        serviceMode: options.service,
        ...(options.ensureService === undefined ? {} : { ensureService: options.ensureService }),
        ...(options.workspaceMode === undefined ? {} : { workspaceMode: options.workspaceMode }),
        version: dependencies.version,
        fileSystem: dependencies.fileSystem,
        gitRepositoryLocator: dependencies.gitRepositoryLocator,
        gitInspector: dependencies.gitInspector,
        logger,
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      });
      if (exitCode !== 0) throw new CliCommandError(exitCode, "BriefOnce MCP server stopped");
    });
}
