import path from "node:path";

import {
  commitCheckpoint,
  prepareCheckpoint,
} from "../../src/core/checkpoints/create-checkpoint.js";
import { AtomicTextFileWriter } from "../../src/core/filesystem/atomic-text-file-writer.js";
import type { CheckpointGitFacts } from "../../src/core/git/checkpoint-git-types.js";
import { commitAgentReport, prepareAgentReport } from "../../src/core/reports/apply-report.js";
import { commitTaskStart, prepareTaskStart } from "../../src/core/state/start-task.js";
import { createContinuityFixture, StubGitInspector } from "./continuity-fixture.js";

const initialCommit = "0123456789abcdef0123456789abcdef01234567";
const checkpointCommit = "abcdef0123456789abcdef0123456789abcdef01";

export function resumeGitFacts(overrides: Partial<CheckpointGitFacts> = {}): CheckpointGitFacts {
  return {
    branch: "feat/oauth",
    commit: checkpointCommit,
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
    recentCommits: [{ hash: checkpointCommit, subject: "Add callback route" }],
    ...overrides,
  };
}

export async function createResumeFixture(
  temporaryDirectories: string[],
  options: {
    readonly withReport?: boolean;
    readonly name?: string;
    readonly facts?: CheckpointGitFacts;
  } = {},
) {
  const fixture = await createContinuityFixture(temporaryDirectories, {
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  const inspector = new StubGitInspector(
    { branch: "main", commit: initialCommit, detached: false },
    true,
    options.facts ?? resumeGitFacts(),
  );
  const start = await prepareTaskStart(
    {
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: inspector,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    },
    {
      title: "Implement GitHub OAuth without changing email login",
      agent: "codex",
    },
  );
  if (start.status !== "ready") throw new Error("Expected resume fixture task start");
  await commitTaskStart(
    start,
    new AtomicTextFileWriter(fixture.fileSystem, () => ".resume-start.tmp"),
  );

  if (options.withReport !== false) {
    await submitResumeReport({ ...fixture, inspector }, "2026-07-20T14:00:00.000Z");
  }
  const checkpoint = await createResumeCheckpoint(
    { ...fixture, inspector },
    "2026-07-20T18:30:00.000Z",
    options.facts ?? resumeGitFacts(),
  );
  inspector.factReads.splice(0);
  inspector.ignoreReads.splice(0);
  inspector.checkpointReads.splice(0);
  return { ...fixture, inspector, checkpoint };
}

export async function submitResumeReport(
  fixture: Awaited<ReturnType<typeof createContinuityFixture>> & {
    readonly inspector: StubGitInspector;
  },
  timestamp: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const report = await prepareAgentReport(
    {
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: fixture.inspector,
      now: () => new Date(timestamp),
    },
    {
      json: JSON.stringify({
        agent: "claude",
        completed: ["Added callback route"],
        inProgress: ["Persisting session cookie"],
        decisions: [{ decision: "Reuse session table", reason: "Avoid migration" }],
        failedAttempts: [{ attempt: "SameSite=Strict", result: "Cookie was dropped" }],
        blockers: ["Callback test fails"],
        nextActions: ["Test SameSite=Lax"],
        validation: [
          { command: "pnpm test", status: "failed", summary: "One failure" },
          { command: "pnpm lint", status: "passed", summary: "No lint errors" },
        ],
        assumptions: ["HTTPS terminates at proxy"],
        ...overrides,
      }),
    },
  );
  if (report.status !== "ready") throw new Error("Expected resume fixture report");
  await commitAgentReport(
    report,
    new AtomicTextFileWriter(fixture.fileSystem, () => ".resume-report.tmp"),
  );
}

export async function createResumeCheckpoint(
  fixture: Awaited<ReturnType<typeof createContinuityFixture>> & {
    readonly inspector: StubGitInspector;
  },
  timestamp: string,
  facts: CheckpointGitFacts,
) {
  const inspector = new StubGitInspector(fixture.inspector.facts, true, facts);
  const plan = await prepareCheckpoint({
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector: inspector,
    now: () => new Date(timestamp),
  });
  if (plan.status !== "ready") throw new Error("Expected resume fixture checkpoint");
  const result = await commitCheckpoint(
    plan,
    fixture.fileSystem,
    new AtomicTextFileWriter(fixture.fileSystem, (name) => `.${name}.resume.tmp`),
  );
  if (result.status !== "success") throw new Error("Expected checkpoint commit");
  return plan.checkpoint;
}

export function checkpointPath(root: string, taskId: string, checkpointId: string): string {
  return path.join(root, ".briefonce", "state", "history", `${taskId}-${checkpointId}.md`);
}
