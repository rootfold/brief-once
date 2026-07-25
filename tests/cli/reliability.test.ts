import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { PersistentReliabilityEventStore } from "../../src/integrations/reliability/event-store.js";
import { PersistentSessionJournalStore } from "../../src/integrations/reliability/session-journal-store.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";
import { captureOutput } from "../helpers/capture-output.js";

const temporaryDirectories: string[] = [];
const fixedNow = new Date("2026-07-24T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureWithEvents() {
  const fixture = await createContinuityFixture(temporaryDirectories, {
    name: "agentfold reliability cli repository ",
  });
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold reliability cli state "));
  temporaryDirectories.push(stateDirectory);
  const repositoryId = (
    await import("../../src/core/reliability/repository-identity.js")
  ).canonicalRepositoryId(await fixture.fileSystem.realPath(fixture.root));
  let sequence = 0;
  const store = new PersistentReliabilityEventStore({
    fileSystem: fixture.fileSystem,
    stateDirectory,
    repositoryId,
    maximumEvents: 1_000,
    now: () => new Date(fixedNow.getTime() + sequence * 1_000),
    generateEventId: () => `cli-event-${++sequence}`,
    restrictDirectory: () => Promise.resolve(),
    restrictFile: () => Promise.resolve(),
  });
  for (const event of [
    {
      eventType: "session_opened" as const,
      host: "codex" as const,
      client: "codex-desktop",
      agent: "codex",
      sessionId: "session-codex",
      taskId: "AF-20260724-001",
      outcome: "success" as const,
    },
    {
      eventType: "task_continued" as const,
      host: "codex" as const,
      client: "codex-desktop",
      agent: "codex",
      sessionId: "session-codex",
      taskId: "AF-20260724-001",
      outcome: "success" as const,
    },
    {
      eventType: "progress_report_submitted" as const,
      host: "codex" as const,
      client: "codex-desktop",
      agent: "codex",
      sessionId: "session-codex",
      taskId: "AF-20260724-001",
      semanticRevision: 1,
      outcome: "success" as const,
    },
    {
      eventType: "checkpoint_created" as const,
      host: "codex" as const,
      client: "codex-desktop",
      agent: "codex",
      sessionId: "session-codex",
      taskId: "AF-20260724-001",
      checkpointId: "CP-001",
      semanticFreshness: "current" as const,
      outcome: "success" as const,
    },
    {
      eventType: "session_closed" as const,
      host: "codex" as const,
      client: "codex-desktop",
      agent: "codex",
      sessionId: "session-codex",
      taskId: "AF-20260724-001",
      outcome: "success" as const,
    },
    {
      eventType: "session_opened" as const,
      host: "antigravity" as const,
      client: "antigravity-ide",
      agent: "antigravity",
      sessionId: "session-antigravity",
      taskId: "AF-20260724-002",
      outcome: "success" as const,
    },
  ]) {
    await store.record(event);
  }
  await new PersistentSessionJournalStore({
    fileSystem: fixture.fileSystem,
    stateDirectory,
    restrictFile: () => Promise.resolve(),
  }).write({
    schemaVersion: 1,
    serviceInstanceId: "service-cli-fixture",
    writtenAt: fixedNow.toISOString(),
    sessions: [
      {
        sessionId: "session-antigravity-pending",
        repositoryId,
        canonicalRepositoryRoot: fixture.root,
        host: "antigravity",
        client: "antigravity",
        agent: "antigravity",
        taskId: "AF-20260724-002",
        openedAt: fixedNow.toISOString(),
        lastHeartbeatAt: fixedNow.toISOString(),
        leaseExpiresAt: fixedNow.toISOString(),
        state: "recovery_pending",
        lastLifecycleEvent: "report_submitted",
        reportCount: 1,
        checkpointCount: 0,
        recoveryAttempts: 1,
      },
    ],
  });
  return { ...fixture, stateDirectory, store };
}

function options(
  fixture: Awaited<ReturnType<typeof fixtureWithEvents>>,
  output: ReturnType<typeof captureOutput>,
) {
  return {
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector: new StubGitInspector(undefined, true),
    reliabilityStateDirectory: fixture.stateDirectory,
    output: output.output,
    now: () => fixedNow,
  };
}

describe("reliability CLI", () => {
  it("renders concise human output and leaves repository state byte-for-byte unchanged", async () => {
    const fixture = await fixtureWithEvents();
    const currentPath = path.join(fixture.root, ".briefonce", "config.yaml");
    const before = await readFile(currentPath, "utf8");
    const output = captureOutput();
    expect(await runCli(["node", "agentfold", "reliability"], options(fixture, output))).toBe(0);
    expect(output.stdout()).toContain("BriefOnce reliability");
    expect(output.stdout()).toContain("Codex");
    expect(output.stdout()).toContain("Observed lifecycle completion: 100%");
    expect(output.stdout()).toContain("Continuity quality");
    expect(await readFile(currentPath, "utf8")).toBe(before);
  });

  it("emits stable JSON and filters hosts, tasks, sessions, and included events", async () => {
    const fixture = await fixtureWithEvents();
    const output = captureOutput();
    expect(
      await runCli(
        [
          "node",
          "agentfold",
          "reliability",
          "--host",
          "codex",
          "--task",
          "AF-20260724-001",
          "--session",
          "session-codex",
          "--limit",
          "4",
          "--include-events",
          "--json",
        ],
        options(fixture, output),
      ),
    ).toBe(0);
    const report = JSON.parse(output.stdout()) as {
      hosts: { host: string }[];
      events: unknown[];
      repositoryId: string;
      totals: { recoveryPendingSessions: number };
    };
    expect(report.hosts.map((host) => host.host)).toEqual(["codex"]);
    expect(report.events).toHaveLength(4);
    expect(report.totals.recoveryPendingSessions).toBe(0);
    expect(report.repositoryId).toMatch(/^[a-f0-9]{24}$/u);
    expect(output.stdout()).not.toContain(fixture.root);
  });

  it("rejects unknown hosts and invalid limits without mutating history", async () => {
    const fixture = await fixtureWithEvents();
    const before = await readFile(fixture.store.filePath, "utf8");
    const host = captureOutput();
    expect(
      await runCli(
        ["node", "agentfold", "reliability", "--host", "claude"],
        options(fixture, host),
      ),
    ).toBe(2);
    expect(host.stdout()).toContain("AFREL016");
    const limit = captureOutput();
    expect(
      await runCli(["node", "agentfold", "reliability", "--limit", "0"], options(fixture, limit)),
    ).toBe(2);
    expect(await readFile(fixture.store.filePath, "utf8")).toBe(before);
  });

  it("returns a focused informational result when no matching history exists", async () => {
    const fixture = await fixtureWithEvents();
    const output = captureOutput();
    expect(
      await runCli(
        ["node", "agentfold", "reliability", "--session", "unknown-session"],
        options(fixture, output),
      ),
    ).toBe(0);
    expect(output.stdout()).toContain("No BriefOnce lifecycle activity");
    expect(output.stdout()).toContain("AFREL017");
  });

  it("rejects a corrupt private store without rewriting it", async () => {
    const fixture = await fixtureWithEvents();
    await writeFile(fixture.store.filePath, "{broken", "utf8");
    const output = captureOutput();
    expect(await runCli(["node", "agentfold", "reliability"], options(fixture, output))).toBe(2);
    expect(output.stdout()).toContain("AFREL004");
    expect(await readFile(fixture.store.filePath, "utf8")).toBe("{broken");
  });
});
