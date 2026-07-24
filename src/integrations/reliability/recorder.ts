import { randomUUID } from "node:crypto";

import type { ReliabilityPolicy } from "../../core/config/reliability-policy.js";
import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";
import type {
  ReliabilityEvent,
  ReliabilityEventInput,
} from "../../core/reliability/event-schema.js";
import { containsSecretLikeText } from "../../core/reports/redact-secrets.js";
import { PersistentReliabilityEventStore, ReliabilityStoreError } from "./event-store.js";

export interface ReliabilityRecorder {
  readonly enabled: boolean;
  readonly repositoryId: string;
  record(input: ReliabilityEventInput): Promise<readonly Diagnostic[]>;
  read(): Promise<readonly ReliabilityEvent[]>;
}

export interface CreateReliabilityRecorderInput {
  readonly repositoryId: string;
  readonly stateDirectory: string;
  readonly policy: ReliabilityPolicy;
  readonly fileSystem: ConstructorParameters<
    typeof PersistentReliabilityEventStore
  >[0]["fileSystem"];
  readonly now?: () => Date;
  readonly generateEventId?: () => string;
  readonly restrictDirectory?: (directory: string) => Promise<void>;
  readonly restrictFile?: (filePath: string) => Promise<void>;
}

function persistenceDiagnostic(error: unknown): Diagnostic {
  const storeError = error instanceof ReliabilityStoreError ? error : undefined;
  return {
    code:
      storeError?.code === "corrupt"
        ? "AFREL004"
        : storeError?.code === "unsafe"
          ? "AFREL005"
          : "AFREL003",
    severity: "warning",
    message:
      storeError?.code === "corrupt"
        ? "Reliability history is corrupt; the lifecycle operation still succeeded."
        : storeError?.code === "unsafe"
          ? "Unsafe reliability-state symlink was rejected; the lifecycle operation still succeeded."
          : "Reliability metadata could not be persisted; the lifecycle operation still succeeded.",
    suggestion:
      "Review the private AgentFold user-state directory; repository state was preserved.",
  };
}

class DisabledReliabilityRecorder implements ReliabilityRecorder {
  readonly enabled = false;

  constructor(readonly repositoryId: string) {}

  record(): Promise<readonly Diagnostic[]> {
    return Promise.resolve([]);
  }

  read(): Promise<readonly ReliabilityEvent[]> {
    return Promise.resolve([]);
  }
}

class StoreReliabilityRecorder implements ReliabilityRecorder {
  readonly enabled = true;
  private readonly store: PersistentReliabilityEventStore;

  constructor(input: CreateReliabilityRecorderInput) {
    this.repositoryId = input.repositoryId;
    this.store = new PersistentReliabilityEventStore({
      fileSystem: input.fileSystem,
      stateDirectory: input.stateDirectory,
      repositoryId: input.repositoryId,
      maximumEvents: input.policy.maximumEventsPerRepository,
      retainClosedSessions: input.policy.retainClosedSessions,
      ...(input.now === undefined ? {} : { now: input.now }),
      generateEventId: input.generateEventId ?? (() => `rel-${randomUUID()}`),
      ...(input.restrictDirectory === undefined
        ? {}
        : { restrictDirectory: input.restrictDirectory }),
      ...(input.restrictFile === undefined ? {} : { restrictFile: input.restrictFile }),
    });
  }

  readonly repositoryId: string;

  async record(input: ReliabilityEventInput): Promise<readonly Diagnostic[]> {
    try {
      const sanitized = { ...input };
      delete sanitized.client;
      delete sanitized.agent;
      if (
        sanitized.sessionId !== undefined &&
        (containsSecretLikeText(sanitized.sessionId) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(sanitized.sessionId))
      ) {
        delete sanitized.sessionId;
      }
      const result = await this.store.record(sanitized);
      return result.compacted
        ? [
            {
              code: "AFREL006",
              severity: "info",
              message:
                "Oldest reliability events were compacted by the configured retention limit.",
            },
          ]
        : [];
    } catch (error: unknown) {
      return [persistenceDiagnostic(error)];
    }
  }

  async read(): Promise<readonly ReliabilityEvent[]> {
    const store = await this.store.read();
    return store?.events ?? [];
  }
}

export function createReliabilityRecorder(
  input: CreateReliabilityRecorderInput,
): ReliabilityRecorder {
  return input.policy.enabled
    ? new StoreReliabilityRecorder(input)
    : new DisabledReliabilityRecorder(input.repositoryId);
}
