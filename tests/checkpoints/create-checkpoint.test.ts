import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  commitCheckpoint,
  prepareCheckpoint,
} from "../../src/core/checkpoints/create-checkpoint.js";
import { parseCheckpoint } from "../../src/core/checkpoints/parse-checkpoint.js";
import {
  AtomicFileConflictError,
  AtomicTextFileWriter,
  type AtomicTextFileWriteMode,
} from "../../src/core/filesystem/atomic-text-file-writer.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import type { CheckpointGitFacts } from "../../src/core/git/checkpoint-git-types.js";
import { GitInspectionError } from "../../src/core/git/git-inspector.js";
import { commitAgentReport, prepareAgentReport } from "../../src/core/reports/apply-report.js";
import { loadActiveState } from "../../src/core/state/load-active-state.js";
import { commitTaskStart, prepareTaskStart } from "../../src/core/state/start-task.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];
const startTime = new Date("2026-07-20T12:00:00.000Z");
const reportTime = new Date("2026-07-20T14:00:00.000Z");
const checkpointTime = new Date("2026-07-20T18:30:00.000Z");
const startCommit = "0123456789abcdef0123456789abcdef01234567";
const currentCommit = "abcdef0123456789abcdef0123456789abcdef01";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function checkpointFacts(overrides: Partial<CheckpointGitFacts> = {}): CheckpointGitFacts {
  return {
    branch: "feat/oauth",
    commit: currentCommit,
    detached: false,
    workingTree: "dirty",
    hasStagedChanges: true,
    hasUnstagedChanges: true,
    changedPaths: {
      added: ["src/auth/github.ts"],
      modified: ["src/routes/auth.ts"],
      deleted: [],
      renamed: [],
      copied: [],
      untracked: ["tests/auth/github test.ts"],
      unmerged: [],
    },
    diffStatistics: {
      filesChanged: 2,
      insertions: 20,
      deletions: 3,
      binaryFiles: 0,
      untrackedFiles: 1,
    },
    recentCommits: [{ hash: currentCommit, subject: "Add callback route" }],
    ...overrides,
  };
}

async function activeFixture(
  options: {
    readonly withReport?: boolean;
    readonly visibility?: "local" | "tracked";
    readonly name?: string;
    readonly ignored?: boolean;
    readonly facts?: CheckpointGitFacts;
  } = {},
) {
  const fixture = await createContinuityFixture(temporaryDirectories, {
    ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  const inspector = new StubGitInspector(
    { branch: "main", commit: startCommit, detached: false },
    options.ignored ?? true,
    options.facts ?? checkpointFacts(),
  );
  const start = await prepareTaskStart(
    {
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: inspector,
      now: () => startTime,
    },
    { title: "Implement OAuth", agent: "codex" },
  );
  if (start.status !== "ready") throw new Error("Expected task start");
  await commitTaskStart(start, new AtomicTextFileWriter(fixture.fileSystem, () => ".start.tmp"));

  if (options.withReport === true) {
    const report = await prepareAgentReport(
      {
        fileSystem: fixture.fileSystem,
        gitRepositoryLocator: fixture.gitRepositoryLocator,
        gitInspector: inspector,
        now: () => reportTime,
      },
      {
        json: JSON.stringify({
          agent: "claude",
          completed: ["Added callback route"],
          decisions: [{ decision: "Reuse session table", reason: "Avoid migration" }],
          failedAttempts: [{ attempt: "Strict cookie", result: "Redirect dropped it" }],
          blockers: ["Callback test fails"],
          nextActions: ["Test Lax cookie"],
          validation: [{ command: "pnpm test", status: "failed", summary: "One failure" }],
          assumptions: ["HTTPS terminates at proxy"],
        }),
      },
    );
    if (report.status !== "ready") throw new Error("Expected report");
    await commitAgentReport(
      report,
      new AtomicTextFileWriter(fixture.fileSystem, () => ".report.tmp"),
    );
  }

  return { ...fixture, inspector };
}

function dependencies(fixture: Awaited<ReturnType<typeof activeFixture>>) {
  return {
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector: fixture.inspector,
    now: () => checkpointTime,
  };
}

function writer(fileSystem: NodeFileSystem): AtomicTextFileWriter {
  return new AtomicTextFileWriter(fileSystem, (name) => `.${name}.checkpoint.tmp`);
}

describe("checkpoint creation", () => {
  it("creates immutable history by default and updates only checkpoint metadata and current Git facts", async () => {
    const fixture = await activeFixture({ withReport: true });
    const before = await loadActiveState(fixture.fileSystem, fixture.root);
    if (before.status !== "success") throw new Error("Expected active state");
    const plan = await prepareCheckpoint(dependencies(fixture), { agent: "gemini" });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") throw new Error("Expected checkpoint plan");

    expect(plan.checkpoint).toMatchObject({
      checkpointId: "CP-001",
      checkpointAgent: "gemini",
      lastReportingAgent: "claude",
      semanticRevision: 1,
      semanticFreshness: "new",
    });
    expect(plan.serializedCheckpoint).toContain("# Automatically observed Git facts");
    expect(plan.serializedCheckpoint).toContain("# Agent-reported task state");
    expect(plan.serializedCheckpoint).not.toContain("full diff");

    const result = await commitCheckpoint(plan, fixture.fileSystem, writer(fixture.fileSystem));
    expect(result.status).toBe("success");
    const history = parseCheckpoint(await fixture.fileSystem.readText(plan.historyPath));
    expect(history.reportedState.completed).toEqual(["Added callback route"]);
    const after = await loadActiveState(fixture.fileSystem, fixture.root);
    if (after.status !== "success") throw new Error("Expected updated state");
    expect(after.state).toMatchObject({
      taskId: before.state.taskId,
      title: before.state.title,
      objective: before.state.objective,
      startedAt: before.state.startedAt,
      startingBranch: before.state.startingBranch,
      startingCommit: before.state.startingCommit,
      currentBranch: "feat/oauth",
      currentCommit,
      lastAgent: "claude",
      checkpointHistory: {
        count: 1,
        latestCheckpointAt: checkpointTime.toISOString(),
        latestCheckpointId: "CP-001",
        latestFingerprint: plan.checkpoint.fingerprint,
        latestSemanticRevision: 1,
      },
    });
    expect(after.state.completed).toEqual(before.state.completed);
  });

  it("allows a Git-only checkpoint with a warning and manufactures no semantic state", async () => {
    const fixture = await activeFixture();
    const plan = await prepareCheckpoint(dependencies(fixture));

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") throw new Error("Expected checkpoint");
    expect(plan.checkpoint.semanticRevision).toBe(0);
    expect(plan.checkpoint.semanticFreshness).toBe("none");
    expect(plan.checkpoint.lastReportingAgent).toBeUndefined();
    expect(plan.checkpoint.reportedState.completed).toEqual([]);
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: "AFCP004" }));
  });

  it("does not create a duplicate fingerprint or change either file", async () => {
    const fixture = await activeFixture({ withReport: true });
    const first = await prepareCheckpoint(dependencies(fixture));
    if (first.status !== "ready") throw new Error("Expected first checkpoint");
    await commitCheckpoint(first, fixture.fileSystem, writer(fixture.fileSystem));
    const stateBefore = await fixture.fileSystem.readText(first.statePath);
    const historyBefore = await fixture.fileSystem.readText(first.historyPath);

    const duplicate = await prepareCheckpoint({ ...dependencies(fixture), now: () => new Date() });

    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.diagnostics).toContainEqual(expect.objectContaining({ code: "AFCP007" }));
    await expect(fixture.fileSystem.readText(first.statePath)).resolves.toBe(stateBefore);
    await expect(fixture.fileSystem.readText(first.historyPath)).resolves.toBe(historyBefore);
    await expect(
      fixture.fileSystem.exists(
        path.join(
          fixture.root,
          ".briefonce",
          "state",
          "history",
          `${first.checkpoint.taskId}-CP-002.md`,
        ),
      ),
    ).resolves.toBe(false);
  });

  it("changes the fingerprint and allocates the next ID when only Git state changes", async () => {
    const fixture = await activeFixture({ withReport: true });
    const first = await prepareCheckpoint(dependencies(fixture));
    if (first.status !== "ready") throw new Error("Expected first checkpoint");
    await commitCheckpoint(first, fixture.fileSystem, writer(fixture.fileSystem));
    const changedInspector = new StubGitInspector(
      { branch: "main", commit: startCommit, detached: false },
      true,
      checkpointFacts({
        diffStatistics: { ...checkpointFacts().diffStatistics, insertions: 21 },
      }),
    );

    const second = await prepareCheckpoint({
      ...dependencies(fixture),
      gitInspector: changedInspector,
      now: () => new Date("2026-07-20T19:00:00.000Z"),
    });

    expect(second.status).toBe("ready");
    if (second.status !== "ready") throw new Error("Expected second checkpoint");
    expect(second.checkpoint.checkpointId).toBe("CP-002");
    expect(second.checkpoint.fingerprint).not.toBe(first.checkpoint.fingerprint);
    expect(second.checkpoint.semanticFreshness).toBe("reused");
  });

  it("changes the fingerprint when a new semantic report revision follows a checkpoint", async () => {
    const fixture = await activeFixture({ withReport: true });
    const first = await prepareCheckpoint(dependencies(fixture));
    if (first.status !== "ready") throw new Error("Expected first checkpoint");
    await commitCheckpoint(first, fixture.fileSystem, writer(fixture.fileSystem));

    const report = await prepareAgentReport(
      {
        fileSystem: fixture.fileSystem,
        gitRepositoryLocator: fixture.gitRepositoryLocator,
        gitInspector: fixture.inspector,
        now: () => new Date("2026-07-20T19:00:00.000Z"),
      },
      { json: JSON.stringify({ agent: "codex", completed: ["Verified callback"] }) },
    );
    if (report.status !== "ready") throw new Error("Expected semantic report");
    await commitAgentReport(report, writer(fixture.fileSystem));

    const second = await prepareCheckpoint({
      ...dependencies(fixture),
      now: () => new Date("2026-07-20T20:00:00.000Z"),
    });
    if (second.status !== "ready") throw new Error("Expected second checkpoint");
    expect(second.checkpoint).toMatchObject({
      checkpointId: "CP-002",
      semanticRevision: 2,
      semanticFreshness: "new",
      lastReportingAgent: "codex",
    });
    expect(second.checkpoint.fingerprint).not.toBe(first.checkpoint.fingerprint);
  });

  it("warns for unignored local state, skips tracked warnings, and works in a path with spaces", async () => {
    const local = await activeFixture({ name: "agentfold checkpoint spaces ", ignored: false });
    const localPlan = await prepareCheckpoint(dependencies(local));
    expect(localPlan.status).toBe("ready");
    expect(localPlan.diagnostics).toContainEqual(expect.objectContaining({ code: "AFCP009" }));

    const tracked = await activeFixture({ visibility: "tracked", ignored: false });
    const trackedPlan = await prepareCheckpoint(dependencies(tracked));
    expect(trackedPlan.status).toBe("ready");
    expect(trackedPlan.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "AFCP009" }),
    );
    expect(tracked.inspector.ignoreReads).toEqual([]);
  });

  it("supports detached HEAD and repositories with no commits", async () => {
    const detached = await activeFixture({
      facts: checkpointFacts({ branch: "HEAD (detached)", detached: true }),
    });
    const detachedPlan = await prepareCheckpoint(dependencies(detached));
    if (detachedPlan.status !== "ready") throw new Error("Expected detached checkpoint");
    expect(detachedPlan.checkpoint.observedGit.detached).toBe(true);

    const unborn = await activeFixture({
      facts: checkpointFacts({ branch: "main", commit: null, recentCommits: [] }),
    });
    const unbornPlan = await prepareCheckpoint(dependencies(unborn));
    if (unbornPlan.status !== "ready") throw new Error("Expected unborn checkpoint");
    expect(unbornPlan.checkpoint.observedGit.currentCommit).toBeNull();
  });

  it("rejects missing, invalid, and secret-like manually edited active state without scanning source files", async () => {
    const missing = await createContinuityFixture(temporaryDirectories);
    const missingResult = await prepareCheckpoint({
      fileSystem: missing.fileSystem,
      gitRepositoryLocator: missing.gitRepositoryLocator,
      gitInspector: new StubGitInspector(),
      now: () => checkpointTime,
    });
    expect(missingResult).toMatchObject({ status: "missing-state", exitCode: 5 });

    const invalid = await activeFixture();
    const statePath = path.join(invalid.root, ".briefonce", "state", "current.md");
    await invalid.fileSystem.writeText(statePath, "not active state\n");
    await expect(prepareCheckpoint(dependencies(invalid))).resolves.toMatchObject({
      status: "invalid-state",
      exitCode: 2,
    });

    const unsafe = await activeFixture();
    const unsafePath = path.join(unsafe.root, ".briefonce", "state", "current.md");
    const secret = "fake-secret-value-123";
    await unsafe.fileSystem.writeText(
      unsafePath,
      (await unsafe.fileSystem.readText(unsafePath)).replace(
        "> Implement OAuth",
        `> Configured token=${secret}`,
      ),
    );
    await unsafe.fileSystem.writeText(path.join(unsafe.root, "source-secret.txt"), secret);
    const unsafeResult = await prepareCheckpoint(dependencies(unsafe));
    expect(unsafeResult).toMatchObject({ status: "unsafe-state", exitCode: 4 });
    expect(JSON.stringify(unsafeResult.diagnostics)).not.toContain(secret);

    const sourceOnly = await activeFixture();
    await sourceOnly.fileSystem.writeText(path.join(sourceOnly.root, "source-secret.txt"), secret);
    await expect(prepareCheckpoint(dependencies(sourceOnly))).resolves.toMatchObject({
      status: "ready",
      exitCode: 0,
    });
  });

  it("returns structured diagnostics when Git facts cannot be captured", async () => {
    const fixture = await activeFixture();
    class FailingGitInspector extends StubGitInspector {
      override readCheckpointFacts(): Promise<never> {
        return Promise.reject(new GitInspectionError("simulated Git failure"));
      }
    }

    const result = await prepareCheckpoint({
      ...dependencies(fixture),
      gitInspector: new FailingGitInspector(),
    });

    expect(result).toMatchObject({ status: "git-error", exitCode: 6 });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "AFCP011" }));
    expect(JSON.stringify(result.diagnostics)).not.toContain("simulated Git failure");
  });

  it("classifies checkpoint-model failures and sequence exhaustion", async () => {
    const invalidFacts = await activeFixture({
      facts: checkpointFacts({ branch: "" }),
    });
    await expect(prepareCheckpoint(dependencies(invalidFacts))).resolves.toMatchObject({
      status: "invalid-checkpoint",
      exitCode: 2,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFCP020" })]),
    });

    const exhausted = await activeFixture();
    const statePath = path.join(exhausted.root, ".briefonce", "state", "current.md");
    await exhausted.fileSystem.writeText(
      statePath,
      (await exhausted.fileSystem.readText(statePath)).replace("count: 0", "count: 999"),
    );
    await expect(prepareCheckpoint(dependencies(exhausted))).resolves.toMatchObject({
      status: "history-conflict",
      exitCode: 5,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFCP019" })]),
    });
  });
});

describe("checkpoint atomicity", () => {
  it("leaves state unchanged when history creation fails", async () => {
    const fixture = await activeFixture({ withReport: true });
    const plan = await prepareCheckpoint(dependencies(fixture));
    if (plan.status !== "ready") throw new Error("Expected checkpoint");
    const before = await fixture.fileSystem.readText(plan.statePath);
    class HistoryFailWriter extends AtomicTextFileWriter {
      override write(
        _destination: string,
        _content: string,
        mode: AtomicTextFileWriteMode,
      ): Promise<void> {
        return mode === "create"
          ? Promise.reject(new Error("simulated history failure"))
          : Promise.resolve();
      }
    }

    const result = await commitCheckpoint(
      plan,
      fixture.fileSystem,
      new HistoryFailWriter(fixture.fileSystem),
    );
    expect(result.status).toBe("write-failure");
    await expect(fixture.fileSystem.readText(plan.statePath)).resolves.toBe(before);
    await expect(fixture.fileSystem.exists(plan.historyPath)).resolves.toBe(false);
  });

  it("removes only new history and preserves previous state when replacement fails", async () => {
    const fixture = await activeFixture({ withReport: true });
    const plan = await prepareCheckpoint(dependencies(fixture));
    if (plan.status !== "ready") throw new Error("Expected checkpoint");
    const before = await fixture.fileSystem.readText(plan.statePath);
    const historyDirectory = path.dirname(plan.historyPath);
    const existingHistoryPath = path.join(historyDirectory, "existing-checkpoint.md");
    await fixture.fileSystem.ensureDirectory(historyDirectory);
    await fixture.fileSystem.writeText(existingHistoryPath, "existing history\n");
    class StateFailWriter extends AtomicTextFileWriter {
      override write(
        destination: string,
        content: string,
        mode: AtomicTextFileWriteMode,
      ): Promise<void> {
        return mode === "replace"
          ? Promise.reject(new Error("simulated state failure"))
          : super.write(destination, content, mode);
      }
    }

    const result = await commitCheckpoint(
      plan,
      fixture.fileSystem,
      new StateFailWriter(fixture.fileSystem, () => ".checkpoint.tmp"),
    );
    expect(result.status).toBe("write-failure");
    await expect(fixture.fileSystem.exists(plan.historyPath)).resolves.toBe(false);
    await expect(fixture.fileSystem.readText(plan.statePath)).resolves.toBe(before);
    await expect(fixture.fileSystem.readText(existingHistoryPath)).resolves.toBe(
      "existing history\n",
    );
    await expect(fixture.fileSystem.listDirectory(historyDirectory)).resolves.toEqual([
      "existing-checkpoint.md",
    ]);
  });

  it("returns a severe diagnostic when rollback fails and reports history races as conflicts", async () => {
    const fixture = await activeFixture();
    const plan = await prepareCheckpoint(dependencies(fixture));
    if (plan.status !== "ready") throw new Error("Expected checkpoint");
    class StateFailWriter extends AtomicTextFileWriter {
      override write(
        destination: string,
        content: string,
        mode: AtomicTextFileWriteMode,
      ): Promise<void> {
        return mode === "replace"
          ? Promise.reject(new Error("simulated state failure"))
          : super.write(destination, content, mode);
      }
    }
    class RollbackFailFileSystem extends NodeFileSystem {
      override remove(): Promise<void> {
        return Promise.reject(new Error("simulated rollback failure"));
      }
    }
    const rollback = await commitCheckpoint(
      plan,
      new RollbackFailFileSystem(() => fixture.root),
      new StateFailWriter(fixture.fileSystem, () => ".rollback.tmp"),
    );
    expect(rollback.status).toBe("rollback-failure");
    expect(rollback.diagnostics).toContainEqual(expect.objectContaining({ code: "AFCP013" }));
    await fixture.fileSystem.remove(plan.historyPath);

    class ConflictWriter extends AtomicTextFileWriter {
      override write(destination: string): Promise<void> {
        return Promise.reject(new AtomicFileConflictError(destination));
      }
    }
    const conflict = await commitCheckpoint(
      plan,
      fixture.fileSystem,
      new ConflictWriter(fixture.fileSystem),
    );
    expect(conflict).toMatchObject({ status: "history-conflict", exitCode: 5 });
  });
});
