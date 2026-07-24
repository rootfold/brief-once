import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadActiveState } from "../../src/core/state/load-active-state.js";
import type {
  CheckpointGitObservation,
  CheckpointGitRequest,
} from "../../src/core/git/checkpoint-git-types.js";
import { createMcpApplicationContext } from "../../src/integrations/mcp/mcp-context.js";
import { createMcpToolHandlers } from "../../src/integrations/mcp/mcp-tools.js";
import { InMemorySessionRegistry } from "../../src/integrations/mcp/session-registry.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];

class FailingCheckpointInspector extends StubGitInspector {
  failCheckpoint = false;

  override readCheckpointFacts(
    repositoryRoot: string,
    request: CheckpointGitRequest,
  ): Promise<CheckpointGitObservation> {
    if (this.failCheckpoint) {
      const error = new Error("simulated safe Git failure");
      error.name = "GitInspectionError";
      return Promise.reject(error);
    }
    return super.readCheckpointFacts(repositoryRoot, request);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function data(result: { readonly data?: unknown }): Record<string, unknown> {
  return typeof result.data === "object" && result.data !== null
    ? Object.fromEntries(Object.entries(result.data))
    : {};
}

async function createHarness(
  options: { readonly name?: string; readonly inspector?: StubGitInspector } = {},
) {
  const fixture = await createContinuityFixture(temporaryDirectories, {
    name: options.name ?? "agentfold mcp tools with spaces ",
  });
  const inspector = options.inspector ?? new StubGitInspector(undefined, true);
  const timestamps = [
    "2026-07-21T01:00:00.000Z",
    "2026-07-21T01:01:00.000Z",
    "2026-07-21T01:02:00.000Z",
    "2026-07-21T01:03:00.000Z",
    "2026-07-21T01:04:00.000Z",
    "2026-07-21T01:05:00.000Z",
    "2026-07-21T01:06:00.000Z",
    "2026-07-21T01:07:00.000Z",
    "2026-07-21T01:08:00.000Z",
    "2026-07-21T01:09:00.000Z",
    "2026-07-21T01:10:00.000Z",
  ];
  let timeIndex = 0;
  let sessionIndex = 0;
  const now = () => new Date(timestamps[Math.min(timeIndex++, timestamps.length - 1)] ?? 0);
  const sessions = new InMemorySessionRegistry({
    now,
    generateId: () => `session-${++sessionIndex}`,
  });
  const contextResult = await createMcpApplicationContext({
    workspace: fixture.workingDirectory,
    version: "0.0.0-test",
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector: inspector,
    sessions,
    now,
    debug: false,
    logger: { debug: () => undefined, error: () => undefined },
  });
  if (contextResult.status !== "success") throw new Error("Expected MCP context");
  return {
    ...fixture,
    inspector,
    sessions,
    context: contextResult.context,
    handlers: createMcpToolHandlers(contextResult.context),
  };
}

describe("AgentFold MCP tools", () => {
  it("finishes task A and begins task B in the same open MCP session", async () => {
    const harness = await createHarness({ name: "agentfold-mcp-finish-lifecycle-" });
    const opened = await harness.handlers.openSession({ client: "codex", agent: "codex" });
    const sessionId = String(data(opened).sessionId);
    const startedA = await harness.handlers.beginTask({ sessionId, title: "Task A" });
    const taskA = String(data(startedA).taskId);
    await harness.handlers.reportProgress({
      sessionId,
      completed: ["Implemented task A"],
      validation: [{ command: "pnpm test", status: "passed", summary: "All passed" }],
    });
    await harness.handlers.createCheckpoint({ sessionId });

    const finished = await harness.handlers.finishTask({
      sessionId,
      summary: "Task A is implemented and validated.",
      finalReport: { completed: ["Verified task A end to end"] },
    });

    expect(finished.status).toBe("task_finished");
    expect(data(finished)).toMatchObject({
      taskId: taskA,
      finalCheckpointId: "CP-002",
      archivePath: `.agentfold/state/completed/${taskA}.md`,
      validationSummary: { total: 1, passed: 1, failed: 0 },
    });
    expect(harness.sessions.requireOpen(sessionId).status).toBe("open");
    expect(harness.sessions.get(sessionId)?.activeTaskId).toBeUndefined();
    await expect(
      harness.fileSystem.exists(path.join(harness.root, ".agentfold", "state", "current.md")),
    ).resolves.toBe(false);
    await expect(
      harness.fileSystem.exists(
        path.join(harness.root, ".agentfold", "state", "history", `${taskA}-CP-001.md`),
      ),
    ).resolves.toBe(true);
    await expect(
      harness.fileSystem.exists(
        path.join(harness.root, ".agentfold", "state", "history", `${taskA}-CP-002.md`),
      ),
    ).resolves.toBe(true);
    const completedStatus = await harness.handlers.getStatus({});
    expect(data(completedStatus)).toMatchObject({
      activeTask: null,
      latestCompletedTaskId: taskA,
      latestCompletedFinalCheckpointId: "CP-002",
    });
    const openedAfterFinish = await harness.handlers.openSession({
      client: "same-host-second-surface",
      agent: "codex",
    });
    expect(openedAfterFinish.status).toBe("no_active_task");
    expect(openedAfterFinish.diagnostics.some((item) => item.code === "AFMCP020")).toBe(true);

    const startedB = await harness.handlers.beginTask({ sessionId, title: "Task B" });
    const taskB = String(data(startedB).taskId);
    expect(taskB).not.toBe(taskA);
    const closedB = await harness.handlers.closeSession({ sessionId });
    expect(closedB.status).toBe("session_closed");

    const continuation = await harness.handlers.openSession({
      client: "antigravity",
      agent: "antigravity",
    });
    expect(continuation.status).toBe("resumable");
    expect(data(continuation)).toMatchObject({ task: { taskId: taskB } });
    expect(JSON.stringify(continuation)).not.toContain(taskA);
  }, 30_000);

  it("closes cleanly without a checkpoint after finish clears the session task", async () => {
    const harness = await createHarness({ name: "agentfold-mcp-finish-close-" });
    const opened = await harness.handlers.openSession({ client: "codex", agent: "codex" });
    const sessionId = String(data(opened).sessionId);
    await harness.handlers.beginTask({ sessionId, title: "Completed task" });
    expect(
      (await harness.handlers.finishTask({ sessionId, summary: "Completed safely." })).status,
    ).toBe("task_finished");
    const checkpointReads = harness.inspector.checkpointReads.length;

    const closed = await harness.handlers.closeSession({ sessionId });

    expect(closed.status).toBe("session_closed");
    expect(data(closed)).toMatchObject({ taskId: null, checkpointStatus: "not_requested" });
    expect(harness.inspector.checkpointReads).toHaveLength(checkpointReads);
  });

  it("runs the complete lifecycle through existing core operations", async () => {
    const harness = await createHarness();
    const initialStatus = await harness.handlers.getStatus({});
    expect(initialStatus.status).toBe("no_active_task");
    expect(JSON.stringify(initialStatus)).not.toContain(harness.root);

    const opened = await harness.handlers.openSession({
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    expect(opened.status).toBe("no_active_task");
    const sessionId = String(data(opened).sessionId);
    expect(await harness.fileSystem.exists(path.join(harness.root, ".agentfold", "state"))).toBe(
      false,
    );

    const started = await harness.handlers.beginTask({
      sessionId,
      title: "Implement GitHub OAuth",
      objective: "Add GitHub OAuth without changing email login",
    });
    expect(started.status).toBe("task_started");
    expect(data(started).objective).toBe("Add GitHub OAuth without changing email login");
    const taskId = String(data(started).taskId);
    expect(harness.sessions.get(sessionId)?.activeTaskId).toBe(taskId);
    const activeWithoutCheckpoint = await harness.handlers.openSession({
      client: "second-surface",
      agent: "claude",
    });
    expect(activeWithoutCheckpoint.status).toBe("active_without_checkpoint");

    const reported = await harness.handlers.reportProgress({
      sessionId,
      completed: ["Added callback route"],
      inProgress: [],
      decisions: [{ decision: "Reuse session table", reason: "Avoid a migration" }],
      failedAttempts: [],
      blockers: [],
      nextActions: ["Add integration test"],
      validation: [{ command: "pnpm test", status: "passed", summary: "All tests pass" }],
      assumptions: [],
    });
    expect(reported.status).toBe("report_applied");
    expect(data(reported)).toMatchObject({
      previousReportRevision: 0,
      newReportRevision: 1,
      changed: true,
      redactionWarningCount: 0,
    });
    expect(harness.inspector.checkpointReads).toHaveLength(0);

    const duplicateReport = await harness.handlers.reportProgress({
      sessionId,
      completed: ["Added callback route"],
    });
    expect(duplicateReport.status).toBe("duplicate_report");
    expect(data(duplicateReport).newReportRevision).toBe(1);

    const dryRun = await harness.handlers.createCheckpoint({ sessionId, dryRun: true });
    expect(dryRun.status).toBe("dry_run");
    expect(data(dryRun).created).toBe(false);
    expect(
      await harness.fileSystem.exists(path.join(harness.root, ".agentfold", "state", "history")),
    ).toBe(false);

    const checkpoint = await harness.handlers.createCheckpoint({ sessionId });
    expect(checkpoint.status).toBe("checkpoint_created");
    expect(data(checkpoint)).toMatchObject({
      created: true,
      duplicate: false,
      semanticRevision: 1,
    });
    expect(JSON.stringify(checkpoint)).not.toContain("Added callback route");
    const activeStatus = await harness.handlers.getStatus({});
    expect(data(activeStatus)).toMatchObject({
      semanticReportRevision: 1,
      latestCheckpointId: "CP-001",
    });

    const duplicateCheckpoint = await harness.handlers.createCheckpoint({ sessionId });
    expect(duplicateCheckpoint.status).toBe("duplicate_checkpoint");
    expect(data(duplicateCheckpoint).duplicate).toBe(true);

    harness.inspector.checkpointReads.splice(0);
    const resumed = await harness.handlers.getResumePacket({
      sessionId,
      target: "antigravity",
      format: "json",
    });
    expect(resumed.status).toBe("resume_packet_prepared");
    expect(data(resumed).semanticFreshness).toBe("new");
    expect(harness.inspector.checkpointReads).toHaveLength(0);

    const closed = await harness.handlers.closeSession({
      sessionId,
      agent: "claude",
      finalReport: { completed: ["Added integration test"] },
      createCheckpoint: true,
      returnResumePacket: true,
      resumeTarget: "generic",
    });
    expect(closed.status).toBe("session_closed");
    expect(data(closed)).toMatchObject({
      taskId,
      reportRevision: 2,
      reportStatus: "report_applied",
      checkpointStatus: "checkpoint_created",
    });
    expect(harness.sessions.get(sessionId)?.closedAt).toBeDefined();
    expect((await harness.handlers.createCheckpoint({ sessionId })).status).toBe("closed_session");

    const second = await harness.handlers.openSession({
      client: "antigravity-ide",
      agent: "antigravity",
      target: "antigravity",
      resumeFormat: "markdown",
    });
    expect(second.status).toBe("resumable");
    expect(String(data(second).resumePacket)).toContain("# BriefOnce continuation packet");
    expect(JSON.stringify(second)).not.toContain(harness.root);
  }, 30_000);

  it("bounds canonical documents and never reads source or secret files", async () => {
    const harness = await createHarness();
    await mkdir(path.join(harness.root, "src"), { recursive: true });
    const sourceSecret = "sk_not-a-real-value-but-must-not-be-read";
    await writeFile(path.join(harness.root, "src", "secret.ts"), sourceSecret, "utf8");
    await writeFile(
      path.join(harness.root, ".agentfold", "context", "architecture.md"),
      "A".repeat(25_000),
      "utf8",
    );
    await writeFile(
      path.join(harness.root, ".agentfold", "context", "conventions.md"),
      "C".repeat(5_000),
      "utf8",
    );

    const concise = await harness.handlers.getContext({ includeContextDocuments: false });
    expect(concise.ok).toBe(true);
    expect(String(data(concise).architectureExcerpt)).toHaveLength(2_000);
    expect(JSON.stringify(concise)).not.toContain(sourceSecret);

    const full = await harness.handlers.getContext({ includeContextDocuments: true });
    const contextDocuments = data(full).contextDocuments as {
      readonly totalIncludedCharacters: number;
      readonly omittedCharacters: Record<string, number>;
    };
    expect(contextDocuments.totalIncludedCharacters).toBe(20_000);
    expect(
      Object.values(contextDocuments.omittedCharacters).reduce((sum, value) => sum + value, 0),
    ).toBeGreaterThan(0);
    expect(JSON.stringify(full)).not.toContain(sourceSecret);
  });

  it("rejects unknown sessions, unsafe objectives, private reasoning, and invalid statuses safely", async () => {
    const harness = await createHarness();
    const unsafeSession = await harness.handlers.openSession({
      client: "test",
      agent: "token=super-secret-value",
    });
    expect(unsafeSession.status).toBe("unsafe_identity");
    expect(JSON.stringify(unsafeSession)).not.toContain("super-secret-value");
    expect((await harness.handlers.beginTask({ sessionId: "unknown", title: "Task" })).status).toBe(
      "unknown_session",
    );
    const opened = await harness.handlers.openSession({ client: "test", agent: "codex" });
    const sessionId = String(data(opened).sessionId);
    const unsafe = await harness.handlers.beginTask({
      sessionId,
      title: "Task",
      objective: "token=super-secret-value",
    });
    expect(unsafe.status).toBe("unsafe_objective");
    expect(JSON.stringify(unsafe)).not.toContain("super-secret-value");

    await harness.handlers.beginTask({ sessionId, title: "Safe task" });
    const privateReasoning = await harness.handlers.reportProgress({
      sessionId,
      completed: ["Done"],
      chainOfThought: "private",
    });
    expect(privateReasoning.status).toBe("invalid_input");
    const invalidStatus = await harness.handlers.reportProgress({
      sessionId,
      validation: [{ command: "pnpm test", status: "unknown", summary: "No" }],
    });
    expect(invalidStatus.status).toBe("invalid_input");
  });

  it("uses explicit report agent over the session fallback and redacts secrets", async () => {
    const harness = await createHarness();
    const opened = await harness.handlers.openSession({ client: "test", agent: "session-agent" });
    const sessionId = String(data(opened).sessionId);
    await harness.handlers.beginTask({ sessionId, title: "Safe task" });
    const reported = await harness.handlers.reportProgress({
      sessionId,
      agent: "explicit-agent",
      completed: ["Removed token=super-secret-value from fixture"],
    });
    expect(reported.ok).toBe(true);
    expect(data(reported).redactionWarningCount).toBe(1);
    expect(JSON.stringify(reported)).not.toContain("super-secret-value");
    const active = await loadActiveState(harness.fileSystem, harness.root);
    expect(active.status).toBe("success");
    if (active.status === "success") {
      expect(active.state.lastAgent).toBe("explicit-agent");
      expect(active.state.completed[0]).toContain("[REDACTED]");
    }
  });

  it("preserves a final report and keeps the session open when close checkpointing fails", async () => {
    const inspector = new FailingCheckpointInspector(undefined, true);
    const harness = await createHarness({ inspector });
    const opened = await harness.handlers.openSession({ client: "test", agent: "codex" });
    const sessionId = String(data(opened).sessionId);
    await harness.handlers.beginTask({ sessionId, title: "Partial close task" });
    inspector.failCheckpoint = true;

    const closed = await harness.handlers.closeSession({
      sessionId,
      finalReport: { completed: ["Semantic work persisted"] },
      createCheckpoint: true,
    });
    expect(closed.ok).toBe(false);
    expect(closed.status).toBe("partial_success");
    expect(harness.sessions.requireOpen(sessionId).status).toBe("open");
    const active = await loadActiveState(harness.fileSystem, harness.root);
    expect(active.status).toBe("success");
    if (active.status === "success") {
      expect(active.state.reportRevision).toBe(1);
      expect(active.state.checkpointHistory.count).toBe(0);
    }
  });

  it("supports report-only, Git-only, and duplicate-checkpoint closes", async () => {
    const reportOnly = await createHarness({ name: "agentfold-mcp-report-only-" });
    const openedReportOnly = await reportOnly.handlers.openSession({
      client: "test",
      agent: "codex",
    });
    const reportSessionId = String(data(openedReportOnly).sessionId);
    await reportOnly.handlers.beginTask({ sessionId: reportSessionId, title: "Report-only task" });
    const reportedClose = await reportOnly.handlers.closeSession({
      sessionId: reportSessionId,
      finalReport: { completed: ["Saved without checkpoint"] },
      createCheckpoint: false,
    });
    expect(reportedClose.status).toBe("session_closed");
    expect(data(reportedClose)).toMatchObject({
      reportStatus: "report_applied",
      checkpointStatus: "not_requested",
    });

    const gitOnly = await createHarness({ name: "agentfold-mcp-git-only-" });
    const openedGitOnly = await gitOnly.handlers.openSession({ client: "test", agent: "codex" });
    const gitSessionId = String(data(openedGitOnly).sessionId);
    await gitOnly.handlers.beginTask({ sessionId: gitSessionId, title: "Git-only task" });
    const gitOnlyClose = await gitOnly.handlers.closeSession({ sessionId: gitSessionId });
    expect(gitOnlyClose.status).toBe("session_closed");
    expect(data(gitOnlyClose).checkpointStatus).toBe("checkpoint_created");
    expect(gitOnlyClose.diagnostics.some((item) => item.code === "AFMCP016")).toBe(true);

    const duplicate = await createHarness({ name: "agentfold-mcp-duplicate-close-" });
    const openedDuplicate = await duplicate.handlers.openSession({
      client: "test",
      agent: "codex",
    });
    const duplicateSessionId = String(data(openedDuplicate).sessionId);
    await duplicate.handlers.beginTask({ sessionId: duplicateSessionId, title: "Duplicate task" });
    await duplicate.handlers.createCheckpoint({ sessionId: duplicateSessionId });
    const duplicateClose = await duplicate.handlers.closeSession({ sessionId: duplicateSessionId });
    expect(duplicateClose.status).toBe("session_closed");
    expect(data(duplicateClose)).toMatchObject({
      checkpointStatus: "duplicate_checkpoint",
      duplicateCheckpoint: true,
    });
  }, 30_000);

  it("validates the complete close input before mutation", async () => {
    const harness = await createHarness();
    const opened = await harness.handlers.openSession({ client: "test", agent: "codex" });
    const sessionId = String(data(opened).sessionId);
    await harness.handlers.beginTask({ sessionId, title: "No mutation task" });
    const before = await harness.fileSystem.readText(
      path.join(harness.root, ".agentfold", "state", "current.md"),
    );
    const invalid = await harness.handlers.closeSession({
      sessionId,
      finalReport: { validation: [{ command: "pnpm test", status: "unknown", summary: "No" }] },
    });
    expect(invalid.status).toBe("invalid_input");
    await expect(
      harness.fileSystem.readText(path.join(harness.root, ".agentfold", "state", "current.md")),
    ).resolves.toBe(before);
    expect(harness.sessions.requireOpen(sessionId).status).toBe("open");
  });
});
