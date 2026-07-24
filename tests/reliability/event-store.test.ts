import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../src/core/config/parse-config.js";
import {
  defaultReliabilityPolicy,
  resolveReliabilityPolicy,
} from "../../src/core/config/reliability-policy.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import {
  reliabilityEventSchema,
  reliabilityEventStoreSchema,
} from "../../src/core/reliability/event-schema.js";
import {
  compactReliabilityEventStore,
  serializeReliabilityEventStore,
} from "../../src/core/reliability/serialize-events.js";
import { PersistentReliabilityEventStore } from "../../src/integrations/reliability/event-store.js";
import { createReliabilityRecorder } from "../../src/integrations/reliability/recorder.js";
import {
  persistentSessionJournalSchema,
  safePersistentSessionSummary,
} from "../../src/integrations/reliability/session-journal-schema.js";
import { PersistentSessionJournalStore } from "../../src/integrations/reliability/session-journal-store.js";
import { resolveReliabilityStateDirectory } from "../../src/integrations/reliability/state-directory.js";

const temporaryDirectories: string[] = [];
const repositoryId = "0123456789abcdef01234567";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryState(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentfold reliability state "));
  temporaryDirectories.push(directory);
  return directory;
}

describe("reliability schemas and deterministic storage", () => {
  it("validates backward-compatible configuration defaults and ranges", () => {
    expect(resolveReliabilityPolicy()).toEqual(defaultReliabilityPolicy);
    expect(
      resolveReliabilityPolicy({
        enabled: false,
        maximum_events_per_repository: 250,
        retain_closed_sessions: 25,
        interrupted_recovery_enabled: true,
      }),
    ).toEqual({
      enabled: false,
      maximumEventsPerRepository: 250,
      retainClosedSessions: 25,
      interruptedRecoveryEnabled: true,
    });
    const legacy = parseConfig({
      version: 1,
      project: { name: "Legacy", summary: "" },
      runtime: { node: ">=20" },
      commands: {},
      state: { visibility: "local" },
      safety: { respect_gitignore: true, excluded_paths: [] },
    });
    expect(legacy.reliability).toBeUndefined();
    expect(() =>
      parseConfig({
        ...legacy,
        reliability: { maximum_events_per_repository: 99 },
      }),
    ).toThrow(/>=100/u);
  });

  it("round-trips strict events, Unicode labels, stable JSON, and one final newline", () => {
    const event = reliabilityEventSchema.parse({
      schemaVersion: 1,
      eventId: "event-ü-1",
      sequence: 1,
      occurredAt: "2026-07-24T10:00:00.000Z",
      repositoryId,
      eventType: "session_opened",
      host: "codex",
      client: "Codex 桌面",
      agent: "codex",
      sessionId: "session-1",
      outcome: "success",
    });
    const store = reliabilityEventStoreSchema.parse({
      schemaVersion: 1,
      repositoryId,
      nextSequence: 2,
      events: [event],
    });
    const first = serializeReliabilityEventStore(store);
    expect(serializeReliabilityEventStore(JSON.parse(first))).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
    expect(JSON.parse(first).events[0].client).toBe("Codex 桌面");
  });

  it("rejects invalid, unsupported, unbounded, and privacy-unsafe fields", () => {
    const base = {
      schemaVersion: 1,
      eventId: "event-1",
      sequence: 1,
      occurredAt: "2026-07-24T10:00:00.000Z",
      repositoryId,
      eventType: "session_opened",
      outcome: "success",
    };
    expect(reliabilityEventSchema.safeParse({ ...base, prompt: "SECRET-PROMPT" }).success).toBe(
      false,
    );
    expect(
      reliabilityEventSchema.safeParse({ ...base, changedPaths: ["src/secret.ts"] }).success,
    ).toBe(false);
    expect(reliabilityEventSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
    expect(reliabilityEventSchema.safeParse({ ...base, client: "x".repeat(101) }).success).toBe(
      false,
    );
  });

  it("injects event IDs, preserves monotonic sequences, accepts BOM/CRLF, and compacts oldest events", async () => {
    const stateDirectory = await temporaryState();
    let id = 0;
    let now = new Date("2026-07-24T10:00:00.000Z");
    const store = new PersistentReliabilityEventStore({
      fileSystem: new NodeFileSystem(),
      stateDirectory,
      repositoryId,
      maximumEvents: 3,
      now: () => now,
      generateEventId: () => `event-${++id}`,
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    for (let index = 0; index < 5; index += 1) {
      now = new Date(now.getTime() + 1_000);
      await store.record({
        eventType: "session_opened",
        host: "codex",
        sessionId: `session-${index}`,
        outcome: "success",
      });
    }
    const loaded = await store.read();
    expect(loaded?.events.map((event) => event.sequence)).toEqual([3, 4, 5]);
    expect(loaded?.events.map((event) => event.eventId)).toEqual(["event-3", "event-4", "event-5"]);
    expect(loaded?.nextSequence).toBe(6);

    const original = await readFile(store.filePath, "utf8");
    await new NodeFileSystem().writeText(
      store.filePath,
      `\uFEFF${original.replace(/\n/gu, "\r\n")}`,
    );
    expect((await store.read())?.events).toHaveLength(3);

    const compacted = compactReliabilityEventStore(loaded!, 2);
    expect(compacted.compacted).toBe(true);
    expect(compacted.store.events.map((event) => event.sequence)).toEqual([4, 5]);
    expect(compacted.store.nextSequence).toBe(6);
  });

  it("bounds closed-session history independently of total event retention", () => {
    const stored = reliabilityEventStoreSchema.parse({
      schemaVersion: 1,
      repositoryId,
      nextSequence: 5,
      events: [
        ["session_opened", "old-session"],
        ["session_closed", "old-session"],
        ["session_opened", "new-session"],
        ["session_closed", "new-session"],
      ].map(([eventType, sessionId], index) => ({
        schemaVersion: 1,
        eventId: `event-${index + 1}`,
        sequence: index + 1,
        occurredAt: new Date(Date.UTC(2026, 6, 24, 10, index)).toISOString(),
        repositoryId,
        eventType,
        sessionId,
        outcome: "success",
      })),
    });
    const compacted = compactReliabilityEventStore(stored, 100, 1);
    expect(compacted.store.events.map((event) => event.sessionId)).toEqual([
      "new-session",
      "new-session",
    ]);
    expect(compacted.store.nextSequence).toBe(5);
  });

  it("preserves the prior event store after an atomic rename failure", async () => {
    const stateDirectory = await temporaryState();
    const fileSystem = new NodeFileSystem();
    const initial = new PersistentReliabilityEventStore({
      fileSystem,
      stateDirectory,
      repositoryId,
      maximumEvents: 100,
      generateEventId: () => "event-initial",
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    await initial.record({ eventType: "service_started", outcome: "success" });
    const before = await readFile(initial.filePath, "utf8");
    class RenameFailureFileSystem extends NodeFileSystem {
      override rename(): Promise<void> {
        return Promise.reject(new Error("simulated rename failure"));
      }
    }
    const failing = new PersistentReliabilityEventStore({
      fileSystem: new RenameFailureFileSystem(),
      stateDirectory,
      repositoryId,
      maximumEvents: 100,
      generateEventId: () => "event-failed",
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    await expect(
      failing.record({ eventType: "service_stopped", outcome: "success" }),
    ).rejects.toThrow(/atomically/u);
    expect(await readFile(initial.filePath, "utf8")).toBe(before);
  });

  it("leaves existing reliability history untouched when persistence is disabled", async () => {
    const stateDirectory = await temporaryState();
    const fileSystem = new NodeFileSystem();
    const enabled = createReliabilityRecorder({
      repositoryId,
      stateDirectory,
      policy: defaultReliabilityPolicy,
      fileSystem,
      generateEventId: () => "event-enabled",
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    await enabled.record({
      eventType: "service_started",
      host: "unknown",
      outcome: "success",
    });
    const eventPath = path.join(stateDirectory, "reliability", repositoryId, "events.json");
    const before = await readFile(eventPath, "utf8");
    const disabled = createReliabilityRecorder({
      repositoryId,
      stateDirectory,
      policy: { ...defaultReliabilityPolicy, enabled: false },
      fileSystem,
    });
    expect(disabled.enabled).toBe(false);
    await disabled.record({
      eventType: "service_stopped",
      host: "unknown",
      outcome: "success",
    });
    expect(await readFile(eventPath, "utf8")).toBe(before);
  });

  it("writes and reads a bounded private journal without exposing repository roots in summaries", async () => {
    const stateDirectory = await temporaryState();
    const store = new PersistentSessionJournalStore({
      fileSystem: new NodeFileSystem(),
      stateDirectory,
      restrictFile: () => Promise.resolve(),
    });
    const record = {
      sessionId: "session-1",
      repositoryId,
      canonicalRepositoryRoot: path.join(stateDirectory, "private repo path"),
      host: "codex" as const,
      client: "codex-desktop",
      agent: "codex",
      taskId: "AF-20260724-001",
      openedAt: "2026-07-24T10:00:00.000Z",
      lastHeartbeatAt: "2026-07-24T10:01:00.000Z",
      leaseExpiresAt: "2026-07-24T10:02:00.000Z",
      state: "open" as const,
      lastLifecycleEvent: "report_submitted" as const,
      semanticRevision: 1,
      reportCount: 1,
      checkpointCount: 0,
      recoveryAttempts: 0,
    };
    await store.write({
      schemaVersion: 1,
      serviceInstanceId: "service-1",
      writtenAt: "2026-07-24T10:01:00.000Z",
      sessions: [record],
    });
    expect((await store.read())?.sessions[0]).toEqual(record);
    expect(JSON.stringify(safePersistentSessionSummary(record))).not.toContain(
      record.canonicalRepositoryRoot,
    );
    expect(
      persistentSessionJournalSchema.safeParse({
        schemaVersion: 1,
        serviceInstanceId: "service-1",
        writtenAt: "2026-07-24T10:01:00.000Z",
        sessions: [{ ...record, capabilityToken: "SECRET-TOKEN" }],
      }).success,
    ).toBe(false);
    expect(
      persistentSessionJournalSchema.safeParse({
        schemaVersion: 1,
        serviceInstanceId: "service-1",
        writtenAt: "2026-07-24T10:01:00.000Z",
        sessions: [{ ...record, client: "USER PROMPT CONTENT" }],
      }).success,
    ).toBe(false);
  });

  it("resolves persistent user-state locations on Windows, macOS, and Linux", () => {
    expect(
      resolveReliabilityStateDirectory({
        platform: "win32",
        environment: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
        homeDirectory: "C:\\Users\\dev",
      }),
    ).toBe("C:\\Users\\dev\\AppData\\Local\\AgentFold\\state");
    expect(
      resolveReliabilityStateDirectory({
        platform: "darwin",
        environment: {},
        homeDirectory: "/Users/dev",
      }),
    ).toBe("/Users/dev/Library/Application Support/AgentFold/state");
    expect(
      resolveReliabilityStateDirectory({
        platform: "linux",
        environment: { XDG_STATE_HOME: "/state/dev" },
        homeDirectory: "/home/dev",
      }),
    ).toBe("/state/dev/agentfold");
  });

  it.runIf(process.platform !== "win32")("uses restrictive POSIX file permissions", async () => {
    const stateDirectory = await temporaryState();
    const store = new PersistentReliabilityEventStore({
      fileSystem: new NodeFileSystem(),
      stateDirectory,
      repositoryId,
      maximumEvents: 100,
      generateEventId: () => "event-permissions",
    });
    await store.record({ eventType: "service_started", outcome: "success" });
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
  });
});
