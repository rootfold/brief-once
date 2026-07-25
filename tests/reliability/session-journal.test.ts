import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { loadConfig } from "../../src/core/config/load-config.js";
import { parseConfig } from "../../src/core/config/parse-config.js";
import { serializeConfig } from "../../src/core/config/serialize-config.js";
import { PersistentReliabilityEventStore } from "../../src/integrations/reliability/event-store.js";
import type { PersistentSessionJournal } from "../../src/integrations/reliability/session-journal-schema.js";
import { PersistentSessionJournalStore } from "../../src/integrations/reliability/session-journal-store.js";
import { AgentFoldServiceCoordinator } from "../../src/integrations/service/service-coordinator.js";
import { ServiceSessionRegistry } from "../../src/integrations/service/session-registry.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];
const repositoryId = "0123456789abcdef01234567";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class CountingJournalStore extends PersistentSessionJournalStore {
  writes = 0;

  override async write(journal: PersistentSessionJournal): Promise<void> {
    this.writes += 1;
    await super.write(journal);
  }
}

describe("persistent session journal behavior", () => {
  it("debounces heartbeat writes and removes normally closed sessions", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold heartbeat journal ",
    });
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold heartbeat state "));
    temporaryDirectories.push(stateDirectory);
    const store = new CountingJournalStore({
      fileSystem: fixture.fileSystem,
      stateDirectory,
      restrictFile: () => Promise.resolve(),
    });
    let now = new Date("2026-07-24T10:00:00.000Z");
    const coordinator = new AgentFoldServiceCoordinator({
      version: "0.0.0-test",
      startedAt: now.toISOString(),
      processId: 1,
      endpointKind: process.platform === "win32" ? "named-pipe" : "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true),
      sessionJournalStore: store,
      generateServiceInstanceId: () => "service-heartbeat",
      generateSessionId: () => "session-heartbeat",
      now: () => now,
    });
    await coordinator.initialize();
    await coordinator.handle("session.open", {
      workspace: fixture.root,
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    const afterOpen = store.writes;
    now = new Date("2026-07-24T10:00:20.000Z");
    await coordinator.handle("session.heartbeat", { sessionId: "session-heartbeat" });
    expect(store.writes).toBe(afterOpen);
    now = new Date("2026-07-24T10:01:21.000Z");
    await coordinator.handle("session.heartbeat", { sessionId: "session-heartbeat" });
    expect(store.writes).toBe(afterOpen + 1);
    await coordinator.handle("session.close", { sessionId: "session-heartbeat" });
    expect((await store.read())?.sessions).toEqual([]);
  });

  it("persists detach and clears finished-task association before normal close", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold journal lifecycle ",
    });
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold journal lifecycle "));
    temporaryDirectories.push(stateDirectory);
    let sessionSequence = 0;
    const coordinator = new AgentFoldServiceCoordinator({
      version: "0.0.0-test",
      startedAt: "2026-07-24T10:00:00.000Z",
      processId: 2,
      endpointKind: process.platform === "win32" ? "named-pipe" : "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true),
      reliabilityStateDirectory: stateDirectory,
      generateServiceInstanceId: () => "service-journal-lifecycle",
      generateSessionId: () => `session-journal-${++sessionSequence}`,
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    });
    await coordinator.initialize();
    await coordinator.handle("session.open", {
      workspace: fixture.root,
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    await coordinator.handle("integration.begin_task", {
      sessionId: "session-journal-1",
      title: "Journal lifecycle",
    });
    await coordinator.handle("integration.report_progress", {
      sessionId: "session-journal-1",
      completed: ["Recorded semantic progress"],
    });
    await coordinator.handle("integration.finish_task", {
      sessionId: "session-journal-1",
      summary: "Journal lifecycle completed.",
      finalReport: {
        validation: [{ command: "pnpm test", status: "passed", summary: "Passed" }],
      },
    });
    const store = new PersistentSessionJournalStore({
      fileSystem: fixture.fileSystem,
      stateDirectory,
    });
    expect((await store.read())?.sessions[0]?.taskId).toBeUndefined();
    await coordinator.handle("session.close", { sessionId: "session-journal-1" });
    expect((await store.read())?.sessions).toEqual([]);

    await coordinator.handle("session.open", {
      workspace: fixture.root,
      client: "antigravity-app",
      agent: "antigravity",
      target: "antigravity",
      resumeFormat: "json",
    });
    await coordinator.handle("session.detach", { sessionId: "session-journal-2" });
    expect((await store.read())?.sessions[0]).toMatchObject({
      sessionId: "session-journal-2",
      state: "detached",
      lastLifecycleEvent: "detached",
    });
  }, 30_000);

  it("uses bounded exponential retries and stops automatic retry scheduling after three failures", () => {
    let now = new Date("2026-07-24T10:00:00.000Z");
    const sessions = new ServiceSessionRegistry({ now: () => now });
    sessions.restoreInterrupted(
      {
        sessionId: "session-retry",
        repositoryId,
        canonicalRepositoryRoot: "/private/repository",
        host: "codex",
        client: "codex-desktop",
        agent: "codex",
        taskId: "AF-20260724-001",
        openedAt: now.toISOString(),
        lastHeartbeatAt: now.toISOString(),
        leaseExpiresAt: now.toISOString(),
        state: "open",
        lastLifecycleEvent: "report_submitted",
        reportCount: 1,
        checkpointCount: 0,
        recoveryAttempts: 0,
      },
      90,
    );
    expect(sessions.get("session-retry")?.state).toBe("interrupted");
    expect(sessions.scheduleRecoveryFailure("session-retry")).toMatchObject({
      recoveryAttempts: 1,
      recoveryRetryAt: "2026-07-24T10:01:00.000Z",
    });
    now = new Date("2026-07-24T10:01:00.000Z");
    expect(sessions.scheduleRecoveryFailure("session-retry")).toMatchObject({
      recoveryAttempts: 2,
      recoveryRetryAt: "2026-07-24T10:03:00.000Z",
    });
    now = new Date("2026-07-24T10:03:00.000Z");
    const exhausted = sessions.scheduleRecoveryFailure("session-retry");
    expect(exhausted?.recoveryAttempts).toBe(3);
    expect(exhausted?.recoveryRetryAt).toBeUndefined();
    expect(sessions.staleSessions()).toEqual([]);
  });

  it("reports reliability disabled after repository policy resolution while keeping recovery journal available", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold disabled reliability ",
    });
    const configPath = path.join(fixture.root, ".briefonce", "config.yaml");
    const config = await loadConfig(fixture.fileSystem, configPath);
    await fixture.fileSystem.writeText(
      configPath,
      serializeConfig(
        parseConfig({
          ...config,
          reliability: {
            enabled: false,
            interrupted_recovery_enabled: true,
          },
        }),
      ),
    );
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold disabled state "));
    temporaryDirectories.push(stateDirectory);
    const coordinator = new AgentFoldServiceCoordinator({
      version: "0.0.0-test",
      startedAt: "2026-07-24T10:00:00.000Z",
      processId: 3,
      endpointKind: process.platform === "win32" ? "named-pipe" : "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true),
      reliabilityStateDirectory: stateDirectory,
      generateServiceInstanceId: () => "service-disabled",
      generateSessionId: () => "session-disabled",
      now: () => new Date("2026-07-24T10:00:00.000Z"),
    });
    await coordinator.initialize();
    await coordinator.handle("session.open", {
      workspace: fixture.root,
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    expect(await coordinator.handle("service.status", {})).toMatchObject({
      reliabilityPersistenceEnabled: false,
      openSessionCount: 1,
    });
    await expect(
      fixture.fileSystem.exists(path.join(stateDirectory, "session-journal.json")),
    ).resolves.toBe(true);
    await expect(fixture.fileSystem.exists(path.join(stateDirectory, "reliability"))).resolves.toBe(
      false,
    );
  });

  it("rejects corrupt journals and unsafe event-store symlinks without rewriting", async () => {
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold corrupt state "));
    temporaryDirectories.push(stateDirectory);
    const fileSystem = new NodeFileSystem();
    const journal = new PersistentSessionJournalStore({
      fileSystem,
      stateDirectory,
      restrictFile: () => Promise.resolve(),
    });
    await writeFile(journal.filePath, JSON.stringify({ schemaVersion: 2 }), "utf8");
    await expect(journal.read()).rejects.toThrow(/schema/u);
    expect(await fileSystem.readText(journal.filePath)).toContain('"schemaVersion":2');

    class SymlinkFileSystem extends NodeFileSystem {
      override isSymbolicLink(candidate: string): Promise<boolean> {
        return Promise.resolve(
          candidate.endsWith("events.json") || candidate.endsWith("session-journal.json"),
        );
      }
    }
    const events = new PersistentReliabilityEventStore({
      fileSystem: new SymlinkFileSystem(),
      stateDirectory,
      repositoryId,
      maximumEvents: 100,
    });
    await expect(events.read()).rejects.toThrow(/symbolic link/u);
    const unsafeJournal = new PersistentSessionJournalStore({
      fileSystem: new SymlinkFileSystem(),
      stateDirectory,
    });
    await expect(unsafeJournal.read()).rejects.toThrow(/symbolic link/u);
  });

  it("preserves the prior journal after an atomic rename failure", async () => {
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold journal atomic "));
    temporaryDirectories.push(stateDirectory);
    const initial = new PersistentSessionJournalStore({
      fileSystem: new NodeFileSystem(),
      stateDirectory,
      restrictFile: () => Promise.resolve(),
    });
    const journal: PersistentSessionJournal = {
      schemaVersion: 1,
      serviceInstanceId: "service-atomic",
      writtenAt: "2026-07-24T10:00:00.000Z",
      sessions: [],
    };
    await initial.write(journal);
    const before = await readFile(initial.filePath, "utf8");
    class RenameFailureFileSystem extends NodeFileSystem {
      override rename(): Promise<void> {
        return Promise.reject(new Error("simulated journal rename failure"));
      }
    }
    const failing = new PersistentSessionJournalStore({
      fileSystem: new RenameFailureFileSystem(),
      stateDirectory,
      restrictFile: () => Promise.resolve(),
    });
    await expect(
      failing.write({
        ...journal,
        serviceInstanceId: "service-atomic-next",
        writtenAt: "2026-07-24T10:01:00.000Z",
      }),
    ).rejects.toThrow(/atomically/u);
    expect(await readFile(initial.filePath, "utf8")).toBe(before);
  });
});
