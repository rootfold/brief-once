import path from "node:path";

import { loadLatestCompletedTask } from "../../../core/completion/load-completed-task.js";
import { loadCanonicalContext } from "../../../core/context/load-context.js";
import { loadActiveState } from "../../../core/state/load-active-state.js";
import type { AgentFoldMcpApplicationContext } from "../mcp-context.js";
import { mcpFailure, mcpSuccess, type AgentFoldMcpResult } from "../mcp-response.js";
import { agentFoldMcpToolNames } from "../tool-names.js";
import { getStatusInputSchema } from "../tool-schemas.js";
import { parseToolInput } from "./shared.js";

export async function getStatus(
  context: AgentFoldMcpApplicationContext,
  input: unknown,
): Promise<AgentFoldMcpResult> {
  const operation = agentFoldMcpToolNames.getStatus;
  const parsed = parseToolInput(operation, getStatusInputSchema, input);
  if (!parsed.success) return parsed.result;

  const canonical = await loadCanonicalContext({
    fileSystem: context.fileSystem,
    gitRepositoryLocator: context.gitRepositoryLocator,
    startDirectory: context.repositoryRoot,
  });
  if (canonical.status === "error") {
    const uninitialized = canonical.diagnostics.some((item) => item.code === "AFC002");
    if (uninitialized) {
      return mcpSuccess(
        operation,
        "uninitialized",
        {
          projectName: path.basename(context.repositoryRoot),
          initialized: false,
          contextValid: false,
          activeTask: null,
          latestCheckpointId: null,
          latestCompletedTaskId: null,
          latestCompletedFinalCheckpointId: null,
          latestCompletedFinishedAt: null,
          semanticReportRevision: 0,
          stateVisibility: null,
          localStateIgnored: null,
          availableNextOperations: ["initialize_with_cli"],
        },
        canonical.diagnostics.map((item) => ({ ...item, severity: "warning" as const })),
      );
    }
    return mcpFailure(operation, "invalid_context", canonical.diagnostics);
  }

  const storageDirectory = canonical.context.storage.directory;
  const active = await loadActiveState(
    context.fileSystem,
    context.repositoryRoot,
    storageDirectory,
  );
  if (active.status === "error") return mcpFailure(operation, "invalid_state", active.diagnostics);
  const completed = await loadLatestCompletedTask(
    context.fileSystem,
    context.repositoryRoot,
    storageDirectory,
  );
  if (completed.status === "error") {
    return mcpFailure(operation, "invalid_completed_state", completed.diagnostics);
  }
  let localStateIgnored: boolean | null = null;
  if (canonical.context.state.visibility === "local") {
    try {
      localStateIgnored = await context.gitInspector.isPathIgnored(
        context.repositoryRoot,
        active.status === "success" || active.status === "missing"
          ? active.stateDirectoryRelativePath
          : `${storageDirectory}/state/`,
      );
    } catch {
      return mcpFailure(operation, "git_error", [
        {
          code: "AFMCP014",
          severity: "error",
          message: "Git ignore status could not be inspected safely.",
        },
      ]);
    }
  }

  const state = active.status === "success" ? active.state : undefined;
  const next =
    state === undefined
      ? [agentFoldMcpToolNames.openSession, agentFoldMcpToolNames.beginTask]
      : state.checkpointHistory.latestCheckpointId === null
        ? [
            agentFoldMcpToolNames.reportProgress,
            agentFoldMcpToolNames.createCheckpoint,
            agentFoldMcpToolNames.finishTask,
            agentFoldMcpToolNames.closeSession,
          ]
        : [
            agentFoldMcpToolNames.reportProgress,
            agentFoldMcpToolNames.createCheckpoint,
            agentFoldMcpToolNames.finishTask,
            agentFoldMcpToolNames.getResumePacket,
            agentFoldMcpToolNames.closeSession,
          ];
  const diagnostics = [...canonical.diagnostics];
  if (localStateIgnored === false) {
    diagnostics.push({
      code: "AFMCP015",
      severity: "warning",
      message: "Local BriefOnce state is not ignored by Git.",
      suggestion: `Add only ${storageDirectory}/state/ to .gitignore.`,
    });
  }
  return mcpSuccess(
    operation,
    state === undefined ? "no_active_task" : "active_task",
    {
      projectName: canonical.context.project.name,
      initialized: true,
      contextValid: true,
      activeTask: state === undefined ? null : { taskId: state.taskId, title: state.title },
      latestCheckpointId: state?.checkpointHistory.latestCheckpointId ?? null,
      latestCompletedTaskId: completed.status === "success" ? completed.task.taskId : null,
      latestCompletedFinalCheckpointId:
        completed.status === "success" ? completed.task.finalCheckpointId : null,
      latestCompletedFinishedAt: completed.status === "success" ? completed.task.finishedAt : null,
      semanticReportRevision: state?.reportRevision ?? 0,
      stateVisibility: canonical.context.state.visibility,
      localStateIgnored,
      availableNextOperations: next,
    },
    diagnostics,
  );
}
