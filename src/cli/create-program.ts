import { Command } from "commander";

import type { FileSystem } from "../core/filesystem/filesystem.js";
import type { GitInspector } from "../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../core/git/git-repository-locator.js";
import type { ProcessRunner } from "../core/process/process-runner.js";
import type { AntigravityConnectorDependencies } from "../integrations/connectors/antigravity/antigravity-connector.js";
import type { CodexConnectorDependencies } from "../integrations/connectors/codex/codex-connector.js";
import { packageVersion } from "../package-metadata.js";
import { productBrand, productDescription } from "../product-brand.js";
import { registerCheckpointCommand } from "./commands/checkpoint.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerFinishCommand } from "./commands/finish.js";
import { registerInitCommand } from "./commands/init.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerReportCommand } from "./commands/report.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerStartCommand } from "./commands/start.js";
import { registerServiceCommand } from "./commands/service.js";
import { registerConnectCommand } from "./commands/connect.js";
import { registerDisconnectCommand } from "./commands/disconnect.js";
import { registerVerifyCommand } from "./commands/verify.js";
import { registerReliabilityCommand } from "./commands/reliability.js";
import type { StdinReader } from "./input/stdin-reader.js";
import type { CliOutput } from "./output/cli-output.js";

export interface CreateProgramOptions {
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly processRunner: ProcessRunner;
  readonly stdinReader: StdinReader;
  readonly output: CliOutput;
  readonly now?: () => Date;
  readonly version?: string;
  readonly runMcpServer?: Parameters<typeof registerMcpCommand>[1]["runServer"];
  readonly runService?: Parameters<typeof registerServiceCommand>[1]["runService"];
  readonly connectorOverrides?: Partial<AntigravityConnectorDependencies>;
  readonly codexConnectorOverrides?: Partial<CodexConnectorDependencies>;
  readonly reliabilityStateDirectory?: string;
  readonly reliabilityPersistence?: boolean;
}

export function createProgram(options: CreateProgramOptions): Command {
  const program = new Command();

  program
    .name(productBrand.primaryCommand)
    .description(productDescription)
    .version(options.version ?? packageVersion)
    .option("--debug", "show stack traces for unexpected errors")
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (text) => options.output.write(text),
      writeErr: (text) => options.output.writeError(text),
    })
    .exitOverride()
    .addHelpText("beforeAll", `${productBrand.productName}\n\n${productBrand.tagline}\n\n`)
    .action(() => {
      program.outputHelp();
    });

  registerDoctorCommand(program, options, options.output);
  registerInitCommand(
    program,
    {
      fileSystem: options.fileSystem,
      gitRepositoryLocator: options.gitRepositoryLocator,
      agentfoldVersion: options.version ?? packageVersion,
    },
    options.output,
  );
  registerStartCommand(program, options, options.output);
  registerReportCommand(program, options, options.output);
  registerCheckpointCommand(program, options, options.output);
  registerFinishCommand(program, options, options.output);
  registerResumeCommand(program, options, options.output);
  registerReliabilityCommand(
    program,
    {
      version: options.version ?? packageVersion,
      fileSystem: options.fileSystem,
      gitRepositoryLocator: options.gitRepositoryLocator,
      ...(options.reliabilityStateDirectory === undefined
        ? {}
        : { reliabilityStateDirectory: options.reliabilityStateDirectory }),
      ...(options.now === undefined ? {} : { now: options.now }),
    },
    options.output,
  );
  registerServiceCommand(
    program,
    {
      fileSystem: options.fileSystem,
      gitRepositoryLocator: options.gitRepositoryLocator,
      gitInspector: options.gitInspector,
      version: options.version ?? packageVersion,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.runService === undefined ? {} : { runService: options.runService }),
    },
    options.output,
  );
  registerMcpCommand(
    program,
    {
      fileSystem: options.fileSystem,
      gitRepositoryLocator: options.gitRepositoryLocator,
      gitInspector: options.gitInspector,
      version: options.version ?? packageVersion,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.runMcpServer === undefined ? {} : { runServer: options.runMcpServer }),
    },
    options.output,
  );
  const connectorDependencies: AntigravityConnectorDependencies = {
    fileSystem: options.fileSystem,
    gitRepositoryLocator: options.gitRepositoryLocator,
    processRunner: options.processRunner,
    version: options.version ?? packageVersion,
    ...options.connectorOverrides,
  };
  const codexConnectorDependencies: CodexConnectorDependencies = {
    fileSystem: options.fileSystem,
    gitRepositoryLocator: options.gitRepositoryLocator,
    processRunner: options.processRunner,
    version: options.version ?? packageVersion,
    ...options.codexConnectorOverrides,
  };
  const connectorCommands = {
    antigravity: connectorDependencies,
    codex: codexConnectorDependencies,
  };
  registerConnectCommand(program, connectorCommands, options.output);
  registerVerifyCommand(program, connectorCommands, options.output);
  registerDisconnectCommand(program, connectorCommands, options.output);

  return program;
}
