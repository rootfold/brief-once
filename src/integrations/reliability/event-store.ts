import path from "node:path";

import { z } from "zod";

import {
  compactReliabilityEventStore,
  parseReliabilityEventStore,
  serializeReliabilityEventStore,
} from "../../core/reliability/serialize-events.js";
import {
  reliabilityEventSchema,
  type ReliabilityEvent,
  type ReliabilityEventInput,
  type ReliabilityEventStore,
} from "../../core/reliability/event-schema.js";
import { AtomicTextFileWriter } from "../../core/filesystem/atomic-text-file-writer.js";
import type { FileSystem } from "../../core/filesystem/filesystem.js";
import { isPathInside } from "../../core/context/path-boundary.js";

export class ReliabilityStoreError extends Error {
  constructor(
    readonly code: "corrupt" | "unsafe" | "write_failed",
    message: string,
  ) {
    super(message);
    this.name = "ReliabilityStoreError";
  }
}

export interface ReliabilityEventStoreOptions {
  readonly fileSystem: FileSystem;
  readonly stateDirectory: string;
  readonly repositoryId: string;
  readonly maximumEvents: number;
  readonly retainClosedSessions?: number;
  readonly now?: () => Date;
  readonly generateEventId?: () => string;
  readonly restrictDirectory?: (directory: string) => Promise<void>;
  readonly restrictFile?: (filePath: string) => Promise<void>;
}

async function defaultRestrictDirectory(directory: string): Promise<void> {
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(directory, 0o700);
  }
}

async function defaultRestrictFile(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(filePath, 0o600);
  }
}

export class PersistentReliabilityEventStore {
  readonly directory: string;
  readonly filePath: string;
  private readonly now: () => Date;
  private readonly generateEventId: () => string;

  constructor(private readonly options: ReliabilityEventStoreOptions) {
    this.directory = path.join(options.stateDirectory, "reliability", options.repositoryId);
    this.filePath = path.join(this.directory, "events.json");
    this.now = options.now ?? (() => new Date());
    this.generateEventId = options.generateEventId ?? (() => crypto.randomUUID());
  }

  private async rejectUnsafeFile(): Promise<void> {
    const reliabilityDirectory = path.join(this.options.stateDirectory, "reliability");
    if (this.options.fileSystem.isSymbolicLink !== undefined) {
      for (const candidate of [reliabilityDirectory, this.directory]) {
        if (
          (await this.options.fileSystem.exists(candidate)) &&
          (await this.options.fileSystem.isSymbolicLink(candidate))
        ) {
          throw new ReliabilityStoreError(
            "unsafe",
            "The reliability event store directory is a symbolic link.",
          );
        }
      }
    }
    if (
      this.options.fileSystem.isSymbolicLink !== undefined &&
      (await this.options.fileSystem.isSymbolicLink(this.filePath))
    ) {
      throw new ReliabilityStoreError("unsafe", "The reliability event store is a symbolic link.");
    }
  }

  async read(): Promise<ReliabilityEventStore | undefined> {
    await this.rejectUnsafeFile();
    if (!(await this.options.fileSystem.exists(this.filePath))) return undefined;
    try {
      const source = (await this.options.fileSystem.readText(this.filePath))
        .replace(/^\uFEFF/u, "")
        .replace(/\r\n?/gu, "\n");
      return parseReliabilityEventStore(JSON.parse(source));
    } catch (error: unknown) {
      if (error instanceof ReliabilityStoreError) throw error;
      throw new ReliabilityStoreError(
        "corrupt",
        error instanceof z.ZodError
          ? "The reliability event store schema is invalid."
          : "The reliability event store is not valid JSON.",
      );
    }
  }

  async record(input: ReliabilityEventInput): Promise<{
    readonly event: ReliabilityEvent;
    readonly compacted: boolean;
  }> {
    const existing =
      (await this.read()) ??
      parseReliabilityEventStore({
        schemaVersion: 1,
        repositoryId: this.options.repositoryId,
        nextSequence: 1,
        events: [],
      });
    const event = reliabilityEventSchema.parse({
      schemaVersion: 1,
      eventId: this.generateEventId(),
      sequence: existing.nextSequence,
      occurredAt: this.now().toISOString(),
      repositoryId: this.options.repositoryId,
      ...input,
    });
    const candidateEvents = [...existing.events, event];
    const boundedCandidateEvents =
      candidateEvents.length <= this.options.maximumEvents
        ? candidateEvents
        : candidateEvents.slice(candidateEvents.length - this.options.maximumEvents);
    const compacted = compactReliabilityEventStore(
      parseReliabilityEventStore({
        ...existing,
        nextSequence: existing.nextSequence + 1,
        events: boundedCandidateEvents,
      }),
      this.options.maximumEvents,
      this.options.retainClosedSessions ?? 100,
    );
    await this.options.fileSystem.ensureDirectory(this.directory);
    const [realStateDirectory, realEventDirectory] = await Promise.all([
      this.options.fileSystem.realPath(this.options.stateDirectory),
      this.options.fileSystem.realPath(this.directory),
    ]);
    if (!isPathInside(realStateDirectory, realEventDirectory)) {
      throw new ReliabilityStoreError(
        "unsafe",
        "The reliability event store directory resolves outside private state.",
      );
    }
    await (this.options.restrictDirectory ?? defaultRestrictDirectory)(this.directory);
    await this.rejectUnsafeFile();
    try {
      await new AtomicTextFileWriter(this.options.fileSystem).write(
        this.filePath,
        serializeReliabilityEventStore(compacted.store),
        (await this.options.fileSystem.exists(this.filePath)) ? "replace" : "create",
      );
      await (this.options.restrictFile ?? defaultRestrictFile)(this.filePath);
      return {
        event,
        compacted: boundedCandidateEvents.length !== candidateEvents.length || compacted.compacted,
      };
    } catch (error: unknown) {
      if (error instanceof ReliabilityStoreError) throw error;
      throw new ReliabilityStoreError(
        "write_failed",
        "The reliability event store could not be written atomically.",
      );
    }
  }
}
