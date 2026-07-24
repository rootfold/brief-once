import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { containsSecretLikeText } from "../../core/reports/redact-secrets.js";
import type { AgentFoldMcpApplicationContext } from "./mcp-context.js";
import {
  safeDebugMessage,
  safeUnexpectedDiagnostic,
  sanitizeMcpDiagnostics,
} from "./mcp-diagnostics.js";
import { createMcpToolHandlers } from "./mcp-tools.js";
import {
  mcpFailure,
  mcpResultSchema,
  toCallToolResult,
  type AgentFoldMcpResult,
} from "./mcp-response.js";
import { agentFoldMcpToolNames } from "./tool-names.js";
import {
  beginTaskInputSchema,
  closeSessionInputSchema,
  createCheckpointInputSchema,
  finishTaskInputSchema,
  getContextInputSchema,
  getResumePacketInputSchema,
  getStatusInputSchema,
  openSessionInputSchema,
  reportProgressInputSchema,
} from "./tool-schemas.js";

export const agentFoldMcpInstructions = [
  "Use BriefOnce for substantive repository-changing work.",
  "BriefOnce currently exposes compatibility MCP tools using the agentfold_* namespace.",
  "Call agentfold_open_session before repository work.",
  "Continue an active task only when its continuation packet matches the user's request.",
  "Call agentfold_begin_task only for clearly requested new work when no active task exists.",
  "Report meaningful progress during unfinished work.",
  "Call agentfold_finish_task only when the requested scope is complete, blockers are resolved, and final validation is honestly reported.",
  "Call agentfold_close_session with checkpointing when work is paused, incomplete, blocked, or handed off.",
  "After finishing, begin a new task for the next substantive request in the same open session.",
  "Reports contain concise engineering conclusions, never private chain of thought, secrets, or conversations.",
  "Never discard uncommitted work, create commits, or push unless the user separately requests it.",
].join(" ");

export interface CreateAgentFoldMcpServerInput {
  readonly context?: AgentFoldMcpApplicationContext;
  readonly version?: string;
  readonly logger?: AgentFoldMcpApplicationContext["logger"];
  readonly repositoryRoot?: () => string | undefined;
  readonly handlers?: ReturnType<typeof createMcpToolHandlers>;
}

function sanitizeValue(value: unknown, repositoryRoot: string): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(repositoryRoot, ".")
      .replaceAll(repositoryRoot.replaceAll("\\", "/"), ".");
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, repositoryRoot));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, repositoryRoot)]),
    );
  }
  return value;
}

function safeResult(
  repositoryRoot: string | undefined,
  result: AgentFoldMcpResult,
): AgentFoldMcpResult {
  const sanitized: AgentFoldMcpResult = {
    ...result,
    ...(result.data === undefined
      ? {}
      : {
          data:
            repositoryRoot === undefined ? result.data : sanitizeValue(result.data, repositoryRoot),
        }),
    diagnostics:
      repositoryRoot === undefined
        ? result.diagnostics
        : sanitizeMcpDiagnostics(result.diagnostics, repositoryRoot),
  };
  if (containsSecretLikeText(JSON.stringify(sanitized))) {
    return mcpFailure(result.operation, "unsafe_output", [
      {
        code: "AFMCP014",
        severity: "error",
        message: "A secret-like value was withheld from the MCP response.",
      },
    ]);
  }
  return sanitized;
}

export function createAgentFoldMcpServer(input: CreateAgentFoldMcpServerInput): McpServer {
  const context = input.context;
  const version = context?.version ?? input.version;
  const logger = context?.logger ?? input.logger;
  if (version === undefined || logger === undefined) {
    throw new Error("MCP server version and logger are required.");
  }
  const handlers =
    input.handlers ?? (context === undefined ? undefined : createMcpToolHandlers(context));
  if (handlers === undefined) throw new Error("MCP tool handlers are required.");
  const repositoryRoot = input.repositoryRoot ?? (() => context?.repositoryRoot);
  const server = new McpServer(
    { name: "agentfold", version },
    { instructions: agentFoldMcpInstructions },
  );
  const invoke = async (
    handler: (value: unknown) => Promise<AgentFoldMcpResult>,
    value: unknown,
  ) => {
    try {
      return toCallToolResult(safeResult(repositoryRoot(), await handler(value)));
    } catch (error: unknown) {
      logger.debug(`Tool failure: ${safeDebugMessage(error, repositoryRoot())}`);
      return toCallToolResult(
        mcpFailure("agentfold_mcp", "unexpected_failure", [safeUnexpectedDiagnostic()]),
      );
    }
  };
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
  const stateAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  } as const;

  server.registerTool(
    agentFoldMcpToolNames.getStatus,
    {
      title: "Get BriefOnce status",
      description: "Read initialization, active task, checkpoint, and next-operation status.",
      inputSchema: getStatusInputSchema,
      outputSchema: mcpResultSchema,
      annotations: readOnlyAnnotations,
    },
    (value) => invoke(handlers.getStatus, value),
  );
  server.registerTool(
    agentFoldMcpToolNames.getContext,
    {
      title: "Get BriefOnce context",
      description: "Read bounded canonical project context without source files.",
      inputSchema: getContextInputSchema,
      outputSchema: mcpResultSchema,
      annotations: readOnlyAnnotations,
    },
    (value) => invoke(handlers.getContext, value),
  );
  server.registerTool(
    agentFoldMcpToolNames.openSession,
    {
      title: "Open BriefOnce session",
      description: "Open an in-memory session and obtain task or continuation status.",
      inputSchema: openSessionInputSchema,
      outputSchema: mcpResultSchema,
      annotations: { ...readOnlyAnnotations, idempotentHint: false },
    },
    (value) => invoke(handlers.openSession, value),
  );
  server.registerTool(
    agentFoldMcpToolNames.beginTask,
    {
      title: "Begin BriefOnce task",
      description: "Create validated active task state for an open MCP session.",
      inputSchema: beginTaskInputSchema,
      outputSchema: mcpResultSchema,
      annotations: stateAnnotations,
    },
    (value) => invoke(handlers.beginTask, value),
  );
  server.registerTool(
    agentFoldMcpToolNames.reportProgress,
    {
      title: "Report BriefOnce progress",
      description: "Merge validated semantic engineering progress into active task state.",
      inputSchema: reportProgressInputSchema,
      outputSchema: mcpResultSchema,
      annotations: stateAnnotations,
    },
    (value) => invoke(handlers.reportProgress, value),
  );
  server.registerTool(
    agentFoldMcpToolNames.createCheckpoint,
    {
      title: "Create BriefOnce checkpoint",
      description: "Capture bounded Git facts and semantic state in immutable history.",
      inputSchema: createCheckpointInputSchema,
      outputSchema: mcpResultSchema,
      annotations: stateAnnotations,
    },
    (value) => invoke(handlers.createCheckpoint, value),
  );
  server.registerTool(
    agentFoldMcpToolNames.finishTask,
    {
      title: "Finish BriefOnce task",
      description: "Create a final checkpoint, archive the completed task, and clear active state.",
      inputSchema: finishTaskInputSchema,
      outputSchema: mcpResultSchema,
      annotations: stateAnnotations,
    },
    (value) => invoke(handlers.finishTask, value),
  );
  server.registerTool(
    agentFoldMcpToolNames.getResumePacket,
    {
      title: "Get BriefOnce resume packet",
      description: "Read a bounded continuation packet from immutable checkpoint history.",
      inputSchema: getResumePacketInputSchema,
      outputSchema: mcpResultSchema,
      annotations: readOnlyAnnotations,
    },
    (value) => invoke(handlers.getResumePacket, value),
  );
  server.registerTool(
    agentFoldMcpToolNames.closeSession,
    {
      title: "Close BriefOnce session",
      description: "Optionally report, checkpoint, resume, then close the in-memory session.",
      inputSchema: closeSessionInputSchema,
      outputSchema: mcpResultSchema,
      annotations: stateAnnotations,
    },
    (value) => invoke(handlers.closeSession, value),
  );

  return server;
}
