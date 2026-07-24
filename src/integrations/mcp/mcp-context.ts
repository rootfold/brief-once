import path from "node:path";

import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import type { AgentFoldMcpSessionRegistry } from "./session-registry.js";
import type { ReliabilityRecorder } from "../reliability/recorder.js";

export interface McpStderrLogger {
  debug(message: string): void;
  error(message: string): void;
}

export interface AgentFoldMcpApplicationContext {
  readonly requestedWorkspace: string;
  readonly repositoryRoot: string;
  readonly version: string;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now: () => Date;
  readonly sessions: AgentFoldMcpSessionRegistry;
  readonly debug: boolean;
  readonly logger: McpStderrLogger;
  readonly reliability?: ReliabilityRecorder;
  readonly reliabilityMode?: "embedded" | "service";
}

export interface CreateMcpApplicationContextInput {
  readonly workspace?: string;
  readonly version: string;
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly sessions: AgentFoldMcpSessionRegistry;
  readonly now?: () => Date;
  readonly debug?: boolean;
  readonly logger: McpStderrLogger;
  readonly reliability?: ReliabilityRecorder;
  readonly reliabilityMode?: "embedded" | "service";
}

export type CreateMcpApplicationContextResult =
  | { readonly status: "success"; readonly context: AgentFoldMcpApplicationContext }
  | { readonly status: "error"; readonly diagnostics: readonly Diagnostic[] };

function startupFailure(message: string, suggestion: string): CreateMcpApplicationContextResult {
  return {
    status: "error",
    diagnostics: [{ code: "AFMCP002", severity: "error", message, suggestion }],
  };
}

export async function createMcpApplicationContext(
  input: CreateMcpApplicationContextInput,
): Promise<CreateMcpApplicationContextResult> {
  let currentDirectory: string;
  try {
    currentDirectory = input.fileSystem.currentWorkingDirectory();
  } catch {
    return startupFailure(
      "The MCP workspace could not be resolved.",
      "Start BriefOnce from an accessible directory or pass --workspace.",
    );
  }

  const requestedWorkspace = path.resolve(currentDirectory, input.workspace ?? ".");
  try {
    if ((await input.fileSystem.entryType(requestedWorkspace)) !== "directory") {
      return startupFailure(
        "The requested MCP workspace is not an accessible directory.",
        "Pass a directory inside the Git repository to --workspace.",
      );
    }
    const realWorkspace = await input.fileSystem.realPath(requestedWorkspace);
    const locatedRoot = await input.gitRepositoryLocator.findRoot(realWorkspace);
    if (locatedRoot === undefined) {
      return startupFailure(
        "The requested MCP workspace is not inside a Git repository.",
        "Choose one repository for this MCP server process.",
      );
    }
    const repositoryRoot = await input.fileSystem.realPath(path.resolve(locatedRoot));
    return {
      status: "success",
      context: {
        requestedWorkspace,
        repositoryRoot,
        version: input.version,
        fileSystem: input.fileSystem,
        gitRepositoryLocator: input.gitRepositoryLocator,
        gitInspector: input.gitInspector,
        now: input.now ?? (() => new Date()),
        sessions: input.sessions,
        debug: input.debug ?? false,
        logger: input.logger,
        ...(input.reliability === undefined ? {} : { reliability: input.reliability }),
        ...(input.reliabilityMode === undefined ? {} : { reliabilityMode: input.reliabilityMode }),
      },
    };
  } catch {
    return startupFailure(
      "The requested MCP workspace could not be inspected safely.",
      "Check repository permissions and the --workspace path.",
    );
  }
}

export function createMcpStderrLogger(
  writeError: (text: string) => void,
  debug: boolean,
): McpStderrLogger {
  return {
    debug(message): void {
      if (debug) writeError(`[agentfold:mcp] ${message}\n`);
    },
    error(message): void {
      writeError(`[agentfold:mcp] ${message}\n`);
    },
  };
}
