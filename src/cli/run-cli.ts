import process from "node:process";

import { CommanderError } from "commander";

import { NodeFileSystem } from "../core/filesystem/node-filesystem.js";
import { CommandGitInspector } from "../core/git/git-inspector.js";
import { FilesystemGitRepositoryLocator } from "../core/git/filesystem-git-repository-locator.js";
import { NodeProcessRunner } from "../core/process/node-process-runner.js";
import { CliCommandError } from "./command-error.js";
import { createProgram, type CreateProgramOptions } from "./create-program.js";
import { NodeStdinReader } from "./input/node-stdin-reader.js";
import { NodeCliOutput } from "./output/node-cli-output.js";

export type RunCliOptions = Partial<CreateProgramOptions>;

function defaultOptions(options: RunCliOptions): CreateProgramOptions {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const processRunner = options.processRunner ?? new NodeProcessRunner();

  return {
    fileSystem,
    gitRepositoryLocator:
      options.gitRepositoryLocator ?? new FilesystemGitRepositoryLocator(fileSystem),
    gitInspector: options.gitInspector ?? new CommandGitInspector(processRunner),
    processRunner,
    stdinReader: options.stdinReader ?? new NodeStdinReader(),
    output: options.output ?? new NodeCliOutput(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.runMcpServer === undefined ? {} : { runMcpServer: options.runMcpServer }),
    ...(options.runService === undefined ? {} : { runService: options.runService }),
    ...(options.connectorOverrides === undefined
      ? {}
      : { connectorOverrides: options.connectorOverrides }),
    ...(options.codexConnectorOverrides === undefined
      ? {}
      : { codexConnectorOverrides: options.codexConnectorOverrides }),
    ...(options.reliabilityStateDirectory === undefined
      ? {}
      : { reliabilityStateDirectory: options.reliabilityStateDirectory }),
    reliabilityPersistence: options.reliabilityPersistence ?? options.fileSystem === undefined,
  };
}

export async function runCli(
  arguments_: readonly string[] = process.argv,
  options: RunCliOptions = {},
): Promise<number> {
  const resolvedOptions = defaultOptions(options);
  const program = createProgram(resolvedOptions);

  try {
    await program.parseAsync([...arguments_]);
    return 0;
  } catch (error: unknown) {
    if (error instanceof CliCommandError) {
      return error.exitCode;
    }

    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    resolvedOptions.output.writeError(`Error: ${message}\n`);

    if (program.opts<{ debug?: boolean }>().debug === true && error instanceof Error) {
      resolvedOptions.output.writeError(`${error.stack ?? error.message}\n`);
    }

    return 1;
  }
}
