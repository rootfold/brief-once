import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import type { StdinReader } from "../../src/cli/input/stdin-reader.js";
import { defaultReliabilityPolicy } from "../../src/core/config/reliability-policy.js";
import type { CheckpointGitFacts } from "../../src/core/git/checkpoint-git-types.js";
import { canonicalRepositoryId } from "../../src/core/reliability/repository-identity.js";
import { createAgentFoldIntegrationOperations } from "../../src/integrations/application/integration-operations.js";
import { InMemorySessionRegistry } from "../../src/integrations/mcp/session-registry.js";
import { PersistentReliabilityEventStore } from "../../src/integrations/reliability/event-store.js";
import { createReliabilityRecorder } from "../../src/integrations/reliability/recorder.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";
import { captureOutput } from "../helpers/capture-output.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class StringStdinReader implements StdinReader {
  constructor(private readonly value: string) {}
  readAll(): Promise<string> {
    return Promise.resolve(this.value);
  }
}

function facts(): CheckpointGitFacts {
  return {
    branch: "main",
    commit: "0123456789abcdef0123456789abcdef01234567",
    detached: false,
    workingTree: "dirty",
    hasStagedChanges: false,
    hasUnstagedChanges: true,
    changedPaths: {
      added: [],
      modified: ["src/example.ts"],
      deleted: [],
      renamed: [],
      copied: [],
      untracked: [],
      unmerged: [],
    },
    diffStatistics: {
      filesChanged: 1,
      insertions: 4,
      deletions: 0,
      binaryFiles: 0,
      untrackedFiles: 0,
    },
    recentCommits: [],
  };
}

describe("host-neutral lifecycle recording", () => {
  it("records applied direct CLI lifecycle operations and skips previews", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold direct reliability ",
    });
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold direct state "));
    temporaryDirectories.push(stateDirectory);
    const inspector = new StubGitInspector(undefined, true, facts());
    let now = new Date("2026-07-24T08:00:00.000Z");
    const base = {
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: inspector,
      reliabilityStateDirectory: stateDirectory,
      reliabilityPersistence: true,
      output: captureOutput().output,
      now: () => now,
    };
    expect(
      await runCli(["node", "agentfold", "start", "Record direct lifecycle", "--yes"], {
        ...base,
        stdinReader: new StringStdinReader(""),
      }),
    ).toBe(0);
    now = new Date("2026-07-24T08:01:00.000Z");
    expect(
      await runCli(["node", "agentfold", "report", "--stdin"], {
        ...base,
        stdinReader: new StringStdinReader(
          JSON.stringify({
            agent: "codex",
            completed: ["Added lifecycle recorder"],
            validation: [{ command: "pnpm test", status: "passed", summary: "Passed" }],
          }),
        ),
      }),
    ).toBe(0);
    expect(
      await runCli(["node", "agentfold", "checkpoint"], {
        ...base,
        stdinReader: new StringStdinReader(""),
      }),
    ).toBe(0);
    expect(
      await runCli(["node", "agentfold", "checkpoint"], {
        ...base,
        stdinReader: new StringStdinReader(""),
      }),
    ).toBe(0);
    expect(
      await runCli(["node", "agentfold", "resume", "--format", "json"], {
        ...base,
        stdinReader: new StringStdinReader(""),
        output: captureOutput().output,
      }),
    ).toBe(0);
    now = new Date("2026-07-24T08:02:00.000Z");
    expect(
      await runCli(["node", "agentfold", "finish", "--stdin", "--yes"], {
        ...base,
        stdinReader: new StringStdinReader(
          JSON.stringify({
            summary: "Direct lifecycle complete.",
            agent: "codex",
            finalReport: {
              completed: ["Verified direct lifecycle"],
              validation: [{ command: "pnpm test", status: "passed", summary: "Passed" }],
            },
          }),
        ),
      }),
    ).toBe(0);

    const repositoryId = canonicalRepositoryId(await fixture.fileSystem.realPath(fixture.root));
    const store = new PersistentReliabilityEventStore({
      fileSystem: fixture.fileSystem,
      stateDirectory,
      repositoryId,
      maximumEvents: 1_000,
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    const eventTypes = (await store.read())?.events.map((event) => event.eventType) ?? [];
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "task_started",
        "progress_report_submitted",
        "checkpoint_created",
        "checkpoint_duplicate",
        "resume_packet_requested",
        "resume_packet_current",
        "task_finished",
      ]),
    );
    expect((await store.read())?.events.every((event) => event.host === "cli")).toBe(true);

    const previewFixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold preview reliability ",
    });
    const previewState = path.join(os.tmpdir(), `agentfold-preview-${Date.now()}`);
    temporaryDirectories.push(previewState);
    expect(
      await runCli(["node", "agentfold", "start", "Preview only", "--dry-run"], {
        fileSystem: previewFixture.fileSystem,
        gitRepositoryLocator: previewFixture.gitRepositoryLocator,
        gitInspector: inspector,
        stdinReader: new StringStdinReader(""),
        output: captureOutput().output,
        reliabilityStateDirectory: previewState,
        reliabilityPersistence: true,
      }),
    ).toBe(0);
    await expect(previewFixture.fileSystem.exists(previewState)).resolves.toBe(false);
  }, 30_000);

  it("records embedded MCP events without depending on the shared service", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold embedded reliability ",
    });
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold embedded state "));
    temporaryDirectories.push(stateDirectory);
    const repositoryId = canonicalRepositoryId(await fixture.fileSystem.realPath(fixture.root));
    let eventId = 0;
    const recorder = createReliabilityRecorder({
      repositoryId,
      stateDirectory,
      policy: defaultReliabilityPolicy,
      fileSystem: fixture.fileSystem,
      generateEventId: () => `embedded-event-${++eventId}`,
      restrictDirectory: () => Promise.resolve(),
      restrictFile: () => Promise.resolve(),
    });
    const operations = createAgentFoldIntegrationOperations({
      requestedWorkspace: fixture.root,
      repositoryRoot: fixture.root,
      version: "0.0.0-test",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true, facts()),
      now: () => new Date("2026-07-24T09:00:00.000Z"),
      sessions: new InMemorySessionRegistry({ generateId: () => "embedded-session" }),
      debug: false,
      logger: { debug: () => undefined, error: () => undefined },
      reliability: recorder,
      reliabilityMode: "embedded",
    });
    const opened = await operations.openSession({
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    const sessionId = String((opened.data as { sessionId: string }).sessionId);
    await operations.beginTask({ sessionId, title: "Embedded reliability" });
    await operations.reportProgress({
      sessionId,
      completed: ["Recorded embedded progress"],
    });
    await operations.createCheckpoint({ sessionId });
    await operations.closeSession({ sessionId, createCheckpoint: false });

    const eventTypes = (await recorder.read()).map((event) => event.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "session_opened",
        "task_started",
        "progress_report_submitted",
        "checkpoint_created",
        "session_closed",
      ]),
    );
    const storedEvents = await recorder.read();
    expect(storedEvents[0]?.reasonCode).toBe("EMBEDDED_MCP");
    expect(
      storedEvents.every((event) => event.client === undefined && event.agent === undefined),
    ).toBe(true);
  });
});
