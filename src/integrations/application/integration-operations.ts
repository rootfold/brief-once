import type { AgentFoldMcpApplicationContext } from "../mcp/mcp-context.js";
import type { AgentFoldMcpResult } from "../mcp/mcp-response.js";
import { beginTask } from "../mcp/tools/begin-task.js";
import { closeSession } from "../mcp/tools/close-session.js";
import { createCheckpoint } from "../mcp/tools/create-checkpoint.js";
import { getContext } from "../mcp/tools/get-context.js";
import { finishTask } from "../mcp/tools/finish-task.js";
import { getResumePacket } from "../mcp/tools/get-resume-packet.js";
import { getStatus } from "../mcp/tools/get-status.js";
import { openSession } from "../mcp/tools/open-session.js";
import { reportProgress } from "../mcp/tools/report-progress.js";
import { observeIntegrationOperation } from "../reliability/observe-operation.js";

/**
 * Host-neutral application operations shared by embedded MCP and the local
 * service. The functions delegate to the validated core prepare/commit
 * boundaries; transports never call CLI commands or parse terminal output.
 */
export interface AgentFoldIntegrationOperations {
  readonly getStatus: (input: unknown) => Promise<AgentFoldMcpResult>;
  readonly getContext: (input: unknown) => Promise<AgentFoldMcpResult>;
  readonly openSession: (input: unknown) => Promise<AgentFoldMcpResult>;
  readonly beginTask: (input: unknown) => Promise<AgentFoldMcpResult>;
  readonly reportProgress: (input: unknown) => Promise<AgentFoldMcpResult>;
  readonly createCheckpoint: (input: unknown) => Promise<AgentFoldMcpResult>;
  readonly finishTask: (input: unknown) => Promise<AgentFoldMcpResult>;
  readonly getResumePacket: (input: unknown) => Promise<AgentFoldMcpResult>;
  readonly closeSession: (input: unknown) => Promise<AgentFoldMcpResult>;
}

export function createAgentFoldIntegrationOperations(
  context: AgentFoldMcpApplicationContext,
): AgentFoldIntegrationOperations {
  const observed =
    (operation: string, handler: (input: unknown) => Promise<AgentFoldMcpResult>) =>
    async (input: unknown): Promise<AgentFoldMcpResult> => {
      const result = await handler(input);
      return observeIntegrationOperation(context, operation, input, result);
    };
  return {
    getStatus: (input) => getStatus(context, input),
    getContext: (input) => getContext(context, input),
    openSession: observed("agentfold_open_session", (input) => openSession(context, input)),
    beginTask: observed("agentfold_begin_task", (input) => beginTask(context, input)),
    reportProgress: observed("agentfold_report_progress", (input) =>
      reportProgress(context, input),
    ),
    createCheckpoint: observed("agentfold_create_checkpoint", (input) =>
      createCheckpoint(context, input),
    ),
    finishTask: observed("agentfold_finish_task", (input) => finishTask(context, input)),
    getResumePacket: observed("agentfold_get_resume_packet", (input) =>
      getResumePacket(context, input),
    ),
    closeSession: observed("agentfold_close_session", (input) => closeSession(context, input)),
  };
}
