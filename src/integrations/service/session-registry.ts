import { randomUUID } from "node:crypto";

import type { ResumeTarget } from "../../core/resume/types.js";
import type {
  AgentFoldMcpSession,
  AgentFoldMcpSessionRegistry,
  SessionLookupResult,
} from "../mcp/session-registry.js";
import type {
  AgentFoldServiceSession,
  AgentFoldServiceSessionCloseReason,
} from "./service-types.js";
import type { PersistentSessionRecord } from "../reliability/session-journal-schema.js";

interface InternalServiceSession extends AgentFoldServiceSession {
  readonly leaseDurationSeconds: number;
}

export interface OpenServiceSessionInput {
  readonly repositoryId: string;
  readonly client: string;
  readonly agent: string;
  readonly target: ResumeTarget;
  readonly leaseDurationSeconds: number;
}

export interface ServiceSessionRegistryOptions {
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

function leaseExpiration(now: Date, leaseDurationSeconds: number): string {
  return new Date(now.getTime() + leaseDurationSeconds * 1_000).toISOString();
}

function asMcpSession(session: AgentFoldServiceSession): AgentFoldMcpSession {
  return {
    sessionId: session.sessionId,
    client: session.client,
    agent: session.agent,
    openedAt: session.openedAt,
    lastActivityAt: session.lastHeartbeatAt,
    ...(session.activeTaskId === undefined ? {} : { activeTaskId: session.activeTaskId }),
    ...(session.state === "open" ? {} : { closedAt: session.closedAt ?? session.lastHeartbeatAt }),
  };
}

export class ServiceSessionRegistry {
  private readonly sessions = new Map<string, InternalServiceSession>();
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(options: ServiceSessionRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? (() => `svc-${randomUUID()}`);
  }

  open(input: OpenServiceSessionInput): AgentFoldServiceSession {
    let sessionId: string | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = this.generateId();
      if (candidate.length > 0 && !this.sessions.has(candidate)) {
        sessionId = candidate;
        break;
      }
    }
    if (sessionId === undefined)
      throw new Error("Could not allocate a unique service session identifier.");
    const now = this.now();
    const timestamp = now.toISOString();
    const session: InternalServiceSession = {
      sessionId,
      repositoryId: input.repositoryId,
      client: input.client,
      agent: input.agent,
      target: input.target,
      openedAt: timestamp,
      lastHeartbeatAt: timestamp,
      leaseExpiresAt: leaseExpiration(now, input.leaseDurationSeconds),
      state: "open",
      leaseDurationSeconds: input.leaseDurationSeconds,
      lastLifecycleEvent: "session_opened",
      reportCount: 0,
      checkpointCount: 0,
      recoveryAttempts: 0,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): AgentFoldServiceSession | undefined {
    return this.sessions.get(sessionId);
  }

  requireOpen(sessionId: string): AgentFoldServiceSession | undefined {
    const session = this.sessions.get(sessionId);
    return session?.state === "open" ? session : undefined;
  }

  touch(sessionId: string): AgentFoldServiceSession | undefined {
    const current = this.sessions.get(sessionId);
    if (current === undefined || current.state !== "open") return undefined;
    const now = this.now();
    const updated = {
      ...current,
      lastHeartbeatAt: now.toISOString(),
      leaseExpiresAt: leaseExpiration(now, current.leaseDurationSeconds),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  attachTask(
    sessionId: string,
    taskId: string,
    lifecycle: "task_started" | "task_continued" = "task_continued",
  ): AgentFoldServiceSession | undefined {
    const touched = this.touch(sessionId);
    if (touched === undefined) return undefined;
    const updated = { ...touched, activeTaskId: taskId, lastLifecycleEvent: lifecycle };
    this.sessions.set(sessionId, {
      ...updated,
      leaseDurationSeconds: this.sessions.get(sessionId)?.leaseDurationSeconds ?? 90,
    });
    return updated;
  }

  clearTask(sessionId: string): AgentFoldServiceSession | undefined {
    const touched = this.touch(sessionId);
    if (touched === undefined) return undefined;
    const withoutTask = { ...touched };
    delete withoutTask.activeTaskId;
    const internal = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      ...withoutTask,
      leaseDurationSeconds: internal?.leaseDurationSeconds ?? 90,
    });
    return withoutTask;
  }

  detach(sessionId: string): AgentFoldServiceSession | undefined {
    const current = this.sessions.get(sessionId);
    if (current === undefined || current.state !== "open") return undefined;
    const updated = {
      ...current,
      state: "detached" as const,
      lastLifecycleEvent: "detached" as const,
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  supersede(sessionId: string): AgentFoldServiceSession | undefined {
    return this.close(sessionId, "agent_switch", "superseded");
  }

  close(
    sessionId: string,
    reason: AgentFoldServiceSessionCloseReason,
    state: "closed" | "superseded" = "closed",
  ): AgentFoldServiceSession | undefined {
    const current = this.sessions.get(sessionId);
    if (current === undefined || current.state === "closed" || current.state === "superseded") {
      return undefined;
    }
    const timestamp = this.now().toISOString();
    const updated = {
      ...current,
      state,
      lastHeartbeatAt: timestamp,
      closedAt: timestamp,
      closeReason: reason,
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  markRecoveryPending(
    sessionId: string,
    retryAfterSeconds?: number,
    reason?: "service_restart" | "heartbeat_timeout",
  ): AgentFoldServiceSession | undefined {
    const current = this.sessions.get(sessionId);
    if (
      current === undefined ||
      !["open", "detached", "interrupted", "recovery_pending"].includes(current.state)
    ) {
      return undefined;
    }
    const recoveryRetryAt =
      retryAfterSeconds === undefined
        ? current.recoveryRetryAt
        : new Date(this.now().getTime() + retryAfterSeconds * 1_000).toISOString();
    const updated = {
      ...current,
      state: "recovery_pending" as const,
      ...(recoveryRetryAt === undefined ? {} : { recoveryRetryAt }),
      ...(reason === undefined ? {} : { recoveryReason: reason }),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  recordReport(
    sessionId: string,
    taskId: string,
    semanticRevision?: number,
  ): AgentFoldServiceSession | undefined {
    const current = this.sessions.get(sessionId);
    if (current === undefined || current.state !== "open") return undefined;
    const updated: InternalServiceSession = {
      ...current,
      activeTaskId: taskId,
      lastLifecycleEvent: "report_submitted",
      reportCount: current.reportCount + 1,
      ...(semanticRevision === undefined ? {} : { semanticRevision }),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  recordCheckpoint(
    sessionId: string,
    taskId: string,
    checkpointId: string,
    semanticRevision?: number,
  ): AgentFoldServiceSession | undefined {
    const current = this.sessions.get(sessionId);
    if (current === undefined || current.state !== "open") return undefined;
    const updated: InternalServiceSession = {
      ...current,
      activeTaskId: taskId,
      lastLifecycleEvent: "checkpoint_created",
      lastCheckpointId: checkpointId,
      checkpointCount: current.checkpointCount + 1,
      ...(semanticRevision === undefined ? {} : { semanticRevision }),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  recordResume(sessionId: string, taskId?: string): AgentFoldServiceSession | undefined {
    const current = this.sessions.get(sessionId);
    if (current === undefined || current.state !== "open") return undefined;
    const updated: InternalServiceSession = {
      ...current,
      ...(taskId === undefined ? {} : { activeTaskId: taskId }),
      lastLifecycleEvent: "resume_requested",
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  restoreInterrupted(record: PersistentSessionRecord, leaseDurationSeconds: number): void {
    if (this.sessions.has(record.sessionId)) return;
    this.sessions.set(record.sessionId, {
      sessionId: record.sessionId,
      repositoryId: record.repositoryId,
      client: record.client,
      agent: record.agent,
      target: record.host === "codex" || record.host === "antigravity" ? record.host : "generic",
      openedAt: record.openedAt,
      lastHeartbeatAt: record.lastHeartbeatAt,
      leaseExpiresAt: record.leaseExpiresAt,
      ...(record.taskId === undefined ? {} : { activeTaskId: record.taskId }),
      state: "interrupted",
      leaseDurationSeconds,
      lastLifecycleEvent: record.lastLifecycleEvent,
      ...(record.lastCheckpointId === undefined
        ? {}
        : { lastCheckpointId: record.lastCheckpointId }),
      ...(record.semanticRevision === undefined
        ? {}
        : { semanticRevision: record.semanticRevision }),
      reportCount: record.reportCount,
      checkpointCount: record.checkpointCount,
      recoveryAttempts: record.recoveryAttempts,
      recoveryRetryAt: record.nextRecoveryAt ?? this.now().toISOString(),
      recoveryReason: "service_restart",
    });
  }

  scheduleRecoveryFailure(
    sessionId: string,
    maximumAttempts = 3,
  ): AgentFoldServiceSession | undefined {
    const current = this.sessions.get(sessionId);
    if (current === undefined || !["interrupted", "recovery_pending"].includes(current.state))
      return undefined;
    const attempts = Math.min(maximumAttempts, current.recoveryAttempts + 1);
    const delaySeconds = Math.max(60, 60 * 2 ** Math.max(0, attempts - 1));
    const withoutRetry = { ...current };
    delete (withoutRetry as { recoveryRetryAt?: string }).recoveryRetryAt;
    const updated: InternalServiceSession = {
      ...withoutRetry,
      state: "recovery_pending",
      recoveryAttempts: attempts,
      ...(attempts >= maximumAttempts
        ? {}
        : {
            recoveryRetryAt: new Date(this.now().getTime() + delaySeconds * 1_000).toISOString(),
          }),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  freshActive(repositoryId: string): AgentFoldServiceSession | undefined {
    const now = this.now().getTime();
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.repositoryId === repositoryId &&
          (session.state === "open" || session.state === "detached") &&
          Date.parse(session.leaseExpiresAt) > now,
      )
      .sort((left, right) => right.openedAt.localeCompare(left.openedAt))[0];
  }

  staleSessions(): readonly AgentFoldServiceSession[] {
    const now = this.now().getTime();
    return [...this.sessions.values()].filter((session) => {
      if (session.state === "open" || session.state === "detached") {
        return Date.parse(session.leaseExpiresAt) <= now;
      }
      return (
        (session.state === "interrupted" || session.state === "recovery_pending") &&
        session.recoveryRetryAt !== undefined &&
        Date.parse(session.recoveryRetryAt) <= now
      );
    });
  }

  journalSessions(): readonly AgentFoldServiceSession[] {
    return this.all().filter((session) =>
      ["open", "detached", "interrupted", "recovery_pending"].includes(session.state),
    );
  }

  all(): readonly AgentFoldServiceSession[] {
    return [...this.sessions.values()];
  }

  forRepository(repositoryId: string): readonly AgentFoldServiceSession[] {
    return this.all().filter((session) => session.repositoryId === repositoryId);
  }

  mcpAdapter(
    repositoryId: string,
    target: ResumeTarget,
    leaseDurationSeconds: number,
  ): AgentFoldMcpSessionRegistry {
    return {
      open: (client, agent) =>
        asMcpSession(this.open({ repositoryId, client, agent, target, leaseDurationSeconds })),
      requireOpen: (sessionId): SessionLookupResult => {
        const session = this.sessions.get(sessionId);
        if (session === undefined || session.repositoryId !== repositoryId)
          return { status: "unknown" };
        if (session.state !== "open") return { status: "closed", session: asMcpSession(session) };
        return { status: "open", session: asMcpSession(session) };
      },
      attachTask: (sessionId, taskId) => {
        const session = this.sessions.get(sessionId);
        return session?.repositoryId === repositoryId
          ? asMcpSession(this.attachTask(sessionId, taskId) ?? session)
          : undefined;
      },
      clearTask: (sessionId) => {
        const session = this.sessions.get(sessionId);
        return session?.repositoryId === repositoryId
          ? asMcpSession(this.clearTask(sessionId) ?? session)
          : undefined;
      },
      touch: (sessionId) => {
        const session = this.sessions.get(sessionId);
        return session?.repositoryId === repositoryId
          ? asMcpSession(this.touch(sessionId) ?? session)
          : undefined;
      },
      close: (sessionId) => {
        const session = this.sessions.get(sessionId);
        return session?.repositoryId === repositoryId
          ? asMcpSession(this.close(sessionId, "normal") ?? session)
          : undefined;
      },
      get: (sessionId) => {
        const session = this.sessions.get(sessionId);
        return session?.repositoryId === repositoryId ? asMcpSession(session) : undefined;
      },
    };
  }
}
