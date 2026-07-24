import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  defaultAutomationPolicy,
  type AutomationPolicy,
} from "../../core/config/automation-policy.js";
import {
  defaultReliabilityPolicy,
  type ReliabilityPolicy,
} from "../../core/config/reliability-policy.js";
import { loadCanonicalContext } from "../../core/context/load-context.js";
import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import type { GitInspector } from "../../core/git/git-inspector.js";
import type { GitRepositoryLocator } from "../../core/git/git-repository-locator.js";
import type { ResumeTarget } from "../../core/resume/types.js";
import { createAgentFoldIntegrationOperations } from "../application/integration-operations.js";
import { createMcpStderrLogger, type McpStderrLogger } from "../mcp/mcp-context.js";
import { mcpFailure, type AgentFoldMcpResult } from "../mcp/mcp-response.js";
import { containsSecretLikeText } from "../../core/reports/redact-secrets.js";
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
} from "../mcp/tool-schemas.js";
import { createAutomaticCheckpoint } from "./automation-checkpoint.js";
import { RepositoryOperationQueue } from "./operation-queue.js";
import { RepositoryRegistry, type RegisteredRepository } from "./repository-registry.js";
import { ServiceSessionRegistry } from "./session-registry.js";
import { agentFoldServiceProtocolVersion, type ServiceMethodName } from "./service-protocol.js";
import type { SafeAgentFoldServiceStatus } from "./service-types.js";
import { createReliabilityRecorder, type ReliabilityRecorder } from "../reliability/recorder.js";
import {
  PersistentSessionJournalStore,
  SessionJournalError,
} from "../reliability/session-journal-store.js";
import type {
  PersistentSessionJournal,
  PersistentSessionRecord,
} from "../reliability/session-journal-schema.js";
import type {
  ReliabilityEventInput,
  ReliabilityHost,
} from "../../core/reliability/event-schema.js";
import { loadActiveState } from "../../core/state/load-active-state.js";

const workspaceSchema = z.string().trim().min(1).max(32_768);
const sessionIdSchema = z.string().trim().min(1).max(200);
const emptySchema = z.object({}).strict();
const sessionOpenSchema = openSessionInputSchema.extend({ workspace: workspaceSchema });
const workspaceStatusSchema = getStatusInputSchema.extend({ workspace: workspaceSchema });
const workspaceContextSchema = getContextInputSchema.extend({ workspace: workspaceSchema });
const sessionLifecycleSchema = z.object({ sessionId: sessionIdSchema }).strict();

export interface ServiceCoordinatorOptions {
  readonly version: string;
  readonly startedAt: string;
  readonly processId: number;
  readonly endpointKind: "named-pipe" | "unix-socket";
  readonly fileSystem: FileSystem;
  readonly gitRepositoryLocator: GitRepositoryLocator;
  readonly gitInspector: GitInspector;
  readonly now?: () => Date;
  readonly generateSessionId?: () => string;
  readonly logger?: McpStderrLogger;
  readonly onShutdownRequested?: () => void;
  readonly reliabilityStateDirectory?: string;
  readonly generateEventId?: () => string;
  readonly generateServiceInstanceId?: () => string;
  readonly sessionJournalStore?: PersistentSessionJournalStore;
}

export class ServiceMethodError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: readonly Diagnostic[] = [],
  ) {
    super(message);
    this.name = "ServiceMethodError";
  }
}

function invalidParams(error: z.ZodError): ServiceMethodError {
  return new ServiceMethodError("AFSV011", "The service method parameters are invalid.", [
    {
      code: "AFSV011",
      severity: "error",
      message: "The service method parameters did not match the required schema.",
      suggestion: error.issues
        .map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`)
        .join("; "),
    },
  ]);
}

function parseParams<Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidParams(parsed.error);
  return parsed.data;
}

function diagnostic(
  code: string,
  severity: Diagnostic["severity"],
  message: string,
  suggestion?: string,
): Diagnostic {
  return { code, severity, message, ...(suggestion === undefined ? {} : { suggestion }) };
}

function resultData(result: AgentFoldMcpResult): Readonly<Record<string, unknown>> {
  return typeof result.data === "object" && result.data !== null
    ? Object.fromEntries(Object.entries(result.data))
    : {};
}

function stringData(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof data[key] === "string" ? data[key] : undefined;
}

function numberData(data: Readonly<Record<string, unknown>>, key: string): number | undefined {
  return typeof data[key] === "number" && Number.isInteger(data[key]) && data[key] >= 0
    ? data[key]
    : undefined;
}

export class AgentFoldServiceCoordinator {
  readonly repositories: RepositoryRegistry;
  readonly sessions: ServiceSessionRegistry;
  readonly queue = new RepositoryOperationQueue();
  private readonly now: () => Date;
  private readonly logger: McpStderrLogger;
  private readonly policies = new Map<string, AutomationPolicy>();
  private readonly reliabilityPolicies = new Map<string, ReliabilityPolicy>();
  private readonly recorders = new Map<string, ReliabilityRecorder>();
  private readonly journalStore: PersistentSessionJournalStore | undefined;
  private readonly serviceInstanceId: string;
  private journalWritable = true;
  private readonly persistedHeartbeatAt = new Map<string, number>();
  private readonly startedRepositories = new Set<string>();
  private orphanedJournalRecords: readonly PersistentSessionRecord[] = [];

  constructor(private readonly options: ServiceCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? createMcpStderrLogger(() => undefined, false);
    this.repositories = new RepositoryRegistry({
      fileSystem: options.fileSystem,
      gitRepositoryLocator: options.gitRepositoryLocator,
      now: this.now,
    });
    this.sessions = new ServiceSessionRegistry({
      now: this.now,
      ...(options.generateSessionId === undefined ? {} : { generateId: options.generateSessionId }),
    });
    this.journalStore =
      options.sessionJournalStore ??
      (options.reliabilityStateDirectory === undefined
        ? undefined
        : new PersistentSessionJournalStore({
            fileSystem: options.fileSystem,
            stateDirectory: options.reliabilityStateDirectory,
          }));
    this.serviceInstanceId = options.generateServiceInstanceId?.() ?? `service-${randomUUID()}`;
  }

  private host(agent: string, client: string): ReliabilityHost {
    const label = `${agent} ${client}`.toLocaleLowerCase("en-US");
    if (label.includes("codex")) return "codex";
    if (label.includes("antigravity")) return "antigravity";
    return "mcp";
  }

  private async record(
    repositoryId: string,
    event: ReliabilityEventInput,
  ): Promise<readonly Diagnostic[]> {
    return (await this.recorders.get(repositoryId)?.record(event)) ?? [];
  }

  private journalRecords(): readonly PersistentSessionRecord[] {
    const activeRecords = this.sessions
      .journalSessions()
      .map((session): PersistentSessionRecord | undefined => {
        const repository = this.repositories.get(session.repositoryId);
        if (repository === undefined) return undefined;
        const host = this.host(session.agent, session.client);
        return {
          sessionId: session.sessionId,
          repositoryId: session.repositoryId,
          canonicalRepositoryRoot: repository.absoluteRoot,
          host,
          client: host,
          agent: host,
          ...(session.activeTaskId === undefined ? {} : { taskId: session.activeTaskId }),
          openedAt: session.openedAt,
          lastHeartbeatAt: session.lastHeartbeatAt,
          leaseExpiresAt: session.leaseExpiresAt,
          state:
            session.state === "open" ||
            session.state === "detached" ||
            session.state === "interrupted"
              ? session.state
              : "recovery_pending",
          lastLifecycleEvent: session.lastLifecycleEvent,
          ...(session.lastCheckpointId === undefined
            ? {}
            : { lastCheckpointId: session.lastCheckpointId }),
          ...(session.semanticRevision === undefined
            ? {}
            : { semanticRevision: session.semanticRevision }),
          reportCount: session.reportCount,
          checkpointCount: session.checkpointCount,
          recoveryAttempts: Math.min(3, session.recoveryAttempts),
          ...(session.recoveryRetryAt === undefined
            ? {}
            : { nextRecoveryAt: session.recoveryRetryAt }),
        };
      })
      .filter((record): record is PersistentSessionRecord => record !== undefined)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const activeIds = new Set(activeRecords.map((record) => record.sessionId));
    return [
      ...this.orphanedJournalRecords.filter((record) => !activeIds.has(record.sessionId)),
      ...activeRecords,
    ]
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .slice(-1_000);
  }

  private async persistJournal(): Promise<readonly Diagnostic[]> {
    if (this.journalStore === undefined || !this.journalWritable) return [];
    const journal: PersistentSessionJournal = {
      schemaVersion: 1,
      serviceInstanceId: this.serviceInstanceId,
      writtenAt: this.now().toISOString(),
      sessions: [...this.journalRecords()],
    };
    try {
      await this.journalStore.write(journal);
      for (const session of this.sessions.journalSessions()) {
        this.persistedHeartbeatAt.set(session.sessionId, Date.parse(session.lastHeartbeatAt));
      }
      return [];
    } catch {
      return [
        diagnostic(
          "AFREL003",
          "warning",
          "The persistent session journal could not be updated; the lifecycle operation still succeeded.",
          "Review the private AgentFold user-state directory.",
        ),
      ];
    }
  }

  async initialize(): Promise<void> {
    if (this.journalStore === undefined) return;
    let previous: PersistentSessionJournal | undefined;
    try {
      previous = await this.journalStore.read();
    } catch (error: unknown) {
      this.journalWritable = false;
      this.logger.error(
        error instanceof SessionJournalError && error.code === "unsafe"
          ? "AFREL005: Unsafe persistent-session journal symlink was rejected."
          : "AFREL004: The persistent-session journal is corrupt and was preserved.",
      );
      return;
    }
    if (previous !== undefined && previous.serviceInstanceId !== this.serviceInstanceId) {
      const restoredRepositories = new Set<string>();
      for (const session of previous.sessions) {
        const repository = await this.repositories.restore(
          session.canonicalRepositoryRoot,
          session.repositoryId,
        );
        if (repository === undefined) {
          this.orphanedJournalRecords = [...this.orphanedJournalRecords, session];
          continue;
        }
        const policy = await this.policy(repository);
        const reliabilityPolicy = this.reliabilityPolicies.get(repository.repositoryId);
        if (reliabilityPolicy?.interruptedRecoveryEnabled !== true) continue;
        this.sessions.restoreInterrupted(session, policy.sessions.staleAfterSeconds);
        this.repositories.attachSession(repository.repositoryId, session.sessionId);
        restoredRepositories.add(repository.repositoryId);
        await this.record(repository.repositoryId, {
          eventType: "session_interrupted",
          host: session.host,
          client: session.client,
          agent: session.agent,
          sessionId: session.sessionId,
          ...(session.taskId === undefined ? {} : { taskId: session.taskId }),
          ...(session.lastCheckpointId === undefined
            ? {}
            : { checkpointId: session.lastCheckpointId }),
          ...(session.semanticRevision === undefined
            ? {}
            : { semanticRevision: session.semanticRevision }),
          outcome: "warning",
          reasonCode: "SERVICE_RESTART",
          safeMetadata: {
            reportCount: session.reportCount,
            checkpointCount: session.checkpointCount,
            recoveryAttempt: session.recoveryAttempts,
          },
        });
        await this.record(repository.repositoryId, {
          eventType: "recovery_pending",
          host: session.host,
          client: session.client,
          agent: session.agent,
          sessionId: session.sessionId,
          ...(session.taskId === undefined ? {} : { taskId: session.taskId }),
          outcome: "warning",
          reasonCode: "SERVICE_RESTART",
          safeMetadata: { recoveryAttempt: session.recoveryAttempts },
        });
      }
      for (const repositoryId of restoredRepositories) {
        await this.record(repositoryId, {
          eventType: "service_restarted_with_interrupted_sessions",
          host: "unknown",
          outcome: "warning",
          reasonCode: "PREVIOUS_INSTANCE_JOURNAL",
        });
      }
    }
    await this.persistJournal();
  }

  async shutdown(): Promise<void> {
    for (const repository of this.repositories.all()) {
      await this.record(repository.repositoryId, {
        eventType: "service_stopped",
        host: "unknown",
        outcome: "success",
      });
    }
    await this.persistJournal();
  }

  private async policy(repository: RegisteredRepository): Promise<AutomationPolicy> {
    const existing = this.policies.get(repository.repositoryId);
    if (existing !== undefined) return existing;
    const loaded = await loadCanonicalContext({
      fileSystem: this.options.fileSystem,
      gitRepositoryLocator: this.options.gitRepositoryLocator,
      startDirectory: repository.absoluteRoot,
    });
    const policy =
      loaded.status === "success" ? loaded.context.automation : defaultAutomationPolicy;
    this.policies.set(repository.repositoryId, policy);
    const reliabilityPolicy =
      loaded.status === "success" ? loaded.context.reliability : defaultReliabilityPolicy;
    this.reliabilityPolicies.set(repository.repositoryId, reliabilityPolicy);
    if (this.options.reliabilityStateDirectory !== undefined) {
      const recorder = createReliabilityRecorder({
        repositoryId: repository.repositoryId,
        stateDirectory: this.options.reliabilityStateDirectory,
        policy: reliabilityPolicy,
        fileSystem: this.options.fileSystem,
        now: this.now,
        ...(this.options.generateEventId === undefined
          ? {}
          : { generateEventId: this.options.generateEventId }),
      });
      this.recorders.set(repository.repositoryId, recorder);
      if (recorder.enabled && !this.startedRepositories.has(repository.repositoryId)) {
        this.startedRepositories.add(repository.repositoryId);
        await recorder.record({
          eventType: "service_started",
          host: "unknown",
          outcome: "success",
        });
      }
    }
    return policy;
  }

  private context(
    repository: RegisteredRepository,
    target: ResumeTarget,
    policy: AutomationPolicy,
  ) {
    const reliability = this.recorders.get(repository.repositoryId);
    return {
      requestedWorkspace: repository.absoluteRoot,
      repositoryRoot: repository.absoluteRoot,
      version: this.options.version,
      fileSystem: this.options.fileSystem,
      gitRepositoryLocator: this.options.gitRepositoryLocator,
      gitInspector: this.options.gitInspector,
      now: this.now,
      sessions: this.sessions.mcpAdapter(
        repository.repositoryId,
        target,
        policy.sessions.staleAfterSeconds,
      ),
      debug: false,
      logger: this.logger,
      ...(reliability === undefined ? {} : { reliability }),
      reliabilityMode: "service" as const,
    };
  }

  private async repositoryForSession(sessionId: string): Promise<{
    readonly repository: RegisteredRepository;
    readonly policy: AutomationPolicy;
    readonly target: ResumeTarget;
  }> {
    const session = this.sessions.get(sessionId);
    if (session === undefined)
      throw new ServiceMethodError("AFSV015", "The service session is unknown.");
    const repository = this.repositories.get(session.repositoryId);
    if (repository === undefined)
      throw new ServiceMethodError("AFSV016", "The session repository is unavailable.");
    return { repository, policy: await this.policy(repository), target: session.target };
  }

  private status(): SafeAgentFoldServiceStatus {
    const sessions = this.sessions.all();
    const now = this.now().getTime();
    return {
      running: true,
      serviceVersion: this.options.version,
      processId: this.options.processId,
      startedAt: this.options.startedAt,
      endpointKind: this.options.endpointKind,
      registeredRepositoryCount: this.repositories.count(),
      openSessionCount: sessions.filter((session) => session.state === "open").length,
      staleOrRecoveryPendingSessionCount: sessions.filter(
        (session) =>
          session.state === "recovery_pending" ||
          ((session.state === "open" || session.state === "detached") &&
            Date.parse(session.leaseExpiresAt) <= now),
      ).length,
      interruptedSessionCount: sessions.filter((session) => session.state === "interrupted").length,
      recoveryPendingSessionCount: sessions.filter(
        (session) => session.state === "recovery_pending",
      ).length,
      recentRecoveryFailureCount: sessions.filter((session) => session.recoveryAttempts > 0).length,
      reliabilityPersistenceEnabled:
        this.recorders.size === 0
          ? this.options.reliabilityStateDirectory !== undefined
          : [...this.recorders.values()].some((recorder) => recorder.enabled),
      automationEnabled:
        this.policies.size === 0 || [...this.policies.values()].some((policy) => policy.enabled),
    };
  }

  async handle(method: ServiceMethodName, params: unknown): Promise<unknown> {
    switch (method) {
      case "service.ping": {
        parseParams(emptySchema, params);
        return {
          protocolVersion: agentFoldServiceProtocolVersion,
          serviceVersion: this.options.version,
          status: "ready",
          endpointKind: this.options.endpointKind,
        };
      }
      case "service.status":
        parseParams(emptySchema, params);
        return this.status();
      case "service.shutdown":
        parseParams(emptySchema, params);
        this.options.onShutdownRequested?.();
        return { status: "stopping" };
      case "session.open":
        return this.openSession(params);
      case "session.heartbeat":
        return this.heartbeat(params);
      case "session.detach":
        return this.detach(params);
      case "session.close":
        return this.closeSession(params);
      case "integration.get_status":
        return this.getStatus(params);
      case "integration.get_context":
        return this.getContext(params);
      case "integration.begin_task":
        return this.sessionOperation(params, beginTaskInputSchema, "beginTask", true);
      case "integration.report_progress":
        return this.sessionOperation(params, reportProgressInputSchema, "reportProgress", true);
      case "integration.create_checkpoint":
        return this.sessionOperation(params, createCheckpointInputSchema, "createCheckpoint", true);
      case "integration.finish_task":
        return this.sessionOperation(params, finishTaskInputSchema, "finishTask", true);
      case "integration.get_resume_packet":
        return this.sessionOperation(params, getResumePacketInputSchema, "getResumePacket", false);
    }
  }

  private async getStatus(params: unknown): Promise<AgentFoldMcpResult> {
    const parsed = parseParams(workspaceStatusSchema, params);
    const repository = await this.repositories.register(parsed.workspace);
    const policy = await this.policy(repository);
    return createAgentFoldIntegrationOperations(
      this.context(repository, "generic", policy),
    ).getStatus({});
  }

  private async getContext(params: unknown): Promise<AgentFoldMcpResult> {
    const parsed = parseParams(workspaceContextSchema, params);
    const repository = await this.repositories.register(parsed.workspace);
    const policy = await this.policy(repository);
    return createAgentFoldIntegrationOperations(
      this.context(repository, "generic", policy),
    ).getContext({
      includeContextDocuments: parsed.includeContextDocuments,
    });
  }

  private async openSession(params: unknown): Promise<AgentFoldMcpResult> {
    const parsed = parseParams(sessionOpenSchema, params);
    const repository = await this.repositories.register(parsed.workspace);
    const policy = await this.policy(repository);
    return this.queue.run(repository.repositoryId, async () => {
      const automationDiagnostics: Diagnostic[] = [];
      automationDiagnostics.push(...(await this.recoverRepositoryInterruptions(repository)));
      const previous = this.sessions.freshActive(repository.repositoryId);
      let switchFailed = false;
      if (
        previous !== undefined &&
        previous.agent !== parsed.agent &&
        policy.enabled &&
        policy.checkpoints.onAgentSwitch
      ) {
        automationDiagnostics.push(
          ...(await this.record(repository.repositoryId, {
            eventType: "agent_switch_detected",
            host: this.host(previous.agent, previous.client),
            client: previous.client,
            agent: previous.agent,
            sessionId: previous.sessionId,
            ...(previous.activeTaskId === undefined ? {} : { taskId: previous.activeTaskId }),
            outcome: "warning",
          })),
        );
        automationDiagnostics.push(
          diagnostic(
            "AFSV019",
            "info",
            "A different active agent was detected for this repository.",
          ),
        );
        const automatic = await createAutomaticCheckpoint({
          repositoryRoot: repository.absoluteRoot,
          agent: previous.agent,
          policy,
          trigger: "agent_switch",
          fileSystem: this.options.fileSystem,
          gitRepositoryLocator: this.options.gitRepositoryLocator,
          gitInspector: this.options.gitInspector,
          now: this.now,
        });
        automationDiagnostics.push(...automatic.diagnostics);
        if (automatic.status === "failed") {
          switchFailed = true;
          automationDiagnostics.push(
            ...(await this.record(repository.repositoryId, {
              eventType: "agent_switch_checkpoint_failed",
              host: this.host(previous.agent, previous.client),
              client: previous.client,
              agent: previous.agent,
              sessionId: previous.sessionId,
              ...(previous.activeTaskId === undefined ? {} : { taskId: previous.activeTaskId }),
              outcome: "failure",
              reasonCode: "CHECKPOINT_FAILED",
            })),
          );
          automationDiagnostics.push(
            diagnostic(
              "AFSV025",
              "warning",
              "The agent-switch checkpoint failed; the latest prior checkpoint may be stale.",
            ),
          );
        } else {
          this.sessions.supersede(previous.sessionId);
          this.repositories.detachSession(repository.repositoryId, previous.sessionId);
          automationDiagnostics.push(
            ...(await this.record(repository.repositoryId, {
              eventType:
                automatic.status === "created"
                  ? "agent_switch_checkpoint_created"
                  : automatic.status === "duplicate"
                    ? "checkpoint_duplicate"
                    : "checkpoint_skipped_interval",
              host: this.host(previous.agent, previous.client),
              client: previous.client,
              agent: previous.agent,
              sessionId: previous.sessionId,
              ...(previous.activeTaskId === undefined ? {} : { taskId: previous.activeTaskId }),
              ...(automatic.checkpointId === undefined
                ? {}
                : { checkpointId: automatic.checkpointId }),
              ...(automatic.semanticRevision === undefined
                ? {}
                : { semanticRevision: automatic.semanticRevision }),
              ...(automatic.semanticFreshness === undefined
                ? {}
                : { semanticFreshness: automatic.semanticFreshness }),
              outcome: automatic.status === "created" ? "success" : "skipped",
              safeMetadata: {
                checkpointCount: automatic.status === "created" ? 1 : 0,
                ...(automatic.changedPathCount === undefined
                  ? {}
                  : { changedPathCount: automatic.changedPathCount }),
              },
            })),
            ...(await this.record(repository.repositoryId, {
              eventType: "session_superseded",
              host: this.host(previous.agent, previous.client),
              client: previous.client,
              agent: previous.agent,
              sessionId: previous.sessionId,
              ...(previous.activeTaskId === undefined ? {} : { taskId: previous.activeTaskId }),
              outcome: "success",
              reasonCode: "AGENT_SWITCH",
            })),
          );
        }
      }
      const result = await createAgentFoldIntegrationOperations(
        this.context(repository, parsed.target, policy),
      ).openSession({
        client: parsed.client,
        agent: parsed.agent,
        target: parsed.target,
        resumeFormat: parsed.resumeFormat,
      });
      const sessionId =
        typeof result.data === "object" && result.data !== null && "sessionId" in result.data
          ? result.data.sessionId
          : undefined;
      if (typeof sessionId === "string")
        this.repositories.attachSession(repository.repositoryId, sessionId);
      const openedSession =
        typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
      const data =
        typeof result.data === "object" && result.data !== null
          ? {
              ...result.data,
              heartbeatIntervalSeconds: policy.sessions.heartbeatIntervalSeconds,
              ...(openedSession === undefined
                ? {}
                : {
                    leaseExpiresAt: openedSession.leaseExpiresAt,
                    repositoryId: repository.repositoryId,
                  }),
            }
          : result.data;
      const journalDiagnostics = await this.persistJournal();
      return {
        ...result,
        ...(data === undefined ? {} : { data }),
        ...(switchFailed && result.ok ? { status: "partial_success" } : {}),
        diagnostics: [...result.diagnostics, ...automationDiagnostics, ...journalDiagnostics],
      };
    });
  }

  private async heartbeat(params: unknown): Promise<unknown> {
    const parsed = parseParams(sessionLifecycleSchema, params);
    const session = this.sessions.touch(parsed.sessionId);
    if (session === undefined)
      throw new ServiceMethodError("AFSV015", "The service session is not open.");
    const lastPersisted = this.persistedHeartbeatAt.get(parsed.sessionId) ?? 0;
    if (this.now().getTime() - lastPersisted >= 60_000) {
      const diagnostics = await this.persistJournal();
      if (diagnostics.length === 0) {
        this.persistedHeartbeatAt.set(parsed.sessionId, this.now().getTime());
      }
    }
    return {
      sessionId: session.sessionId,
      leaseExpiresAt: session.leaseExpiresAt,
      status: "heartbeat_accepted",
    };
  }

  private async detach(params: unknown): Promise<unknown> {
    const parsed = parseParams(sessionLifecycleSchema, params);
    const session = this.sessions.detach(parsed.sessionId);
    if (session === undefined)
      throw new ServiceMethodError("AFSV015", "The service session is not open.");
    const repository = this.repositories.get(session.repositoryId);
    if (repository !== undefined) {
      await this.record(repository.repositoryId, {
        eventType: "session_detached",
        host: this.host(session.agent, session.client),
        client: session.client,
        agent: session.agent,
        sessionId: session.sessionId,
        ...(session.activeTaskId === undefined ? {} : { taskId: session.activeTaskId }),
        outcome: "warning",
        reasonCode: "CLIENT_DISCONNECT",
      });
    }
    await this.persistJournal();
    return {
      sessionId: session.sessionId,
      state: session.state,
      leaseExpiresAt: session.leaseExpiresAt,
    };
  }

  private async closeSession(params: unknown): Promise<AgentFoldMcpResult> {
    const parsed = parseParams(closeSessionInputSchema, params);
    const located = await this.repositoryForSession(parsed.sessionId);
    return this.queue.run(located.repository.repositoryId, async () => {
      const result = await createAgentFoldIntegrationOperations(
        this.context(located.repository, located.target, located.policy),
      ).closeSession(parsed);
      if (result.ok)
        this.repositories.detachSession(located.repository.repositoryId, parsed.sessionId);
      const journalDiagnostics = await this.persistJournal();
      return journalDiagnostics.length === 0
        ? result
        : { ...result, diagnostics: [...result.diagnostics, ...journalDiagnostics] };
    });
  }

  private async sessionOperation<Schema extends z.ZodType>(
    params: unknown,
    schema: Schema,
    operation:
      "beginTask" | "reportProgress" | "createCheckpoint" | "finishTask" | "getResumePacket",
    serialized: boolean,
  ): Promise<AgentFoldMcpResult> {
    const parsed = parseParams(schema, params) as z.output<Schema> & { readonly sessionId: string };
    const located = await this.repositoryForSession(parsed.sessionId);
    const invoke = async (): Promise<AgentFoldMcpResult> => {
      const operations = createAgentFoldIntegrationOperations(
        this.context(located.repository, located.target, located.policy),
      );
      const handler = operations[operation] as (input: unknown) => Promise<AgentFoldMcpResult>;
      const result = await handler(parsed);
      if (result.ok) {
        const data = resultData(result);
        const sessionId = parsed.sessionId;
        const taskId = stringData(data, "taskId");
        if (operation === "beginTask" && taskId !== undefined) {
          this.sessions.attachTask(sessionId, taskId, "task_started");
        } else if (operation === "reportProgress" && taskId !== undefined) {
          if (result.status === "report_applied") {
            this.sessions.recordReport(sessionId, taskId, numberData(data, "newReportRevision"));
          }
        } else if (operation === "createCheckpoint" && taskId !== undefined) {
          const checkpointId = stringData(data, "checkpointId");
          if (result.status === "checkpoint_created" && checkpointId !== undefined) {
            this.sessions.recordCheckpoint(
              sessionId,
              taskId,
              checkpointId,
              numberData(data, "semanticRevision"),
            );
          } else {
            this.sessions.attachTask(sessionId, taskId);
          }
        } else if (operation === "finishTask") {
          this.sessions.clearTask(sessionId);
        } else if (operation === "getResumePacket") {
          this.sessions.recordResume(sessionId, taskId);
        }
        const journalDiagnostics = await this.persistJournal();
        if (journalDiagnostics.length > 0) {
          return {
            ...result,
            diagnostics: [...result.diagnostics, ...journalDiagnostics],
          };
        }
      }
      return result;
    };
    return serialized ? this.queue.run(located.repository.repositoryId, invoke) : invoke();
  }

  private async resolveRecovery(
    sessionId: string,
    repository: RegisteredRepository,
    trigger: "service_restart" | "heartbeat_timeout",
  ): Promise<readonly Diagnostic[]> {
    const current = this.sessions.get(sessionId);
    if (current === undefined) return [];
    const policy = await this.policy(repository);
    const eventBase = {
      host: this.host(current.agent, current.client),
      client: current.client,
      agent: current.agent,
      sessionId: current.sessionId,
      ...(current.activeTaskId === undefined ? {} : { taskId: current.activeTaskId }),
    } as const;
    if (trigger === "heartbeat_timeout" && current.state !== "recovery_pending") {
      await this.record(repository.repositoryId, {
        eventType: "session_timed_out",
        ...eventBase,
        outcome: "warning",
        reasonCode: "HEARTBEAT_LEASE_EXPIRED",
        safeMetadata: {
          leaseAgeSeconds: Math.max(
            0,
            Math.floor((this.now().getTime() - Date.parse(current.lastHeartbeatAt)) / 1_000),
          ),
        },
      });
      this.sessions.markRecoveryPending(current.sessionId, undefined, "heartbeat_timeout");
    }

    const active = await loadActiveState(this.options.fileSystem, repository.absoluteRoot);
    if (active.status === "error") {
      return this.recoveryFailed(current.sessionId, repository, eventBase, "ACTIVE_STATE_INVALID");
    }
    if (active.status === "missing") {
      await this.record(repository.repositoryId, {
        eventType: "recovery_checkpoint_not_needed",
        ...eventBase,
        outcome: "skipped",
        reasonCode: "NO_ACTIVE_TASK",
      });
      this.sessions.close(
        current.sessionId,
        trigger === "heartbeat_timeout" ? "heartbeat_timeout" : "client_disconnect",
      );
      this.repositories.detachSession(repository.repositoryId, current.sessionId);
      return this.persistJournal();
    }
    if (current.activeTaskId !== undefined && active.state.taskId !== current.activeTaskId) {
      await this.record(repository.repositoryId, {
        eventType: "recovery_checkpoint_not_needed",
        ...eventBase,
        outcome: "warning",
        reasonCode: "TASK_SUPERSEDED",
      });
      this.sessions.supersede(current.sessionId);
      this.repositories.detachSession(repository.repositoryId, current.sessionId);
      return [
        diagnostic(
          "AFREL009",
          "warning",
          "An interrupted session belonged to a different task and was resolved without altering the current task.",
        ),
        ...(await this.persistJournal()),
      ];
    }
    const reliabilityPolicy = this.reliabilityPolicies.get(repository.repositoryId);
    if (trigger === "service_restart" && reliabilityPolicy?.interruptedRecoveryEnabled !== true) {
      await this.record(repository.repositoryId, {
        eventType: "recovery_checkpoint_not_needed",
        ...eventBase,
        taskId: active.state.taskId,
        outcome: "skipped",
        reasonCode: "RESTART_RECOVERY_DISABLED",
      });
      this.sessions.close(current.sessionId, "client_disconnect");
      this.repositories.detachSession(repository.repositoryId, current.sessionId);
      return this.persistJournal();
    }
    if (
      trigger === "heartbeat_timeout" &&
      (!policy.enabled || !policy.checkpoints.recoveryOnTimeout)
    ) {
      await this.record(repository.repositoryId, {
        eventType: "recovery_checkpoint_not_needed",
        ...eventBase,
        taskId: active.state.taskId,
        outcome: "skipped",
        reasonCode: "TIMEOUT_RECOVERY_DISABLED",
      });
      this.sessions.close(current.sessionId, "heartbeat_timeout");
      this.repositories.detachSession(repository.repositoryId, current.sessionId);
      return this.persistJournal();
    }

    const automatic = await createAutomaticCheckpoint({
      repositoryRoot: repository.absoluteRoot,
      agent: current.agent,
      policy,
      trigger,
      fileSystem: this.options.fileSystem,
      gitRepositoryLocator: this.options.gitRepositoryLocator,
      gitInspector: this.options.gitInspector,
      now: this.now,
    });
    if (automatic.status === "failed") {
      return this.recoveryFailed(current.sessionId, repository, eventBase, "CHECKPOINT_FAILED");
    }

    const eventType =
      automatic.status === "created"
        ? "recovery_checkpoint_created"
        : automatic.status === "duplicate"
          ? "recovery_checkpoint_duplicate"
          : automatic.status === "interval_skipped"
            ? "checkpoint_skipped_interval"
            : "recovery_checkpoint_not_needed";
    await this.record(repository.repositoryId, {
      eventType,
      ...eventBase,
      taskId: active.state.taskId,
      ...(automatic.checkpointId === undefined ? {} : { checkpointId: automatic.checkpointId }),
      ...(automatic.semanticRevision === undefined
        ? {}
        : { semanticRevision: automatic.semanticRevision }),
      ...(automatic.semanticFreshness === undefined
        ? {}
        : { semanticFreshness: automatic.semanticFreshness }),
      outcome: automatic.status === "created" ? "recovered" : "skipped",
      reasonCode:
        automatic.status === "duplicate"
          ? "DUPLICATE_FINGERPRINT"
          : automatic.status === "interval_skipped"
            ? "MINIMUM_INTERVAL"
            : automatic.status === "no_active_task"
              ? "NO_ACTIVE_TASK"
              : trigger === "service_restart"
                ? "SERVICE_RESTART"
                : "HEARTBEAT_TIMEOUT",
      safeMetadata: {
        checkpointCount: automatic.status === "created" ? 1 : 0,
        recoveryAttempt: current.recoveryAttempts,
        ...(automatic.changedPathCount === undefined
          ? {}
          : { changedPathCount: automatic.changedPathCount }),
      },
    });
    this.sessions.close(
      current.sessionId,
      trigger === "heartbeat_timeout" ? "heartbeat_timeout" : "client_disconnect",
    );
    this.repositories.detachSession(repository.repositoryId, current.sessionId);
    return this.persistJournal();
  }

  private async recoveryFailed(
    sessionId: string,
    repository: RegisteredRepository,
    eventBase: {
      readonly host: ReliabilityHost;
      readonly client: string;
      readonly agent: string;
      readonly sessionId: string;
      readonly taskId?: string;
    },
    reasonCode: string,
  ): Promise<readonly Diagnostic[]> {
    const failed = this.sessions.scheduleRecoveryFailure(sessionId);
    const attempts = failed?.recoveryAttempts ?? 1;
    await this.record(repository.repositoryId, {
      eventType: "recovery_checkpoint_failed",
      ...eventBase,
      outcome: "failure",
      reasonCode,
      safeMetadata: { recoveryAttempt: attempts },
    });
    await this.record(repository.repositoryId, {
      eventType: "recovery_pending",
      ...eventBase,
      outcome: "warning",
      reasonCode: attempts >= 3 ? "RETRIES_EXHAUSTED" : "RETRY_SCHEDULED",
      safeMetadata: { recoveryAttempt: attempts },
    });
    const journalDiagnostics = await this.persistJournal();
    this.logger.error(
      attempts >= 3
        ? "AFREL013: Interrupted recovery retries are exhausted; the pending record was preserved."
        : "AFREL012: Interrupted recovery failed and a bounded retry was scheduled.",
    );
    return [
      diagnostic(
        attempts >= 3 ? "AFREL013" : "AFREL012",
        "warning",
        attempts >= 3
          ? "Interrupted-session recovery remains pending after three attempts."
          : "Interrupted-session recovery failed and will retry after a bounded delay.",
        "The latest previously valid checkpoint remains available.",
      ),
      ...journalDiagnostics,
    ];
  }

  private async recoverRepositoryInterruptions(
    repository: RegisteredRepository,
  ): Promise<readonly Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    for (const session of this.sessions.forRepository(repository.repositoryId)) {
      if (
        (session.state !== "interrupted" && session.recoveryReason !== "service_restart") ||
        (session.recoveryRetryAt !== undefined &&
          Date.parse(session.recoveryRetryAt) > this.now().getTime())
      ) {
        continue;
      }
      diagnostics.push(
        ...(await this.resolveRecovery(session.sessionId, repository, "service_restart")),
      );
    }
    return diagnostics;
  }

  async recoverStaleSessions(): Promise<void> {
    for (const stale of this.sessions.staleSessions()) {
      const repository = this.repositories.get(stale.repositoryId);
      if (repository === undefined) continue;
      await this.queue.run(repository.repositoryId, async () => {
        const current = this.sessions.get(stale.sessionId);
        if (current === undefined) return;
        if (
          (current.state === "open" || current.state === "detached") &&
          Date.parse(current.leaseExpiresAt) > this.now().getTime()
        )
          return;
        const trigger =
          current.state === "interrupted" || current.recoveryReason === "service_restart"
            ? "service_restart"
            : "heartbeat_timeout";
        await this.resolveRecovery(current.sessionId, repository, trigger);
      });
    }
  }

  unavailableResult(operation: string, message: string): AgentFoldMcpResult {
    return mcpFailure(operation, "service_unavailable", [
      diagnostic("AFSV014", "error", message, "Restart agentfold service and retry."),
    ]);
  }

  sanitizeResult(value: unknown): unknown {
    const roots = this.repositories.all().map((repository) => repository.absoluteRoot);
    const sanitize = (candidate: unknown): unknown => {
      if (typeof candidate === "string") {
        return roots.reduce(
          (current, root) =>
            current.replaceAll(root, ".").replaceAll(root.replaceAll("\\", "/"), "."),
          candidate,
        );
      }
      if (Array.isArray(candidate)) return candidate.map(sanitize);
      if (typeof candidate === "object" && candidate !== null) {
        return Object.fromEntries(
          Object.entries(candidate).map(([key, item]) => [key, sanitize(item)]),
        );
      }
      return candidate;
    };
    const sanitized = sanitize(value);
    if (containsSecretLikeText(JSON.stringify(sanitized))) {
      throw new ServiceMethodError(
        "AFSV027",
        "A secret-like value was withheld from the service response.",
      );
    }
    return sanitized;
  }
}
