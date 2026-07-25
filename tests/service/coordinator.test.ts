import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadActiveState } from "../../src/core/state/load-active-state.js";
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

function data(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || !("data" in result)) return {};
  return typeof result.data === "object" && result.data !== null
    ? Object.fromEntries(Object.entries(result.data))
    : {};
}

describe("AgentFold service coordinator", () => {
  it("finishes task A, begins task B in the same service session, and resumes only task B", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold-service-finish-e2e-",
    });
    const inspector = new StubGitInspector(undefined, true);
    let now = new Date("2026-07-21T04:00:00.000Z");
    let sequence = 0;
    const coordinator = new AgentFoldServiceCoordinator({
      version: "0.0.0-test",
      startedAt: now.toISOString(),
      processId: 4321,
      endpointKind: process.platform === "win32" ? "named-pipe" : "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: inspector,
      now: () => now,
      generateSessionId: () => `finish-${++sequence}`,
    });
    const opened = await coordinator.handle("session.open", {
      workspace: fixture.root,
      client: "codex-app",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    const sessionId = String(data(opened).sessionId);
    const startedA = await coordinator.handle("integration.begin_task", {
      sessionId,
      title: "Task A",
    });
    const taskA = String(data(startedA).taskId);
    await coordinator.handle("integration.report_progress", {
      sessionId,
      completed: ["Implemented A"],
      validation: [{ command: "pnpm test", status: "passed", summary: "All passed" }],
    });
    await coordinator.handle("integration.create_checkpoint", { sessionId });
    now = new Date("2026-07-21T04:30:00.000Z");
    const finished = await coordinator.handle("integration.finish_task", {
      sessionId,
      summary: "Task A complete.",
      finalReport: { completed: ["Verified A"] },
    });
    expect((finished as { status: string }).status).toBe("task_finished");
    expect(coordinator.sessions.get(sessionId)?.activeTaskId).toBeUndefined();
    await expect(
      fixture.fileSystem.exists(path.join(fixture.root, ".briefonce", "state", "current.md")),
    ).resolves.toBe(false);
    await expect(
      fixture.fileSystem.exists(
        path.join(fixture.root, ".briefonce", "state", "completed", `${taskA}.md`),
      ),
    ).resolves.toBe(true);

    now = new Date("2026-07-21T04:31:00.000Z");
    const startedB = await coordinator.handle("integration.begin_task", {
      sessionId,
      title: "Task B",
    });
    const taskB = String(data(startedB).taskId);
    expect(taskB).not.toBe(taskA);
    await coordinator.handle("session.close", { sessionId });

    const nextAgent = await coordinator.handle("session.open", {
      workspace: fixture.root,
      client: "antigravity-app",
      agent: "antigravity",
      target: "antigravity",
      resumeFormat: "json",
    });
    expect((nextAgent as { status: string }).status).toBe("resumable");
    expect(data(nextAgent)).toMatchObject({ task: { taskId: taskB } });
    expect(JSON.stringify(nextAgent)).not.toContain(taskA);
  }, 30_000);

  it("shares sessions, checkpoints an agent switch, resumes, and recovers a stale lease", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold service repository with spaces ",
    });
    const inspector = new StubGitInspector(undefined, true);
    let now = new Date("2026-07-21T01:00:00.000Z");
    let sessionSequence = 0;
    const coordinator = new AgentFoldServiceCoordinator({
      version: "0.0.0-test",
      startedAt: now.toISOString(),
      processId: 1234,
      endpointKind: process.platform === "win32" ? "named-pipe" : "unix-socket",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: inspector,
      now: () => now,
      generateSessionId: () => `shared-${++sessionSequence}`,
    });

    const first = await coordinator.handle("session.open", {
      workspace: fixture.workingDirectory,
      client: "antigravity-app",
      agent: "antigravity",
      target: "antigravity",
      resumeFormat: "json",
    });
    const firstId = String(data(first).sessionId);
    expect(firstId).toBe("shared-1");
    await coordinator.handle("integration.begin_task", {
      sessionId: firstId,
      title: "Implement shared service",
      objective: "Coordinate two host applications",
    });
    await coordinator.handle("integration.report_progress", {
      sessionId: firstId,
      completed: ["Implemented authenticated local IPC"],
      decisions: [{ decision: "Use local sockets", reason: "Avoid public networking" }],
      nextActions: ["Verify agent switch"],
    });

    now = new Date("2026-07-21T01:01:00.000Z");
    const second = await coordinator.handle("session.open", {
      workspace: fixture.root,
      client: "codex-app",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    const secondId = String(data(second).sessionId);
    expect(secondId).toBe("shared-2");
    expect((second as { status: string }).status).toBe("resumable");
    expect(coordinator.sessions.get(firstId)?.state).toBe("superseded");
    const historyDirectory = path.join(fixture.root, ".briefonce", "state", "history");
    expect(await readdir(historyDirectory)).toHaveLength(1);
    expect(JSON.stringify(second)).not.toContain(fixture.root);

    now = new Date("2026-07-21T01:03:00.000Z");
    await coordinator.recoverStaleSessions();
    expect(coordinator.sessions.get(secondId)?.closeReason).toBe("heartbeat_timeout");
    expect(await readdir(historyDirectory)).toHaveLength(1);
    const active = await loadActiveState(fixture.fileSystem, fixture.root);
    expect(active.status).toBe("success");
    if (active.status === "success") {
      expect(active.state.reportRevision).toBe(1);
      expect(active.state.checkpointHistory.count).toBe(1);
    }
  });

  it("keeps different repositories independent", async () => {
    const first = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold-repo-a-",
    });
    const second = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold-repo-b-",
    });
    const coordinator = new AgentFoldServiceCoordinator({
      version: "0.0.0-test",
      startedAt: "2026-07-21T01:00:00.000Z",
      processId: 1234,
      endpointKind: process.platform === "win32" ? "named-pipe" : "unix-socket",
      fileSystem: first.fileSystem,
      gitRepositoryLocator: first.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true),
      generateSessionId: (() => {
        let index = 0;
        return () => `independent-${++index}`;
      })(),
    });
    const a = await coordinator.handle("session.open", {
      workspace: first.root,
      client: "one",
      agent: "codex",
      target: "generic",
      resumeFormat: "json",
    });
    const b = await coordinator.handle("session.open", {
      workspace: second.root,
      client: "two",
      agent: "antigravity",
      target: "generic",
      resumeFormat: "json",
    });
    expect(data(a).repositoryId).not.toBe(data(b).repositoryId);
    expect(coordinator.repositories.count()).toBe(2);
  });
});
