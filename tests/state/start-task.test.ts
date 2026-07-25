import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AtomicTextFileWriter } from "../../src/core/filesystem/atomic-text-file-writer.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import { loadActiveState } from "../../src/core/state/load-active-state.js";
import {
  commitTaskStart,
  prepareTaskStart,
  type PrepareTaskStartDependencies,
} from "../../src/core/state/start-task.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];
const fixedTime = new Date("2026-07-20T15:10:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function dependencies(
  fixture: Awaited<ReturnType<typeof createContinuityFixture>>,
  gitInspector = new StubGitInspector(),
): PrepareTaskStartDependencies {
  return {
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector,
    now: () => fixedTime,
  };
}

describe("prepareTaskStart", () => {
  it("previews a valid task without writing state", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);

    const plan = await prepareTaskStart(dependencies(fixture), { title: "  Implement OAuth  " });

    expect(plan.status).toBe("ready");
    expect(plan.exitCode).toBe(0);
    if (plan.status !== "ready") throw new Error("Expected ready start plan");
    expect(plan.state).toMatchObject({
      taskId: "AF-20260720-001",
      title: "Implement OAuth",
      objective: "Implement OAuth",
      startingBranch: "main",
      currentBranch: "main",
      startingCommit: "0123456789abcdef0123456789abcdef01234567",
      currentCommit: "0123456789abcdef0123456789abcdef01234567",
      workingContext: ".",
      checkpointHistory: { count: 0, latestCheckpointAt: null },
    });
    await expect(fixture.fileSystem.exists(plan.statePath)).resolves.toBe(false);
  });

  it("creates current state atomically and stores the starting agent", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const plan = await prepareTaskStart(dependencies(fixture), {
      title: "Implement OAuth",
      agent: " codex ",
    });
    if (plan.status !== "ready") throw new Error("Expected ready start plan");

    await commitTaskStart(plan, new AtomicTextFileWriter(fixture.fileSystem, () => ".start.tmp"));
    const loaded = await loadActiveState(fixture.fileSystem, fixture.root);

    expect(loaded.status).toBe("success");
    if (loaded.status !== "success") throw new Error("Expected state to load");
    expect(loaded.state.startingAgent).toBe("codex");
    expect(loaded.state.lastAgent).toBe("codex");
    expect(loaded.state.startedAt).toBe(fixedTime.toISOString());
  });

  it("refuses to overwrite an existing active task", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const first = await prepareTaskStart(dependencies(fixture), { title: "First task" });
    if (first.status !== "ready") throw new Error("Expected ready start plan");
    await commitTaskStart(first, new AtomicTextFileWriter(fixture.fileSystem, () => ".first.tmp"));

    const second = await prepareTaskStart(dependencies(fixture), { title: "Second task" });

    expect(second.status).toBe("conflict");
    expect(second.exitCode).toBe(5);
    expect(second.diagnostics[0]?.message).toContain(first.state.taskId);
  });

  it("captures nested repository-relative context in a path containing spaces", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold start spaces ",
      nestedWorkingDirectory: "packages/example app",
    });

    const plan = await prepareTaskStart(dependencies(fixture), { title: "Nested task" });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") throw new Error("Expected ready start plan");
    expect(plan.repositoryRoot).toBe(fixture.root);
    expect(plan.state.workingContext).toBe("packages/example app");
    expect(plan.serializedState).not.toContain(fixture.root);
  });

  it.each([
    [
      "normal",
      { branch: "feat/oauth", commit: "abcdef0123456789abcdef0123456789abcdef01", detached: false },
    ],
    [
      "detached",
      {
        branch: "HEAD (detached)",
        commit: "abcdef0123456789abcdef0123456789abcdef01",
        detached: true,
      },
    ],
    ["unborn", { branch: "main", commit: null, detached: false }],
  ] as const)("supports %s Git starting facts", async (_name, facts) => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const plan = await prepareTaskStart(dependencies(fixture, new StubGitInspector(facts)), {
      title: "Git facts",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") throw new Error("Expected ready start plan");
    expect(plan.state.startingBranch).toBe(facts.branch);
    expect(plan.state.startingCommit).toBe(facts.commit);
  });

  it("warns for unignored local state and skips the warning for tracked state", async () => {
    const local = await createContinuityFixture(temporaryDirectories);
    const localInspector = new StubGitInspector(undefined, false);
    const localPlan = await prepareTaskStart(dependencies(local, localInspector), {
      title: "Local task",
    });
    expect(localPlan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFS005", severity: "warning" }),
    );
    expect(localInspector.ignoreReads[0]?.path).toBe(".briefonce/state/");

    const tracked = await createContinuityFixture(temporaryDirectories, {
      visibility: "tracked",
    });
    const trackedInspector = new StubGitInspector(undefined, false);
    const trackedPlan = await prepareTaskStart(dependencies(tracked, trackedInspector), {
      title: "Tracked task",
    });
    expect(trackedPlan.diagnostics).not.toContainEqual(expect.objectContaining({ code: "AFS005" }));
    expect(trackedInspector.ignoreReads).toEqual([]);
  });

  it.each(["", "   ", "x".repeat(201)])("rejects invalid title %j", async (title) => {
    const fixture = await createContinuityFixture(temporaryDirectories);

    const plan = await prepareTaskStart(dependencies(fixture), { title });

    expect(plan.status).toBe("invalid-title");
    expect(plan.exitCode).toBe(2);
  });

  it("rejects uninitialized and canonically invalid repositories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentfold-start-uninitialized-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, ".git"));
    const fileSystem = new NodeFileSystem(() => root);
    const uninitialized = await prepareTaskStart(
      {
        fileSystem,
        gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
        gitInspector: new StubGitInspector(),
        now: () => fixedTime,
      },
      { title: "Task" },
    );
    expect(uninitialized.status).toBe("invalid-context");

    const invalid = await createContinuityFixture(temporaryDirectories);
    await writeFile(path.join(invalid.root, ".briefonce", "config.yaml"), "version: [\n", "utf8");
    const invalidPlan = await prepareTaskStart(dependencies(invalid), { title: "Task" });
    expect(invalidPlan.status).toBe("invalid-context");
    expect(invalidPlan.exitCode).toBe(2);
  });
});
