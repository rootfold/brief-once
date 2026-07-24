import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type {
  ReliabilityEventInput,
  ReliabilityHost,
  SemanticFreshness,
} from "../../core/reliability/event-schema.js";
import type { AgentFoldMcpApplicationContext } from "../mcp/mcp-context.js";
import type { AgentFoldMcpResult } from "../mcp/mcp-response.js";
import { agentFoldMcpToolNames } from "../mcp/tool-names.js";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeHost(agent: string | undefined, client: string | undefined): ReliabilityHost {
  const label = `${agent ?? ""} ${client ?? ""}`.toLocaleLowerCase("en-US");
  if (label.includes("codex")) return "codex";
  if (label.includes("antigravity")) return "antigravity";
  return "mcp";
}

function sessionIdentity(
  context: AgentFoldMcpApplicationContext,
  input: Readonly<Record<string, unknown>>,
  data: Readonly<Record<string, unknown>>,
): {
  readonly sessionId?: string;
  readonly client?: string;
  readonly agent?: string;
  readonly host: ReliabilityHost;
} {
  const sessionId = stringValue(data.sessionId) ?? stringValue(input.sessionId);
  const session = sessionId === undefined ? undefined : context.sessions.get(sessionId);
  const client = session?.client ?? stringValue(input.client);
  const agent = session?.agent ?? stringValue(input.agent);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(client === undefined ? {} : { client }),
    ...(agent === undefined ? {} : { agent }),
    host: normalizeHost(agent, client),
  };
}

function taskId(data: Readonly<Record<string, unknown>>): string | undefined {
  const direct = stringValue(data.taskId);
  if (direct !== undefined) return direct;
  return stringValue(record(data.task).taskId);
}

function changedPathCount(data: Readonly<Record<string, unknown>>): number | undefined {
  const counts = record(data.changedPathCounts);
  const values = [
    counts.added,
    counts.modified,
    counts.deleted,
    counts.renamed,
    counts.copied,
    counts.untracked,
    counts.unmerged,
  ].map(numberValue);
  return values.some((value) => value !== undefined)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined;
}

function freshness(value: unknown): SemanticFreshness | undefined {
  return value === "current" || value === "reused" || value === "absent" ? value : undefined;
}

function event(
  identity: ReturnType<typeof sessionIdentity>,
  input: Omit<ReliabilityEventInput, "host" | "client" | "agent" | "sessionId">,
): ReliabilityEventInput {
  return {
    ...input,
    host: identity.host,
    ...(identity.client === undefined ? {} : { client: identity.client }),
    ...(identity.agent === undefined ? {} : { agent: identity.agent }),
    ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
  };
}

function operationEvents(
  context: AgentFoldMcpApplicationContext,
  operation: string,
  rawInput: unknown,
  result: AgentFoldMcpResult,
): readonly ReliabilityEventInput[] {
  const input = record(rawInput);
  const data = record(result.data);
  const identity = sessionIdentity(context, input, data);
  const associatedTaskId = taskId(data);
  const checkpointId = stringValue(data.checkpointId) ?? stringValue(data.finalCheckpointId);
  const semanticFreshness = freshness(data.semanticFreshness);
  const semanticRevision =
    numberValue(data.semanticRevision) ?? numberValue(data.newReportRevision);
  const common = {
    ...(associatedTaskId === undefined ? {} : { taskId: associatedTaskId }),
  };

  if (operation === agentFoldMcpToolNames.openSession && identity.sessionId !== undefined) {
    const events: ReliabilityEventInput[] = [
      event(identity, {
        eventType: "session_opened",
        outcome: result.ok ? "success" : "warning",
        reasonCode: context.reliabilityMode === "embedded" ? "EMBEDDED_MCP" : "SERVICE_MCP",
        ...common,
      }),
    ];
    if (
      result.ok &&
      (result.status === "active_without_checkpoint" || result.status === "resumable") &&
      associatedTaskId !== undefined
    ) {
      events.push(
        event(identity, {
          eventType: "task_continued",
          outcome: "success",
          taskId: associatedTaskId,
        }),
      );
    }
    return events;
  }
  if (!result.ok) return [];

  switch (operation) {
    case agentFoldMcpToolNames.beginTask:
      return [
        event(identity, {
          eventType: "task_started",
          outcome: "success",
          ...common,
        }),
      ];
    case agentFoldMcpToolNames.reportProgress:
      return result.status === "report_applied"
        ? [
            event(identity, {
              eventType: "progress_report_submitted",
              outcome: "success",
              ...common,
              ...(semanticRevision === undefined ? {} : { semanticRevision }),
              safeMetadata: { reportCount: 1 },
            }),
          ]
        : [];
    case agentFoldMcpToolNames.createCheckpoint:
      if (result.status === "dry_run") return [];
      return [
        event(identity, {
          eventType:
            result.status === "duplicate_checkpoint"
              ? "checkpoint_duplicate"
              : "checkpoint_created",
          outcome: result.status === "duplicate_checkpoint" ? "skipped" : "success",
          ...common,
          ...(checkpointId === undefined ? {} : { checkpointId }),
          ...(semanticRevision === undefined ? {} : { semanticRevision }),
          ...(semanticFreshness === undefined ? {} : { semanticFreshness }),
          safeMetadata: {
            checkpointCount: result.status === "duplicate_checkpoint" ? 0 : 1,
            ...(changedPathCount(data) === undefined
              ? {}
              : { changedPathCount: changedPathCount(data) }),
          },
        }),
      ];
    case agentFoldMcpToolNames.finishTask: {
      const validation = record(data.validationSummary);
      return [
        event(identity, {
          eventType: "task_finished",
          outcome: "success",
          ...common,
          ...(checkpointId === undefined ? {} : { checkpointId }),
          safeMetadata: {
            checkpointCount: 1,
            validationPassedCount: numberValue(validation.passed) ?? 0,
            validationFailedCount: numberValue(validation.failed) ?? 0,
          },
        }),
      ];
    }
    case agentFoldMcpToolNames.getResumePacket: {
      const packetFreshness = semanticFreshness ?? "absent";
      return [
        event(identity, {
          eventType: "resume_packet_requested",
          outcome: "success",
          ...common,
          ...(checkpointId === undefined ? {} : { checkpointId }),
          semanticFreshness: packetFreshness,
        }),
        event(identity, {
          eventType: `resume_packet_${packetFreshness}`,
          outcome: "success",
          ...common,
          ...(checkpointId === undefined ? {} : { checkpointId }),
          semanticFreshness: packetFreshness,
        }),
      ];
    }
    case agentFoldMcpToolNames.closeSession: {
      const events: ReliabilityEventInput[] = [];
      const reportStatus = stringValue(data.reportStatus);
      const checkpointStatus = stringValue(data.checkpointStatus);
      if (reportStatus === "report_applied") {
        events.push(
          event(identity, {
            eventType: "progress_report_submitted",
            outcome: "success",
            ...common,
            semanticRevision: numberValue(data.reportRevision),
            safeMetadata: { reportCount: 1 },
          }),
        );
      }
      if (
        checkpointStatus === "checkpoint_created" ||
        checkpointStatus === "duplicate_checkpoint"
      ) {
        events.push(
          event(identity, {
            eventType:
              checkpointStatus === "checkpoint_created"
                ? "checkpoint_created"
                : "checkpoint_duplicate",
            outcome: checkpointStatus === "checkpoint_created" ? "success" : "skipped",
            ...common,
            ...(checkpointId === undefined ? {} : { checkpointId }),
          }),
        );
      }
      events.push(
        event(identity, {
          eventType: "session_closed",
          outcome: "success",
          ...common,
          ...(checkpointId === undefined ? {} : { checkpointId }),
        }),
      );
      return events;
    }
    default:
      return [];
  }
}

export async function observeIntegrationOperation(
  context: AgentFoldMcpApplicationContext,
  operation: string,
  input: unknown,
  result: AgentFoldMcpResult,
): Promise<AgentFoldMcpResult> {
  if (context.reliability === undefined) return result;
  const diagnostics: Diagnostic[] = [];
  for (const item of operationEvents(context, operation, input, result)) {
    diagnostics.push(...(await context.reliability.record(item)));
  }
  return diagnostics.length === 0
    ? result
    : { ...result, diagnostics: [...result.diagnostics, ...diagnostics] };
}
