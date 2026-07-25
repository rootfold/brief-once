import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCheckpoint } from "../../src/core/checkpoints/parse-checkpoint.js";
import { commitTaskFinish, prepareTaskFinish } from "../../src/core/completion/finish-task.js";
import { parseCompletedTask } from "../../src/core/completion/parse-completed-task.js";
import {
  AtomicTextFileWriter,
  type AtomicTextFileWriteMode,
} from "../../src/core/filesystem/atomic-text-file-writer.js";
import { commitAgentReport, prepareAgentReport } from "../../src/core/reports/apply-report.js";
import { loadActiveState } from "../../src/core/state/load-active-state.js";
import { commitTaskStart, prepareTaskStart } from "../../src/core/state/start-task.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];
const startTime = new Date("2026-07-21T01:00:00.000Z");
const finishTime = new Date("2026-07-21T02:00:00.500Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function activeFixture(name = "agentfold-finish with spaces-") {
  const fixture = await createContinuityFixture(temporaryDirectories, { name });
  const inspector = new StubGitInspector(undefined, true);
  const start = await prepareTaskStart(
    {
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: inspector,
      now: () => startTime,
    },
    { title: "Implement OAuth completion", agent: "codex" },
  );
  if (start.status !== "ready") throw new Error("Expected active task fixture");
  await commitTaskStart(
    start,
    new AtomicTextFileWriter(fixture.fileSystem, () => ".finish-start.tmp"),
  );
  return { ...fixture, inspector, taskId: start.state.taskId };
}

function dependencies(fixture: Awaited<ReturnType<typeof activeFixture>>) {
  return {
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector: fixture.inspector,
    now: () => finishTime,
  };
}

async function report(
  fixture: Awaited<ReturnType<typeof activeFixture>>,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  const plan = await prepareAgentReport(
    { ...dependencies(fixture), now: () => new Date("2026-07-21T01:30:00.000Z") },
    { json: JSON.stringify({ agent: "codex", ...value }) },
  );
  if (plan.status !== "ready") throw new Error("Expected report fixture");
  await commitAgentReport(
    plan,
    new AtomicTextFileWriter(fixture.fileSystem, () => ".finish-report.tmp"),
  );
}

describe("task finish preparation and commit", () => {
  it("previews without writes, then creates a final checkpoint and archive before removing active state", async () => {
    const fixture = await activeFixture();
    await report(fixture, {
      completed: ["Implemented callback"],
      validation: [{ command: "pnpm test", status: "passed", summary: "All tests passed" }],
    });
    const statePath = path.join(fixture.root, ".briefonce", "state", "current.md");
    const before = await fixture.fileSystem.readText(statePath);

    const plan = await prepareTaskFinish(dependencies(fixture), {
      completion: { summary: "Implemented and validated OAuth.", agent: "codex" },
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.checkpoint).toMatchObject({ kind: "final", taskStatus: "completed" });
    expect(plan.checkpoint.observedGit.workingTree).toBe("clean");
    await expect(fixture.fileSystem.readText(statePath)).resolves.toBe(before);
    await expect(fixture.fileSystem.exists(plan.historyPath)).resolves.toBe(false);
    await expect(fixture.fileSystem.exists(plan.completedPath)).resolves.toBe(false);

    const committed = await commitTaskFinish(
      plan,
      fixture.fileSystem,
      new AtomicTextFileWriter(fixture.fileSystem, (name) => `.${name}.finish.tmp`),
    );

    expect(committed.status).toBe("success");
    await expect(fixture.fileSystem.exists(statePath)).resolves.toBe(false);
    expect(parseCheckpoint(await fixture.fileSystem.readText(plan.historyPath))).toMatchObject({
      kind: "final",
      taskStatus: "completed",
      checkpointId: "CP-001",
    });
    const archived = parseCompletedTask(await fixture.fileSystem.readText(plan.completedPath));
    expect(archived).toMatchObject({
      taskId: fixture.taskId,
      finalCheckpointId: "CP-001",
      checkpointCount: 1,
      durationSeconds: 3_600,
      summary: "Implemented and validated OAuth.",
    });
    expect(archived.validation).toHaveLength(1);
  });

  it("blocks unresolved work and blockers, accepts exact resolutions, and rejects unknown entries", async () => {
    const fixture = await activeFixture("agentfold-finish-resolution-");
    await report(fixture, {
      inProgress: ["Persisting the OAuth cookie"],
      blockers: ["Callback test was failing"],
    });

    const blocked = await prepareTaskFinish(dependencies(fixture), {
      completion: { summary: "OAuth work is complete." },
    });
    expect(blocked).toMatchObject({
      status: "not-ready",
      unresolvedInProgress: ["Persisting the OAuth cookie"],
      unresolvedBlockers: ["Callback test was failing"],
    });

    const unknown = await prepareTaskFinish(dependencies(fixture), {
      completion: {
        summary: "OAuth work is complete.",
        resolvedInProgress: ["Different item"],
      },
    });
    expect(unknown.status).toBe("invalid-input");

    const ready = await prepareTaskFinish(dependencies(fixture), {
      completion: {
        summary: "OAuth work is complete.",
        resolvedInProgress: ["  Persisting the OAuth cookie  "],
        resolvedBlockers: ["Callback test was failing"],
        finalReport: {
          completed: ["Removed token=super-secret-value from the fixture"],
          validation: [{ command: "pnpm test", status: "failed", summary: "One known failure" }],
        },
      },
      agentOverride: "codex",
    });
    expect(ready.status).toBe("ready");
    if (ready.status === "ready") {
      expect(ready.task.completed).toContain("Persisting the OAuth cookie");
      expect(JSON.stringify(ready.task)).not.toContain("super-secret-value");
      expect(ready.task.completed.some((item) => item.includes("[REDACTED]"))).toBe(true);
      expect(ready.task.validation[0]?.status).toBe("failed");
      expect(ready.diagnostics.some((item) => item.code === "AFF014")).toBe(true);
    }
  });

  it("rejects private reasoning and leaves active state byte-for-byte unchanged", async () => {
    const fixture = await activeFixture("agentfold-finish-private-");
    const statePath = path.join(fixture.root, ".briefonce", "state", "current.md");
    const before = await fixture.fileSystem.readText(statePath);
    const plan = await prepareTaskFinish(dependencies(fixture), {
      completion: { summary: "Done", chainOfThought: "private" },
    });
    expect(plan.status).toBe("invalid-input");
    await expect(fixture.fileSystem.readText(statePath)).resolves.toBe(before);
  });

  it("rolls back a newly created final checkpoint when archive creation fails", async () => {
    const fixture = await activeFixture("agentfold-finish-rollback-");
    const plan = await prepareTaskFinish(dependencies(fixture), {
      completion: { summary: "Ready to archive." },
    });
    if (plan.status !== "ready") throw new Error("Expected ready finish");
    let writes = 0;
    class FailingArchiveWriter extends AtomicTextFileWriter {
      override async write(
        destination: string,
        content: string,
        mode: AtomicTextFileWriteMode,
      ): Promise<void> {
        writes += 1;
        if (writes === 2) throw new Error("simulated archive failure");
        return super.write(destination, content, mode);
      }
    }
    const result = await commitTaskFinish(
      plan,
      fixture.fileSystem,
      new FailingArchiveWriter(fixture.fileSystem, (name) => `.${name}.rollback.tmp`),
    );
    expect(result.status).toBe("write-failure");
    await expect(fixture.fileSystem.exists(plan.historyPath)).resolves.toBe(false);
    await expect(fixture.fileSystem.exists(plan.completedPath)).resolves.toBe(false);
    expect((await loadActiveState(fixture.fileSystem, fixture.root)).status).toBe("success");
  });

  it("never overwrites an archive, repeated finish creates nothing, and a new task gets a new ID", async () => {
    const collisionFixture = await activeFixture("agentfold-finish-collision-");
    const collisionPath = path.join(
      collisionFixture.root,
      ".briefonce",
      "state",
      "completed",
      `${collisionFixture.taskId}.md`,
    );
    await collisionFixture.fileSystem.ensureDirectory(path.dirname(collisionPath));
    await collisionFixture.fileSystem.writeText(collisionPath, "keep\n");
    const collision = await prepareTaskFinish(dependencies(collisionFixture), {
      completion: { summary: "Cannot overwrite." },
    });
    expect(collision.status).toBe("completed-conflict");
    await expect(collisionFixture.fileSystem.readText(collisionPath)).resolves.toBe("keep\n");

    const fixture = await activeFixture("agentfold-finish-next-");
    const finish = await prepareTaskFinish(dependencies(fixture), {
      completion: { summary: "Task A complete." },
    });
    if (finish.status !== "ready") throw new Error("Expected ready finish");
    expect(
      await commitTaskFinish(
        finish,
        fixture.fileSystem,
        new AtomicTextFileWriter(fixture.fileSystem, (name) => `.${name}.next.tmp`),
      ),
    ).toMatchObject({ status: "success" });
    expect((await prepareTaskFinish(dependencies(fixture))).status).toBe("missing-state");

    const next = await prepareTaskStart(
      { ...dependencies(fixture), now: () => new Date("2026-07-21T03:00:00.000Z") },
      { title: "Task B", agent: "codex" },
    );
    expect(next.status).toBe("ready");
    if (next.status === "ready") expect(next.state.taskId).toBe("AF-20260721-002");
  });
});
