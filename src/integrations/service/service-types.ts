import type { ResumeTarget } from "../../core/resume/types.js";

export type ServiceEndpointKind = "named-pipe" | "unix-socket";

export type AgentFoldServiceSessionState =
  "open" | "detached" | "interrupted" | "superseded" | "recovery_pending" | "closed";

export type AgentFoldServiceSessionCloseReason =
  "normal" | "agent_switch" | "heartbeat_timeout" | "client_disconnect";

export interface AgentFoldServiceSession {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly client: string;
  readonly agent: string;
  readonly target: ResumeTarget;
  readonly openedAt: string;
  readonly lastHeartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly activeTaskId?: string;
  readonly state: AgentFoldServiceSessionState;
  readonly closedAt?: string;
  readonly closeReason?: AgentFoldServiceSessionCloseReason;
  readonly lastLifecycleEvent:
    | "session_opened"
    | "task_started"
    | "task_continued"
    | "report_submitted"
    | "checkpoint_created"
    | "resume_requested"
    | "detached";
  readonly lastCheckpointId?: string;
  readonly semanticRevision?: number;
  readonly reportCount: number;
  readonly checkpointCount: number;
  readonly recoveryAttempts: number;
  readonly recoveryRetryAt?: string;
  readonly recoveryReason?: "service_restart" | "heartbeat_timeout";
}

export interface SafeAgentFoldServiceStatus {
  readonly running: boolean;
  readonly serviceVersion?: string;
  readonly processId?: number;
  readonly startedAt?: string;
  readonly endpointKind?: ServiceEndpointKind;
  readonly registeredRepositoryCount: number;
  readonly openSessionCount: number;
  readonly staleOrRecoveryPendingSessionCount: number;
  readonly interruptedSessionCount: number;
  readonly recoveryPendingSessionCount: number;
  readonly recentRecoveryFailureCount: number;
  readonly reliabilityPersistenceEnabled: boolean;
  readonly automationEnabled: boolean;
}
