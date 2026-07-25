import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { StdinReader } from "../../src/cli/input/stdin-reader.js";
import { runCli } from "../../src/cli/run-cli.js";
import { serializeCheckpoint } from "../../src/core/checkpoints/serialize-checkpoint.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { captureOutput } from "../helpers/capture-output.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";
import {
  checkpointPath,
  createResumeCheckpoint,
  createResumeFixture,
  resumeGitFacts,
} from "../helpers/resume-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class EmptyStdinReader implements StdinReader {
  readAll(): Promise<string> {
    return Promise.resolve("");
  }
}

class StringStdinReader implements StdinReader {
  constructor(private readonly content: string) {}

  readAll(): Promise<string> {
    return Promise.resolve(this.content);
  }
}

function options(
  fixture: Awaited<ReturnType<typeof createResumeFixture>>,
  captured: ReturnType<typeof captureOutput>,
  fileSystem = fixture.fileSystem,
) {
  return {
    fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector: fixture.inspector,
    stdinReader: new EmptyStdinReader(),
    output: captured.output,
  };
}

describe("resume CLI stdout", () => {
  it("completes initialized start-report-checkpoint-resume continuity end to end", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold end to end spaces ",
    });
    const inspector = new StubGitInspector(undefined, true, resumeGitFacts());
    const base = {
      ...fixture,
      gitInspector: inspector,
      output: captureOutput().output,
    };
    expect(
      await runCli(["node", "agentfold", "start", "Implement OAuth", "--yes"], {
        ...base,
        stdinReader: new EmptyStdinReader(),
        now: () => new Date("2026-07-20T12:00:00.000Z"),
      }),
    ).toBe(0);
    expect(
      await runCli(["node", "agentfold", "report", "--stdin"], {
        ...base,
        stdinReader: new StringStdinReader(
          JSON.stringify({
            agent: "codex",
            completed: ["Added callback route"],
            inProgress: ["Persisting session cookie"],
            decisions: [{ decision: "Reuse session table", reason: "Avoid migration" }],
            failedAttempts: [{ attempt: "Strict cookie", result: "Redirect dropped it" }],
            blockers: ["Callback test fails"],
            validation: [{ command: "pnpm test", status: "failed", summary: "One failure" }],
            nextActions: ["Test a Lax cookie"],
          }),
        ),
        now: () => new Date("2026-07-20T14:00:00.000Z"),
      }),
    ).toBe(0);
    expect(
      await runCli(["node", "agentfold", "checkpoint"], {
        ...base,
        stdinReader: new EmptyStdinReader(),
        now: () => new Date("2026-07-20T18:30:00.000Z"),
      }),
    ).toBe(0);
    inspector.factReads.splice(0);
    inspector.checkpointReads.splice(0);
    inspector.ignoreReads.splice(0);
    const resumeOutput = captureOutput();

    const exitCode = await runCli(["node", "agentfold", "resume"], {
      ...base,
      stdinReader: new EmptyStdinReader(),
      output: resumeOutput.output,
    });

    expect(exitCode).toBe(0);
    for (const expected of [
      "Implement OAuth",
      "Added callback route",
      "Persisting session cookie",
      "Reuse session table",
      "Strict cookie",
      "Callback test fails",
      "pnpm test",
      "src/auth/github.ts",
      "Test a Lax cookie",
    ]) {
      expect(resumeOutput.stdout()).toContain(expected);
    }
    expect(resumeOutput.stdout()).toContain("## Agent-reported conclusions");
    expect(resumeOutput.stdout()).toContain("## Automatically observed Git facts");
    expect(inspector.factReads).toEqual([]);
    expect(inspector.checkpointReads).toEqual([]);
    expect(inspector.ignoreReads).toEqual([]);
  });

  it("prints pure Markdown by default and leaves state and history byte-for-byte unchanged", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const captured = captureOutput();
    const statePath = path.join(fixture.root, ".briefonce", "state", "current.md");
    const historyPath = checkpointPath(fixture.root, fixture.checkpoint.taskId, "CP-001");
    const stateBefore = await fixture.fileSystem.readText(statePath);
    const historyBefore = await fixture.fileSystem.readText(historyPath);

    const exitCode = await runCli(["node", "agentfold", "resume"], options(fixture, captured));

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toMatch(/^# BriefOnce continuation packet\n/u);
    expect(captured.stdout()).not.toContain("AgentFold resume\n");
    expect(captured.stdout()).toContain("## Agent-reported conclusions");
    expect(captured.stdout()).toContain("## Automatically observed Git facts");
    expect(captured.stderr()).toBe("");
    expect(fixture.inspector.factReads).toEqual([]);
    expect(fixture.inspector.checkpointReads).toEqual([]);
    await expect(fixture.fileSystem.readText(statePath)).resolves.toBe(stateBefore);
    await expect(fixture.fileSystem.readText(historyPath)).resolves.toBe(historyBefore);
  });

  it("supports explicit Markdown and machine-parseable JSON without diagnostics on stdout", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const markdown = captureOutput();
    const markdownExit = await runCli(
      ["node", "agentfold", "resume", "--format", "markdown"],
      options(fixture, markdown),
    );
    expect(markdownExit).toBe(0);
    expect(markdown.stdout()).toMatch(/^# BriefOnce/u);

    const json = captureOutput();
    const jsonExit = await runCli(
      ["node", "agentfold", "resume", "--format", "json"],
      options(fixture, json),
    );
    expect(jsonExit).toBe(0);
    const parsed = JSON.parse(json.stdout()) as {
      task: { checkpointId: string };
      semanticState: { completed: string[] };
    };
    expect(parsed.task.checkpointId).toBe("CP-001");
    expect(parsed.semanticState.completed).toEqual(["Added callback route"]);
    expect(json.stdout()).not.toContain("AFR");
    expect(json.stderr()).toBe("");
  });

  it.each(["codex", "antigravity", "claude", "gemini", "generic"])(
    "supports the bounded %s target hint",
    async (target) => {
      const fixture = await createResumeFixture(temporaryDirectories);
      const captured = captureOutput();
      const exitCode = await runCli(
        ["node", "agentfold", "resume", "--for", target, "--format", "json"],
        options(fixture, captured),
      );

      expect(exitCode).toBe(0);
      const packet = JSON.parse(captured.stdout()) as {
        target: { id: string; nativeInstructionFile?: string };
      };
      expect(packet.target.id).toBe(target);
      expect(packet.target.nativeInstructionFile).toBeUndefined();
    },
  );

  it("uses the generic repository-instruction prompt when a target file is absent", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const captured = captureOutput();

    const exitCode = await runCli(
      ["node", "agentfold", "resume", "--for", "codex"],
      options(fixture, captured),
    );

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toContain(
      "Inspect the repository instructions before changing code.",
    );
    expect(captured.stdout()).not.toContain("Read `AGENTS.md`");
  });

  it.each([
    ["codex", "AGENTS.md"],
    ["claude", "CLAUDE.md"],
    ["antigravity", "GEMINI.md"],
    ["gemini", "GEMINI.md"],
  ] as const)("suggests existing in-repository instructions for %s", async (target, fileName) => {
    const fixture = await createResumeFixture(temporaryDirectories);
    await fixture.fileSystem.writeText(path.join(fixture.root, fileName), "# Existing\n");
    const captured = captureOutput();

    const exitCode = await runCli(
      ["node", "agentfold", "resume", "--for", target],
      options(fixture, captured),
    );

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toContain(`Read \`${fileName}\` before changing code.`);
    await expect(fixture.fileSystem.readText(path.join(fixture.root, fileName))).resolves.toBe(
      "# Existing\n",
    );
  });

  it("rejects an unknown target with exit 2 and keeps stdout empty", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const captured = captureOutput();

    const exitCode = await runCli(
      ["node", "agentfold", "resume", "--for", "unknown"],
      options(fixture, captured),
    );

    expect(exitCode).toBe(2);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("AFR023");
  });

  it("keeps JSON parseable while reused-semantic diagnostics go to stderr", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const changedFacts = resumeGitFacts({
      commit: "1111111111111111111111111111111111111111",
      recentCommits: [
        { hash: "1111111111111111111111111111111111111111", subject: "Git-only follow-up" },
      ],
    });
    await createResumeCheckpoint(fixture, "2026-07-20T20:00:00.000Z", changedFacts);
    const captured = captureOutput();

    const exitCode = await runCli(
      ["node", "agentfold", "resume", "--format", "json"],
      options(fixture, captured),
    );

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(captured.stdout())).not.toThrow();
    expect(captured.stderr()).toContain("AFR014");
    expect(captured.stdout()).not.toContain("AFR014");
  });

  it("supports historical selection through the CLI", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const changedFacts = resumeGitFacts({
      commit: "2222222222222222222222222222222222222222",
      recentCommits: [
        { hash: "2222222222222222222222222222222222222222", subject: "Later commit" },
      ],
    });
    await createResumeCheckpoint(fixture, "2026-07-20T20:00:00.000Z", changedFacts);
    const captured = captureOutput();

    const exitCode = await runCli(
      ["node", "agentfold", "resume", "--checkpoint", "CP-001"],
      options(fixture, captured),
    );

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toContain("historical checkpoint");
    expect(captured.stderr()).toContain("AFR013");
  });
});

describe("resume CLI failure and output behavior", () => {
  it("rejects missing active state and missing checkpoint history with focused exit 6 diagnostics", async () => {
    const empty = await createContinuityFixture(temporaryDirectories);
    const emptyOutput = captureOutput();
    const emptyExit = await runCli(["node", "agentfold", "resume"], {
      ...empty,
      gitInspector: new StubGitInspector(),
      stdinReader: new EmptyStdinReader(),
      output: emptyOutput.output,
    });
    expect(emptyExit).toBe(6);
    expect(emptyOutput.stderr()).toContain("No active task exists");

    const activeWithoutCheckpoint = await createContinuityFixture(temporaryDirectories);
    const startOutput = captureOutput();
    await runCli(["node", "agentfold", "start", "Uncheckpointed task", "--yes"], {
      ...activeWithoutCheckpoint,
      gitInspector: new StubGitInspector(),
      stdinReader: new EmptyStdinReader(),
      output: startOutput.output,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    });
    const noHistoryOutput = captureOutput();
    const noHistoryExit = await runCli(["node", "agentfold", "resume"], {
      ...activeWithoutCheckpoint,
      gitInspector: new StubGitInspector(),
      stdinReader: new EmptyStdinReader(),
      output: noHistoryOutput.output,
    });
    expect(noHistoryExit).toBe(6);
    expect(noHistoryOutput.stderr()).toContain("Run b1 checkpoint");

    const missing = await createResumeFixture(temporaryDirectories);
    await missing.fileSystem.remove(
      checkpointPath(missing.root, missing.checkpoint.taskId, "CP-001"),
    );
    const missingOutput = captureOutput();
    const missingExit = await runCli(
      ["node", "agentfold", "resume"],
      options(missing, missingOutput),
    );
    expect(missingExit).toBe(6);
    expect(missingOutput.stderr()).toContain("AFR005");
  });

  it("rejects corrupt checkpoints without emitting packet data", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    await fixture.fileSystem.writeText(
      checkpointPath(fixture.root, fixture.checkpoint.taskId, "CP-001"),
      "not a checkpoint\n",
    );
    const captured = captureOutput();

    const exitCode = await runCli(["node", "agentfold", "resume"], options(fixture, captured));

    expect(exitCode).toBe(2);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("AFR010");
  });

  it("atomically creates parent directories, prints success, and never overwrites", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const statePath = path.join(fixture.root, ".briefonce", "state", "current.md");
    const historyPath = checkpointPath(fixture.root, fixture.checkpoint.taskId, "CP-001");
    const stateBefore = await fixture.fileSystem.readText(statePath);
    const historyBefore = await fixture.fileSystem.readText(historyPath);
    const first = captureOutput();
    const outputPath = path.join(fixture.root, "exports", "handoff.md");

    const firstExit = await runCli(
      ["node", "agentfold", "resume", "--output", "exports/handoff.md"],
      options(fixture, first),
    );
    expect(firstExit).toBe(0);
    expect(first.stdout()).toContain("[AFR022]");
    expect(first.stdout()).toContain("exports/handoff.md");
    expect((await fixture.fileSystem.readText(outputPath)).endsWith("\n")).toBe(true);

    const beforeConflict = await fixture.fileSystem.readText(outputPath);
    const conflict = captureOutput();
    const conflictExit = await runCli(
      ["node", "agentfold", "resume", "--output", "exports/handoff.md"],
      options(fixture, conflict),
    );
    expect(conflictExit).toBe(5);
    expect(conflict.stdout()).toBe("");
    expect(conflict.stderr()).toContain("AFR021");
    await expect(fixture.fileSystem.readText(outputPath)).resolves.toBe(beforeConflict);
    await expect(fixture.fileSystem.readText(statePath)).resolves.toBe(stateBefore);
    await expect(fixture.fileSystem.readText(historyPath)).resolves.toBe(historyBefore);
  });

  it("warns about extension mismatches without changing the requested name", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const captured = captureOutput();

    const exitCode = await runCli(
      ["node", "agentfold", "resume", "--format", "json", "--output", "handoff.txt"],
      options(fixture, captured),
    );

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toContain("[AFR022]");
    expect(captured.stdout()).toContain("handoff.txt");
    expect(captured.stderr()).toContain("AFR019");
    const content = await fixture.fileSystem.readText(path.join(fixture.root, "handoff.txt"));
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it.each(["../handoff.md", "C:\\outside\\handoff.md"])(
    "rejects unsafe output path %s",
    async (requested) => {
      const fixture = await createResumeFixture(temporaryDirectories);
      const captured = captureOutput();
      const exitCode = await runCli(
        ["node", "agentfold", "resume", "--output", requested],
        options(fixture, captured),
      );

      expect(exitCode).toBe(2);
      expect(captured.stdout()).toBe("");
      expect(captured.stderr()).toContain("AFR020");
    },
  );

  it("leaves no partial file when an atomic output write fails", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    class FailingOutputFileSystem extends NodeFileSystem {
      override writeTextAndFlush(destination: string): Promise<void> {
        return destination.includes("handoff.md")
          ? Promise.reject(new Error("simulated output failure"))
          : super.writeTextAndFlush(destination, "");
      }
    }
    const fileSystem = new FailingOutputFileSystem(() => fixture.root);
    const captured = captureOutput();

    const exitCode = await runCli(
      ["node", "agentfold", "resume", "--output", "exports/handoff.md"],
      options(fixture, captured, fileSystem),
    );

    expect(exitCode).toBe(1);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("AFR018");
    await expect(fileSystem.exists(path.join(fixture.root, "exports", "handoff.md"))).resolves.toBe(
      false,
    );
    await expect(fileSystem.listDirectory(path.join(fixture.root, "exports"))).resolves.toEqual([]);
  });

  it("never prints a secret-like value from an unsafe checkpoint", async () => {
    const fixture = await createResumeFixture(temporaryDirectories);
    const secret = "fake-secret-value-123456";
    const unsafe = {
      ...fixture.checkpoint,
      reportedState: {
        ...fixture.checkpoint.reportedState,
        nextActions: [`Use token=${secret}`],
      },
    };
    await fixture.fileSystem.writeText(
      checkpointPath(fixture.root, fixture.checkpoint.taskId, "CP-001"),
      serializeCheckpoint(unsafe),
    );
    const captured = captureOutput();

    const exitCode = await runCli(["node", "agentfold", "resume"], options(fixture, captured));

    expect(exitCode).toBe(4);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("AFR017");
    expect(captured.stderr()).not.toContain(secret);
  });
});
