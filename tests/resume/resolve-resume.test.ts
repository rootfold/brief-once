import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assembleCheckpoint } from "../../src/core/checkpoints/assemble-checkpoint.js";
import { serializeCheckpoint } from "../../src/core/checkpoints/serialize-checkpoint.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import { activeTaskSchema } from "../../src/core/state/active-state-schema.js";
import { loadActiveState } from "../../src/core/state/load-active-state.js";
import { serializeActiveState } from "../../src/core/state/serialize-active-state.js";
import { prepareResume } from "../../src/core/resume/prepare-resume.js";
import {
  checkpointPath,
  createResumeCheckpoint,
  createResumeFixture,
  resumeGitFacts,
  submitResumeReport,
} from "../helpers/resume-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function loadedState(fixture: Awaited<ReturnType<typeof createResumeFixture>>) {
  const loaded = await loadActiveState(fixture.fileSystem, fixture.root);
  if (loaded.status !== "success") throw new Error("Expected active state");
  return loaded.state;
}

function dependencies(fixture: Awaited<ReturnType<typeof createResumeFixture>>) {
  return {
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
  };
}

describe("resume checkpoint resolution", () => {
  it("selects the active-state latest checkpoint and never invokes Git inspection", async () => {
    const fixture = await createResumeFixture(temporaryDirectories, {
      name: "agentfold resume spaces ",
    });
    await fixture.fileSystem.writeText(path.join(fixture.root, "source-secret.txt"), "source only");
    const statePath = path.join(fixture.root, ".briefonce", "state", "current.md");
    const historyPath = checkpointPath(
      fixture.root,
      fixture.checkpoint.taskId,
      fixture.checkpoint.checkpointId,
    );
    const stateBefore = await fixture.fileSystem.readText(statePath);
    const historyBefore = await fixture.fileSystem.readText(historyPath);

    const result = await prepareResume(dependencies(fixture));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected resume packet");
    expect(result.packet.task).toMatchObject({ checkpointId: "CP-001", isLatestCheckpoint: true });
    expect(result.packet.project.name).toContain("agentfold resume spaces");
    expect(result.packet.task.objective).toContain("GitHub OAuth");
    expect(result.packet.observedGitState.currentBranch).toBe("feat/oauth");
    expect(result.packet.semanticState).toMatchObject({
      freshness: "new",
      completed: ["Added callback route"],
      blockers: ["Callback test fails"],
    });
    expect(result.content).not.toContain(fixture.root);
    expect(result.content).not.toContain("source only");
    expect(result.content).not.toContain("# Project Context");
    expect(fixture.inspector.factReads).toEqual([]);
    expect(fixture.inspector.checkpointReads).toEqual([]);
    expect(fixture.inspector.ignoreReads).toEqual([]);
    await expect(fixture.fileSystem.readText(statePath)).resolves.toBe(stateBefore);
    await expect(fixture.fileSystem.readText(historyPath)).resolves.toBe(historyBefore);
  });

  it("uses the metadata checkpoint even when a lexically higher unrelated filename exists", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const history = path.join(fixture.root, ".briefonce", "state", "history");
    await fixture.fileSystem.writeText(
      path.join(history, "AF-20260720-999-CP-999.md"),
      "unrelated",
    );

    const result = await prepareResume(dependencies(fixture));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected resume packet");
    expect(result.packet.task.checkpointId).toBe("CP-001");
  });

  it("falls back to the highest same-task valid filename for old metadata and warns", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    await submitResumeReport(fixture, "2026-07-20T19:00:00.000Z", {
      completed: ["Second revision"],
    });
    await createResumeCheckpoint(fixture, "2026-07-20T20:00:00.000Z", resumeGitFacts());
    const state = await loadedState(fixture);
    const statePath = path.join(fixture.root, ".briefonce", "state", "current.md");
    await fixture.fileSystem.writeText(
      statePath,
      serializeActiveState({
        ...state,
        checkpointHistory: {
          ...state.checkpointHistory,
          latestCheckpointId: null,
          latestFingerprint: null,
        },
      }),
    );
    const history = path.join(fixture.root, ".briefonce", "state", "history");
    await fixture.fileSystem.writeText(path.join(history, `${state.taskId}-CP-bad.md`), "ignored");
    await fixture.fileSystem.writeText(path.join(history, "AF-20260720-999-CP-999.md"), "ignored");

    const result = await prepareResume(dependencies(fixture));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected resume packet");
    expect(result.packet.task.checkpointId).toBe("CP-002");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "AFR009" }));
    await expect(fixture.fileSystem.readText(statePath)).resolves.toBe(
      serializeActiveState({
        ...state,
        checkpointHistory: {
          ...state.checkpointHistory,
          latestCheckpointId: null,
          latestFingerprint: null,
        },
      }),
    );
  });

  it("allows explicit historical short and full identities and marks them not latest", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    await submitResumeReport(fixture, "2026-07-20T19:00:00.000Z", {
      completed: ["Second revision"],
    });
    await createResumeCheckpoint(fixture, "2026-07-20T20:00:00.000Z", resumeGitFacts());

    for (const requested of ["CP-001", `${fixture.checkpoint.taskId}-CP-001`]) {
      const result = await prepareResume(dependencies(fixture), { checkpoint: requested });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") throw new Error("Expected historical packet");
      expect(result.packet.task).toMatchObject({
        checkpointId: "CP-001",
        isLatestCheckpoint: false,
      });
      expect(result.content).toContain("historical checkpoint");
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "AFR013" }));
    }
  });

  it.each(["../CP-001", "folder/CP-001", "folder\\CP-001", "C:\\CP-001.md"])(
    "rejects unsafe explicit checkpoint value %s",
    async (requested) => {
      const fixture = await createResumeFixture(temporaryDirectories);
      await expect(
        prepareResume(dependencies(fixture), { checkpoint: requested }),
      ).resolves.toMatchObject({
        status: "invalid-checkpoint",
        exitCode: 2,
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFR007" })]),
      });
    },
  );

  it("fails when the metadata latest file is missing or a requested checkpoint is absent", async () => {
    const missingLatest = await createResumeFixture(temporaryDirectories);
    await missingLatest.fileSystem.remove(
      checkpointPath(
        missingLatest.root,
        missingLatest.checkpoint.taskId,
        missingLatest.checkpoint.checkpointId,
      ),
    );
    await expect(prepareResume(dependencies(missingLatest))).resolves.toMatchObject({
      status: "invalid-checkpoint",
      exitCode: 6,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFR005" })]),
    });

    const missingExplicit = await createResumeFixture(temporaryDirectories);
    await expect(
      prepareResume(dependencies(missingExplicit), { checkpoint: "CP-002" }),
    ).resolves.toMatchObject({
      status: "invalid-checkpoint",
      exitCode: 6,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFR006" })]),
    });
  });

  it("rejects checkpoint ID, task ID, fingerprint, and active-metadata mismatches", async () => {
    const idMismatch = await createResumeFixture(temporaryDirectories);
    const idPath = checkpointPath(idMismatch.root, idMismatch.checkpoint.taskId, "CP-001");
    await idMismatch.fileSystem.writeText(
      idPath,
      serializeCheckpoint({ ...idMismatch.checkpoint, checkpointId: "CP-002" }),
    );
    await expect(prepareResume(dependencies(idMismatch))).resolves.toMatchObject({
      status: "invalid-checkpoint",
      exitCode: 2,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFR008" })]),
    });

    const taskMismatch = await createResumeFixture(temporaryDirectories);
    const state = await loadedState(taskMismatch);
    const otherState = activeTaskSchema.parse({ ...state, taskId: "AF-20260720-999" });
    const otherCheckpoint = assembleCheckpoint({
      activeTask: otherState,
      gitFacts: resumeGitFacts(),
      checkpointId: "CP-001",
      createdAt: "2026-07-20T18:30:00.000Z",
    });
    await taskMismatch.fileSystem.writeText(
      checkpointPath(taskMismatch.root, state.taskId, "CP-001"),
      serializeCheckpoint(otherCheckpoint),
    );
    await expect(prepareResume(dependencies(taskMismatch))).resolves.toMatchObject({
      status: "invalid-checkpoint",
      exitCode: 2,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFR008" })]),
    });

    const fingerprint = await createResumeFixture(temporaryDirectories);
    const fingerprintPath = checkpointPath(
      fingerprint.root,
      fingerprint.checkpoint.taskId,
      "CP-001",
    );
    await fingerprint.fileSystem.writeText(
      fingerprintPath,
      (await fingerprint.fileSystem.readText(fingerprintPath)).replace(
        /fingerprint: [0-9a-f]{64}/u,
        `fingerprint: ${"0".repeat(64)}`,
      ),
    );
    await expect(prepareResume(dependencies(fingerprint))).resolves.toMatchObject({
      status: "invalid-checkpoint",
      exitCode: 2,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFR011" })]),
    });

    const metadata = await createResumeFixture(temporaryDirectories);
    const metadataState = await loadedState(metadata);
    await metadata.fileSystem.writeText(
      path.join(metadata.root, ".briefonce", "state", "current.md"),
      serializeActiveState({
        ...metadataState,
        checkpointHistory: {
          ...metadataState.checkpointHistory,
          latestFingerprint: "a".repeat(64),
        },
      }),
    );
    await expect(prepareResume(dependencies(metadata))).resolves.toMatchObject({
      status: "invalid-checkpoint",
      exitCode: 2,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFR008" })]),
    });
  });

  it("blocks secret-like semantic content without printing the value", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const secret = "fake-secret-value-123456";
    const unsafe = {
      ...fixture.checkpoint,
      reportedState: {
        ...fixture.checkpoint.reportedState,
        blockers: [`Configured token=${secret}`],
      },
    };
    await fixture.fileSystem.writeText(
      checkpointPath(fixture.root, fixture.checkpoint.taskId, "CP-001"),
      serializeCheckpoint(unsafe),
    );

    const result = await prepareResume(dependencies(fixture));

    expect(result).toMatchObject({ status: "unsafe-content", exitCode: 4 });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("handles detached HEAD, no commits, no changed paths, and absent semantic state", async () => {
    const fixture = await createResumeFixture(temporaryDirectories, {
      withReport: false,
      facts: resumeGitFacts({
        branch: "HEAD (detached)",
        commit: null,
        detached: true,
        workingTree: "clean",
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        changedPaths: {
          added: [],
          modified: [],
          deleted: [],
          renamed: [],
          copied: [],
          untracked: [],
          unmerged: [],
        },
        diffStatistics: {
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
          binaryFiles: 0,
          untrackedFiles: 0,
        },
        recentCommits: [],
      }),
    });

    const result = await prepareResume(dependencies(fixture));

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected Git-only packet");
    expect(result.packet.observedGitState).toMatchObject({ detached: true, currentCommit: null });
    expect(result.packet.semanticState).toMatchObject({ freshness: "none", completed: [] });
    expect(result.content).toContain("No changed paths were recorded");
    expect(result.content).toContain("No recent commits were recorded");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "AFR015" }));
  });

  it("normalizes Windows Git paths and emits a truncation warning for bounded packets", async () => {
    const windowsPath = await createResumeFixture(temporaryDirectories, {
      facts: resumeGitFacts({
        changedPaths: {
          added: ["src\\auth\\github.ts"],
          modified: ["src\\routes\\auth.ts"],
          deleted: [],
          renamed: [],
          copied: [],
          untracked: ["tests\\auth\\github test.ts"],
          unmerged: [],
        },
      }),
    });
    const normalized = await prepareResume(dependencies(windowsPath));
    expect(normalized.status).toBe("ready");
    if (normalized.status !== "ready") throw new Error("Expected normalized packet");
    expect(normalized.packet.observedGitState.changedPaths.added).toEqual(["src/auth/github.ts"]);

    const bounded = await createResumeFixture(temporaryDirectories, { withReport: false });
    await submitResumeReport(bounded, "2026-07-20T19:00:00.000Z", {
      completed: Array.from({ length: 70 }, (_, index) => `Completed item ${index}`),
    });
    await createResumeCheckpoint(bounded, "2026-07-20T20:00:00.000Z", resumeGitFacts());
    const truncated = await prepareResume(dependencies(bounded));
    expect(truncated.status).toBe("ready");
    if (truncated.status !== "ready") throw new Error("Expected bounded packet");
    expect(truncated.packet.semanticState.completed).toHaveLength(50);
    expect(truncated.packet.omitted.semantic.completed).toBe(20);
    expect(truncated.diagnostics).toContainEqual(expect.objectContaining({ code: "AFR016" }));
  });

  it("reads only canonical state data and returns structured diagnostics for checkpoint I/O failure", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const sourcePath = path.join(fixture.root, "src", "not-for-resume.ts");
    await fixture.fileSystem.ensureDirectory(path.dirname(sourcePath));
    await fixture.fileSystem.writeText(sourcePath, "export const sourceOnly = true;\n");
    class RecordingFileSystem extends NodeFileSystem {
      readonly reads: string[] = [];

      override readText(candidate: string): Promise<string> {
        this.reads.push(path.resolve(candidate));
        return super.readText(candidate);
      }
    }
    const recording = new RecordingFileSystem(() => fixture.root);
    const result = await prepareResume({
      fileSystem: recording,
      gitRepositoryLocator: new FilesystemGitRepositoryLocator(recording),
    });
    expect(result.status).toBe("ready");
    expect(recording.reads).not.toContain(path.resolve(sourcePath));
    expect(
      recording.reads.every((candidate) => candidate.includes(`${path.sep}.briefonce${path.sep}`)),
    ).toBe(true);

    class FailingCheckpointFileSystem extends NodeFileSystem {
      override readText(candidate: string): Promise<string> {
        return candidate.includes(`${path.sep}state${path.sep}history${path.sep}`)
          ? Promise.reject(new Error("simulated read failure"))
          : super.readText(candidate);
      }
    }
    const failing = new FailingCheckpointFileSystem(() => fixture.root);
    const failed = await prepareResume({
      fileSystem: failing,
      gitRepositoryLocator: new FilesystemGitRepositoryLocator(failing),
    });
    expect(failed).toMatchObject({
      status: "invalid-checkpoint",
      exitCode: 1,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "AFR018" })]),
    });
    expect(JSON.stringify(failed)).not.toContain("simulated read failure");
  });
});
