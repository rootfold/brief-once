import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CheckpointGitFacts } from "../../src/core/git/checkpoint-git-types.js";
import { loadActiveState } from "../../src/core/state/load-active-state.js";
import { PersistentReliabilityEventStore } from "../../src/integrations/reliability/event-store.js";
import { AgentFoldServiceCoordinator } from "../../src/integrations/service/service-coordinator.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function data(result: unknown): Readonly<Record<string, unknown>> {
  return typeof result === "object" &&
    result !== null &&
    "data" in result &&
    typeof result.data === "object" &&
    result.data !== null
    ? Object.fromEntries(Object.entries(result.data))
    : {};
}

function dirtyFacts(): CheckpointGitFacts {
  return {
    branch: "main",
    commit: "0123456789abcdef0123456789abcdef01234567",
    detached: false,
    workingTree: "dirty",
    hasStagedChanges: false,
    hasUnstagedChanges: true,
    changedPaths: {
      added: [],
      modified: ["src/reliability.ts"],
      deleted: [],
      renamed: [],
      copied: [],
      untracked: [],
      unmerged: [],
    },
    diffStatistics: {
      filesChanged: 1,
      insertions: 12,
      deletions: 1,
      binaryFiles: 0,
      untrackedFiles: 0,
    },
    recentCommits: [],
  };
}

class FailingCheckpointInspector extends StubGitInspector {
  override readCheckpointFacts(): ReturnType<StubGitInspector["readCheckpointFacts"]> {
    return Promise.reject(new Error("simulated checkpoint inspection failure"));
  }
}

describe("persistent service-restart recovery", () => {
  it("detects an interrupted session and creates one recovery checkpoint without finishing", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold restart repository with spaces ",
    });
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold private state "));
    temporaryDirectories.push(stateDirectory);
    let now = new Date("2026-07-24T10:00:00.000Z");
    let eventSequence = 0;
    const first = new AgentFoldServiceCoordinator({
      version: "0.0.0-test",
      startedAt: now.toISOString(),
      processId: 1001,
      endpointKind: process.platform === "win32" ? "named-pipe" : "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true),
      reliabilityStateDirectory: stateDirectory,
      generateServiceInstanceId: () => "service-instance-one",
      generateSessionId: () => "restart-session-1",
      generateEventId: () => `restart-event-${++eventSequence}`,
      now: () => now,
    });
    await first.initialize();
    const opened = await first.handle("session.open", {
      workspace: fixture.root,
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    const sessionId = String(data(opened).sessionId);
    const repositoryId = String(data(opened).repositoryId);
    const started = await first.handle("integration.begin_task", {
      sessionId,
      title: "Recover interrupted work",
    });
    const taskId = String(data(started).taskId);
    await first.handle("integration.report_progress", {
      sessionId,
      completed: ["Added bounded lifecycle metadata"],
      nextActions: ["Verify restart recovery"],
    });

    now = new Date("2026-07-24T10:02:00.000Z");
    const second = new AgentFoldServiceCoordinator({
      version: "0.0.0-test",
      startedAt: now.toISOString(),
      processId: 1002,
      endpointKind: process.platform === "win32" ? "named-pipe" : "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true, dirtyFacts()),
      reliabilityStateDirectory: stateDirectory,
      generateServiceInstanceId: () => "service-instance-two",
      generateSessionId: () => "restart-session-2",
      generateEventId: () => `restart-event-${++eventSequence}`,
      now: () => now,
    });
    await second.initialize();
    expect(second.sessions.get(sessionId)?.state).toBe("interrupted");
    expect(await second.handle("service.status", {})).toMatchObject({
      interruptedSessionCount: 1,
      recoveryPendingSessionCount: 0,
      reliabilityPersistenceEnabled: true,
    });

    await second.recoverStaleSessions();
    expect(second.sessions.get(sessionId)?.state).toBe("closed");
    const active = await loadActiveState(fixture.fileSystem, fixture.root);
    expect(active.status).toBe("success");
    if (active.status === "success") {
      expect(active.state.taskId).toBe(taskId);
      expect(active.state.status).toBe("active");
      expect(active.state.reportRevision).toBe(1);
      expect(active.state.checkpointHistory.count).toBe(1);
    }
    await expect(
      fixture.fileSystem.exists(path.join(fixture.root, ".briefonce", "state", "completed")),
    ).resolves.toBe(false);

    const store = new PersistentReliabilityEventStore({
      fileSystem: fixture.fileSystem,
      stateDirectory,
      repositoryId,
      maximumEvents: 1_000,
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    const events = (await store.read())?.events ?? [];
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "session_interrupted",
        "service_restarted_with_interrupted_sessions",
        "recovery_checkpoint_created",
      ]),
    );
    expect(
      events.find((event) => event.eventType === "recovery_checkpoint_created")?.semanticFreshness,
    ).toBe("current");

    const next = await second.handle("session.open", {
      workspace: fixture.root,
      client: "antigravity-ide",
      agent: "antigravity",
      target: "antigravity",
      resumeFormat: "json",
    });
    expect((next as { status: string }).status).toBe("resumable");
    expect(data(next)).toMatchObject({ task: { taskId } });

    const privateFiles = await Promise.all(
      [
        path.join(stateDirectory, "session-journal.json"),
        path.join(stateDirectory, "reliability", repositoryId, "events.json"),
      ].map((file) => readFile(file, "utf8")),
    );
    expect(privateFiles.join("\n")).not.toMatch(
      /Added bounded lifecycle metadata|Verify restart recovery|src\/reliability\.ts|SECRET/iu,
    );
  }, 30_000);

  it("resolves interrupted sessions without checkpointing when no active task remains", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold restart no active task ",
    });
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold no task state "));
    temporaryDirectories.push(stateDirectory);
    const now = () => new Date("2026-07-24T11:00:00.000Z");
    const base = {
      version: "0.0.0-test",
      startedAt: now().toISOString(),
      endpointKind: (process.platform === "win32" ? "named-pipe" : "unix-socket") as
        "named-pipe" | "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true),
      reliabilityStateDirectory: stateDirectory,
      now,
    };
    const first = new AgentFoldServiceCoordinator({
      ...base,
      processId: 2001,
      generateServiceInstanceId: () => "service-no-task-one",
      generateSessionId: () => "session-no-task",
    });
    await first.initialize();
    const opened = await first.handle("session.open", {
      workspace: fixture.root,
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    const repositoryId = String(data(opened).repositoryId);

    const second = new AgentFoldServiceCoordinator({
      ...base,
      processId: 2002,
      generateServiceInstanceId: () => "service-no-task-two",
      generateSessionId: () => "session-no-task-next",
    });
    await second.initialize();
    await second.recoverStaleSessions();
    expect(second.sessions.get("session-no-task")?.state).toBe("closed");
    await expect(
      fixture.fileSystem.exists(path.join(fixture.root, ".briefonce", "state", "history")),
    ).resolves.toBe(false);
    const store = new PersistentReliabilityEventStore({
      fileSystem: fixture.fileSystem,
      stateDirectory,
      repositoryId,
      maximumEvents: 1_000,
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    expect((await store.read())?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "recovery_checkpoint_not_needed",
          reasonCode: "NO_ACTIVE_TASK",
        }),
      ]),
    );
  });

  it("does not alter a newer active task that superseded an interrupted session", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold restart superseded task ",
    });
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold superseded state "));
    temporaryDirectories.push(stateDirectory);
    const now = () => new Date("2026-07-24T12:00:00.000Z");
    const base = {
      version: "0.0.0-test",
      startedAt: now().toISOString(),
      endpointKind: (process.platform === "win32" ? "named-pipe" : "unix-socket") as
        "named-pipe" | "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true),
      reliabilityStateDirectory: stateDirectory,
      now,
    };
    const first = new AgentFoldServiceCoordinator({
      ...base,
      processId: 2101,
      generateServiceInstanceId: () => "service-superseded-one",
      generateSessionId: () => "session-superseded",
    });
    await first.initialize();
    const opened = await first.handle("session.open", {
      workspace: fixture.root,
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    const repositoryId = String(data(opened).repositoryId);
    const started = await first.handle("integration.begin_task", {
      sessionId: "session-superseded",
      title: "Original interrupted task",
    });
    const originalTaskId = String(data(started).taskId);
    const currentPath = path.join(fixture.root, ".briefonce", "state", "current.md");
    const replacementTaskId = "AF-20260724-999";
    await writeFile(
      currentPath,
      (await readFile(currentPath, "utf8")).replace(
        `task_id: ${originalTaskId}`,
        `task_id: ${replacementTaskId}`,
      ),
      "utf8",
    );

    const second = new AgentFoldServiceCoordinator({
      ...base,
      processId: 2102,
      generateServiceInstanceId: () => "service-superseded-two",
      generateSessionId: () => "session-superseded-next",
    });
    await second.initialize();
    await second.recoverStaleSessions();
    const active = await loadActiveState(fixture.fileSystem, fixture.root);
    expect(active.status).toBe("success");
    if (active.status === "success") expect(active.state.taskId).toBe(replacementTaskId);
    expect(second.sessions.get("session-superseded")?.state).toBe("superseded");
    const store = new PersistentReliabilityEventStore({
      fileSystem: fixture.fileSystem,
      stateDirectory,
      repositoryId,
      maximumEvents: 1_000,
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    expect((await store.read())?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "recovery_checkpoint_not_needed",
          reasonCode: "TASK_SUPERSEDED",
        }),
      ]),
    );
  });

  it("suppresses duplicate restart checkpoints when durable state is unchanged", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold restart duplicate ",
    });
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold duplicate state "));
    temporaryDirectories.push(stateDirectory);
    const now = () => new Date("2026-07-24T13:00:00.000Z");
    const inspector = new StubGitInspector(undefined, true);
    const base = {
      version: "0.0.0-test",
      startedAt: now().toISOString(),
      endpointKind: (process.platform === "win32" ? "named-pipe" : "unix-socket") as
        "named-pipe" | "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: inspector,
      reliabilityStateDirectory: stateDirectory,
      now,
    };
    const first = new AgentFoldServiceCoordinator({
      ...base,
      processId: 2201,
      generateServiceInstanceId: () => "service-duplicate-one",
      generateSessionId: () => "session-duplicate",
    });
    await first.initialize();
    const opened = await first.handle("session.open", {
      workspace: fixture.root,
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    const repositoryId = String(data(opened).repositoryId);
    await first.handle("integration.begin_task", {
      sessionId: "session-duplicate",
      title: "Duplicate recovery task",
    });
    await first.handle("integration.report_progress", {
      sessionId: "session-duplicate",
      completed: ["Created the durable baseline"],
    });
    await first.handle("integration.create_checkpoint", { sessionId: "session-duplicate" });

    const second = new AgentFoldServiceCoordinator({
      ...base,
      processId: 2202,
      generateServiceInstanceId: () => "service-duplicate-two",
      generateSessionId: () => "session-duplicate-next",
    });
    await second.initialize();
    await second.recoverStaleSessions();
    const active = await loadActiveState(fixture.fileSystem, fixture.root);
    expect(active.status).toBe("success");
    if (active.status === "success") expect(active.state.checkpointHistory.count).toBe(1);
    const store = new PersistentReliabilityEventStore({
      fileSystem: fixture.fileSystem,
      stateDirectory,
      repositoryId,
      maximumEvents: 1_000,
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    expect((await store.read())?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "recovery_checkpoint_duplicate",
          reasonCode: "DUPLICATE_FINGERPRINT",
        }),
      ]),
    );
  }, 30_000);

  it("keeps failed recovery pending while allowing a new session to use the latest checkpoint", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold restart failure ",
    });
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold failure state "));
    temporaryDirectories.push(stateDirectory);
    const now = () => new Date("2026-07-24T14:00:00.000Z");
    const common = {
      version: "0.0.0-test",
      startedAt: now().toISOString(),
      endpointKind: (process.platform === "win32" ? "named-pipe" : "unix-socket") as
        "named-pipe" | "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      reliabilityStateDirectory: stateDirectory,
      now,
    };
    const first = new AgentFoldServiceCoordinator({
      ...common,
      processId: 2301,
      gitInspector: new StubGitInspector(undefined, true),
      generateServiceInstanceId: () => "service-failure-one",
      generateSessionId: () => "session-failure",
    });
    await first.initialize();
    await first.handle("session.open", {
      workspace: fixture.root,
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    const started = await first.handle("integration.begin_task", {
      sessionId: "session-failure",
      title: "Recovery failure task",
    });
    const taskId = String(data(started).taskId);
    await first.handle("integration.report_progress", {
      sessionId: "session-failure",
      completed: ["Saved progress before recovery failure"],
    });
    await first.handle("integration.create_checkpoint", { sessionId: "session-failure" });

    const second = new AgentFoldServiceCoordinator({
      ...common,
      processId: 2302,
      gitInspector: new FailingCheckpointInspector(undefined, true),
      generateServiceInstanceId: () => "service-failure-two",
      generateSessionId: () => "session-after-failure",
    });
    await second.initialize();
    const next = await second.handle("session.open", {
      workspace: fixture.root,
      client: "antigravity-app",
      agent: "antigravity",
      target: "antigravity",
      resumeFormat: "json",
    });
    expect((next as { ok: boolean }).ok).toBe(true);
    expect(data(next)).toMatchObject({ task: { taskId } });
    expect(
      (next as { diagnostics: { code: string }[] }).diagnostics.some(
        (item) => item.code === "AFREL012",
      ),
    ).toBe(true);
    expect(second.sessions.get("session-failure")?.state).toBe("recovery_pending");
    expect(await second.handle("service.status", {})).toMatchObject({
      recoveryPendingSessionCount: 1,
      recentRecoveryFailureCount: 1,
      openSessionCount: 1,
    });
    const active = await loadActiveState(fixture.fileSystem, fixture.root);
    expect(active.status).toBe("success");
    if (active.status === "success") {
      expect(active.state.taskId).toBe(taskId);
      expect(active.state.status).toBe("active");
      expect(active.state.checkpointHistory.count).toBe(1);
    }
  }, 30_000);
});
