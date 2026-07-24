import type { z } from "zod";

import type { AgentFoldServiceClient } from "../service/service-client.js";
import { McpHeartbeatManager } from "./heartbeat-manager.js";
import type { McpStderrLogger } from "./mcp-context.js";
import type { AgentFoldMcpToolHandlers } from "./mcp-tools.js";
import { mcpFailure, type AgentFoldMcpResult } from "./mcp-response.js";
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

export interface AgentFoldMcpServiceBridge {
  readonly handlers: AgentFoldMcpToolHandlers;
  shutdown(): Promise<void>;
}

export interface CreateMcpServiceBridgeInput {
  readonly workspace: string;
  readonly client: AgentFoldServiceClient;
  readonly logger: McpStderrLogger;
  readonly heartbeatManager?: McpHeartbeatManager;
}

function invalidInput(operation: string, error: z.ZodError): AgentFoldMcpResult {
  return mcpFailure(operation, "invalid_input", [
    {
      code: "AFMCP013",
      severity: "error",
      message: "The MCP tool input did not match the required schema.",
      suggestion: error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; "),
    },
  ]);
}

export function createMcpServiceBridge(
  input: CreateMcpServiceBridgeInput,
): AgentFoldMcpServiceBridge {
  const heartbeats =
    input.heartbeatManager ??
    new McpHeartbeatManager({ client: input.client, logger: input.logger });
  const invoke = async <Schema extends z.ZodType>(
    operation: string,
    schema: Schema,
    value: unknown,
    handler: (parsed: z.output<Schema>) => Promise<AgentFoldMcpResult>,
  ): Promise<AgentFoldMcpResult> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return invalidInput(operation, parsed.error);
    try {
      return await handler(parsed.data);
    } catch (error: unknown) {
      input.logger.debug(`Service operation ${operation} failed safely.`);
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "AFSV013";
      return mcpFailure(operation, "service_unavailable", [
        {
          code,
          severity: "error",
          message: "The shared BriefOnce service became unavailable during the tool call.",
          suggestion: "Restart b1 service, restart this MCP process, and retry.",
        },
      ]);
    }
  };

  const handlers: AgentFoldMcpToolHandlers = {
    getStatus: (value) =>
      invoke(agentFoldMcpToolNames.getStatus, getStatusInputSchema, value, () =>
        input.client.getStatus(input.workspace),
      ),
    getContext: (value) =>
      invoke(agentFoldMcpToolNames.getContext, getContextInputSchema, value, (parsed) =>
        input.client.getContext(input.workspace, parsed),
      ),
    openSession: (value) =>
      invoke(agentFoldMcpToolNames.openSession, openSessionInputSchema, value, async (parsed) => {
        const result = await input.client.openSession(input.workspace, parsed);
        const data =
          typeof result.data === "object" && result.data !== null ? result.data : undefined;
        const sessionId = data !== undefined && "sessionId" in data ? data.sessionId : undefined;
        const interval =
          data !== undefined && "heartbeatIntervalSeconds" in data
            ? data.heartbeatIntervalSeconds
            : undefined;
        if (result.ok && typeof sessionId === "string") {
          heartbeats.start(sessionId, typeof interval === "number" ? interval : 20);
        }
        return result;
      }),
    beginTask: (value) =>
      invoke(agentFoldMcpToolNames.beginTask, beginTaskInputSchema, value, (parsed) =>
        input.client.beginTask(parsed),
      ),
    reportProgress: (value) =>
      invoke(agentFoldMcpToolNames.reportProgress, reportProgressInputSchema, value, (parsed) =>
        input.client.reportProgress(parsed),
      ),
    createCheckpoint: (value) =>
      invoke(agentFoldMcpToolNames.createCheckpoint, createCheckpointInputSchema, value, (parsed) =>
        input.client.createCheckpoint(parsed),
      ),
    finishTask: (value) =>
      invoke(agentFoldMcpToolNames.finishTask, finishTaskInputSchema, value, (parsed) =>
        input.client.finishTask(parsed),
      ),
    getResumePacket: (value) =>
      invoke(agentFoldMcpToolNames.getResumePacket, getResumePacketInputSchema, value, (parsed) =>
        input.client.getResumePacket(parsed),
      ),
    closeSession: (value) =>
      invoke(agentFoldMcpToolNames.closeSession, closeSessionInputSchema, value, async (parsed) => {
        const result = await input.client.closeSession(parsed);
        if (result.ok) heartbeats.stop(parsed.sessionId);
        return result;
      }),
  };
  return { handlers, shutdown: () => heartbeats.shutdown() };
}
