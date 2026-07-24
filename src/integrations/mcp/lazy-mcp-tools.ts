import type { AgentFoldIntegrationOperations } from "../application/integration-operations.js";
import { mcpFailure, type AgentFoldMcpResult } from "./mcp-response.js";
import { agentFoldMcpToolNames } from "./tool-names.js";
import type { McpWorkspaceResolver } from "./workspace-resolver.js";

export interface LazyMcpOperations {
  readonly handlers: AgentFoldIntegrationOperations;
  shutdown(): Promise<void>;
}

export interface CreateLazyMcpOperationsInput {
  readonly resolver: McpWorkspaceResolver;
  readonly create: (repositoryRoot: string) => Promise<LazyMcpOperations>;
}

export function createLazyMcpOperations(input: CreateLazyMcpOperationsInput): LazyMcpOperations {
  let initialized: Promise<LazyMcpOperations> | undefined;
  const invoke = async (
    operation: string,
    value: unknown,
    select: (
      handlers: AgentFoldIntegrationOperations,
    ) => (value: unknown) => Promise<AgentFoldMcpResult>,
  ): Promise<AgentFoldMcpResult> => {
    const resolution = await input.resolver.resolve();
    if (resolution.status === "error") {
      return mcpFailure(operation, "workspace_unresolved", resolution.diagnostics);
    }
    initialized ??= input.create(resolution.repositoryRoot);
    try {
      return await select((await initialized).handlers)(value);
    } catch {
      return mcpFailure(operation, "workspace_unresolved", [
        {
          code: "AFMCP020",
          severity: "error",
          message: "The BriefOnce workspace could not be initialized safely.",
          suggestion: "Restart the MCP process with one initialized repository.",
        },
      ]);
    }
  };
  const handlers: AgentFoldIntegrationOperations = {
    getStatus: (value) =>
      invoke(agentFoldMcpToolNames.getStatus, value, (operations) => operations.getStatus),
    getContext: (value) =>
      invoke(agentFoldMcpToolNames.getContext, value, (operations) => operations.getContext),
    openSession: (value) =>
      invoke(agentFoldMcpToolNames.openSession, value, (operations) => operations.openSession),
    beginTask: (value) =>
      invoke(agentFoldMcpToolNames.beginTask, value, (operations) => operations.beginTask),
    reportProgress: (value) =>
      invoke(
        agentFoldMcpToolNames.reportProgress,
        value,
        (operations) => operations.reportProgress,
      ),
    createCheckpoint: (value) =>
      invoke(
        agentFoldMcpToolNames.createCheckpoint,
        value,
        (operations) => operations.createCheckpoint,
      ),
    finishTask: (value) =>
      invoke(agentFoldMcpToolNames.finishTask, value, (operations) => operations.finishTask),
    getResumePacket: (value) =>
      invoke(
        agentFoldMcpToolNames.getResumePacket,
        value,
        (operations) => operations.getResumePacket,
      ),
    closeSession: (value) =>
      invoke(agentFoldMcpToolNames.closeSession, value, (operations) => operations.closeSession),
  };
  return {
    handlers,
    async shutdown(): Promise<void> {
      if (initialized !== undefined) await (await initialized).shutdown();
    },
  };
}
