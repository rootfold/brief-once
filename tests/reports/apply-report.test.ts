import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AtomicTextFileWriter } from "../../src/core/filesystem/atomic-text-file-writer.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import {
  commitAgentReport,
  prepareAgentReport,
  type PrepareAgentReportDependencies,
} from "../../src/core/reports/apply-report.js";
import { loadActiveState } from "../../src/core/state/load-active-state.js";
import { commitTaskStart, prepareTaskStart } from "../../src/core/state/start-task.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];
const startTime = new Date("2026-07-20T15:10:00.000Z");
const reportTime = new Date("2026-07-20T17:42:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function activeFixture() {
  const fixture = await createContinuityFixture(temporaryDirectories);
  const gitInspector = new StubGitInspector();
  const plan = await prepareTaskStart(
    {
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector,
      now: () => startTime,
    },
    { title: "Implement OAuth", agent: "codex" },
  );
  if (plan.status !== "ready") throw new Error("Expected ready start plan");
  await commitTaskStart(plan, new AtomicTextFileWriter(fixture.fileSystem, () => ".start.tmp"));
  return { ...fixture, gitInspector, initialState: plan.state };
}

function dependencies(
  fixture: Awaited<ReturnType<typeof activeFixture>>,
): PrepareAgentReportDependencies {
  return {
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector: fixture.gitInspector,
    now: () => reportTime,
  };
}

const fullReport = {
  agent: "claude",
  completed: ["Added callback route"],
  inProgress: ["Persisting session cookie"],
  decisions: [{ decision: "Reuse session table", reason: "Avoid a migration" }],
  failedAttempts: [{ attempt: "Used Strict cookies", result: "Redirect dropped cookie" }],
  blockers: ["Callback test fails"],
  nextActions: ["Test Lax cookies"],
  validation: [{ command: "pnpm test", status: "failed", summary: "One failure" }],
  assumptions: ["HTTPS terminates at proxy"],
};

describe("prepareAgentReport", () => {
  it("accepts, merges, persists, and reloads every structured report field", async () => {
    const fixture = await activeFixture();
    const plan = await prepareAgentReport(dependencies(fixture), {
      json: JSON.stringify(fullReport),
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") throw new Error("Expected ready report plan");

    await commitAgentReport(
      plan,
      new AtomicTextFileWriter(fixture.fileSystem, () => ".report.tmp"),
    );
    const loaded = await loadActiveState(fixture.fileSystem, fixture.root);
    if (loaded.status !== "success") throw new Error("Expected active state");

    expect(loaded.state).toMatchObject({
      objective: fixture.initialState.objective,
      startingBranch: fixture.initialState.startingBranch,
      startingCommit: fixture.initialState.startingCommit,
      lastAgent: "claude",
      reportRevision: 1,
      latestReportAt: reportTime.toISOString(),
      updatedAt: reportTime.toISOString(),
      completed: fullReport.completed,
      inProgress: fullReport.inProgress,
      decisions: fullReport.decisions,
      failedAttempts: fullReport.failedAttempts,
      blockers: fullReport.blockers,
      nextActions: fullReport.nextActions,
      validation: fullReport.validation,
      assumptions: fullReport.assumptions,
    });
  });

  it("merges a second report without deleting or duplicating earlier conclusions", async () => {
    const fixture = await activeFixture();
    const first = await prepareAgentReport(dependencies(fixture), {
      json: JSON.stringify(fullReport),
    });
    if (first.status !== "ready") throw new Error("Expected first report");
    await commitAgentReport(
      first,
      new AtomicTextFileWriter(fixture.fileSystem, () => ".first-report.tmp"),
    );

    const second = await prepareAgentReport(dependencies(fixture), {
      json: JSON.stringify({
        completed: ["Added callback route", "Added cookie test"],
        nextActions: ["Test Lax cookies", "Run full suite"],
      }),
    });
    if (second.status !== "ready") throw new Error("Expected second report");
    await commitAgentReport(
      second,
      new AtomicTextFileWriter(fixture.fileSystem, () => ".second-report.tmp"),
    );
    const loaded = await loadActiveState(fixture.fileSystem, fixture.root);
    if (loaded.status !== "success") throw new Error("Expected state");

    expect(loaded.state.completed).toEqual(["Added callback route", "Added cookie test"]);
    expect(loaded.state.decisions).toEqual(fullReport.decisions);
    expect(loaded.state.failedAttempts).toEqual(fullReport.failedAttempts);
    expect(loaded.state.blockers).toEqual(fullReport.blockers);
    expect(loaded.state.nextActions).toEqual(["Test Lax cookies", "Run full suite"]);
    expect(loaded.state.assumptions).toEqual(fullReport.assumptions);
  });

  it("uses --agent as explicit precedence and JSON agent as fallback", async () => {
    const fixture = await activeFixture();
    const overridden = await prepareAgentReport(dependencies(fixture), {
      json: JSON.stringify({ agent: "claude", completed: ["Done"] }),
      agentOverride: "gemini",
    });
    expect(overridden.status).toBe("ready");
    if (overridden.status !== "ready") throw new Error("Expected report");
    expect(overridden.report.agent).toBe("gemini");

    const fallback = await prepareAgentReport(dependencies(fixture), {
      json: JSON.stringify({ agent: "claude", completed: ["Done"] }),
    });
    expect(fallback.status).toBe("ready");
    if (fallback.status !== "ready") throw new Error("Expected report");
    expect(fallback.report.agent).toBe("claude");
  });

  it("rejects invalid JSON, invalid schema, empty reports, and private reasoning", async () => {
    const fixture = await activeFixture();

    await expect(prepareAgentReport(dependencies(fixture), { json: "{" })).resolves.toMatchObject({
      status: "invalid-json",
      exitCode: 2,
    });
    await expect(
      prepareAgentReport(dependencies(fixture), {
        json: JSON.stringify({ validation: [{ command: "test", status: "later", summary: "x" }] }),
      }),
    ).resolves.toMatchObject({ status: "invalid-report", exitCode: 2 });
    await expect(
      prepareAgentReport(dependencies(fixture), { json: JSON.stringify({ agent: "codex" }) }),
    ).resolves.toMatchObject({ status: "invalid-report", exitCode: 2 });
    const privateReport = await prepareAgentReport(dependencies(fixture), {
      json: JSON.stringify({ completed: ["Safe"], chainOfThought: "private" }),
    });
    expect(privateReport).toMatchObject({ status: "invalid-report", exitCode: 2 });
    expect(JSON.stringify(privateReport.diagnostics)).not.toContain('private"');
  });

  it("redacts fake secrets before persistence and emits only a count warning", async () => {
    const fixture = await activeFixture();
    const fakeSecret = "fake-secret-value-123";
    const plan = await prepareAgentReport(dependencies(fixture), {
      json: JSON.stringify({ completed: [`Configured token=${fakeSecret}`] }),
    });
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") throw new Error("Expected report");

    expect(plan.redactionCount).toBe(1);
    expect(plan.serializedState).toContain("[REDACTED]");
    expect(plan.serializedState).not.toContain(fakeSecret);
    expect(JSON.stringify(plan.diagnostics)).not.toContain(fakeSecret);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFR006", severity: "warning" }),
    );
  });

  it("never executes commands contained in validation results", async () => {
    const fixture = await activeFixture();
    const marker = path.join(fixture.root, "must-not-exist.txt");
    const plan = await prepareAgentReport(dependencies(fixture), {
      json: JSON.stringify({
        validation: [
          {
            command: `node -e require('fs').writeFileSync('${marker}','bad')`,
            status: "not_run",
            summary: "Reported only",
          },
        ],
      }),
    });

    expect(plan.status).toBe("ready");
    await expect(fixture.fileSystem.exists(marker)).resolves.toBe(false);
  });

  it("rejects a report when there is no active task", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const result = await prepareAgentReport(
      {
        fileSystem: fixture.fileSystem,
        gitRepositoryLocator: fixture.gitRepositoryLocator,
        gitInspector: new StubGitInspector(),
        now: () => reportTime,
      },
      { json: JSON.stringify({ completed: ["Done"] }) },
    );

    expect(result).toMatchObject({ status: "missing-state", exitCode: 5 });
  });

  it("rejects a report in an uninitialized repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentfold-report-uninitialized-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, ".git"));
    const fileSystem = new NodeFileSystem(() => root);

    const result = await prepareAgentReport(
      {
        fileSystem,
        gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
        gitInspector: new StubGitInspector(),
        now: () => reportTime,
      },
      { json: JSON.stringify({ completed: ["Done"] }) },
    );

    expect(result.status).toBe("invalid-context");
    expect(result.exitCode).not.toBe(0);
  });

  it("preserves previous state when the report atomic rename fails", async () => {
    const fixture = await activeFixture();
    const statePath = path.join(fixture.root, ".briefonce", "state", "current.md");
    const before = await fixture.fileSystem.readText(statePath);
    const plan = await prepareAgentReport(dependencies(fixture), {
      json: JSON.stringify({ completed: ["Would be new"] }),
    });
    if (plan.status !== "ready") throw new Error("Expected report");
    class FailingRenameFileSystem extends NodeFileSystem {
      override rename(): Promise<void> {
        return Promise.reject(new Error("Simulated report rename failure"));
      }
    }

    await expect(
      commitAgentReport(
        plan,
        new AtomicTextFileWriter(
          new FailingRenameFileSystem(() => fixture.root),
          () => ".failed-report.tmp",
        ),
      ),
    ).rejects.toThrow("Simulated report rename failure");
    await expect(fixture.fileSystem.readText(statePath)).resolves.toBe(before);
    await expect(
      fixture.fileSystem.exists(path.join(path.dirname(statePath), ".failed-report.tmp")),
    ).resolves.toBe(false);
    const loaded = await loadActiveState(fixture.fileSystem, fixture.root);
    if (loaded.status !== "success") throw new Error("Expected previous state");
    expect(loaded.state.reportRevision).toBe(0);
  });
});
