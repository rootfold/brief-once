import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import type { StdinReader } from "../../src/cli/input/stdin-reader.js";
import { loadActiveState } from "../../src/core/state/load-active-state.js";
import { captureOutput } from "../helpers/capture-output.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];
const now = () => new Date("2026-07-20T15:10:00.000Z");

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

describe("continuity CLI", () => {
  it.each([
    ["preview", []],
    ["dry run", ["--dry-run"]],
  ] as const)("supports a safe task %s that writes nothing", async (_name, extraArguments) => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const captured = captureOutput();

    const exitCode = await runCli(
      ["node", "agentfold", "start", "Implement OAuth", ...extraArguments],
      {
        ...fixture,
        gitInspector: new StubGitInspector(),
        stdinReader: new StringStdinReader(""),
        output: captured.output,
        now,
      },
    );

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toContain("AF-20260720-001");
    expect(captured.stdout()).toContain("No state was written");
    await expect(
      fixture.fileSystem.exists(path.join(fixture.root, ".briefonce", "state", "current.md")),
    ).resolves.toBe(false);
  });

  it("creates an active task with --yes and refuses a second task", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const captured = captureOutput();
    const options = {
      ...fixture,
      gitInspector: new StubGitInspector(),
      stdinReader: new StringStdinReader(""),
      output: captured.output,
      now,
    };

    const firstExit = await runCli(
      ["node", "agentfold", "start", "Implement OAuth", "--agent", "codex", "--yes"],
      options,
    );
    const secondExit = await runCli(
      ["node", "agentfold", "start", "Overwrite attempt", "--yes"],
      options,
    );

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(5);
    const loaded = await loadActiveState(fixture.fileSystem, fixture.root);
    expect(loaded.status).toBe("success");
    if (loaded.status !== "success") throw new Error("Expected active state");
    expect(loaded.state.title).toBe("Implement OAuth");
    expect(loaded.state.startingAgent).toBe("codex");
  });

  it("accepts a structured report through stdin and uses CLI agent fallback", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const gitInspector = new StubGitInspector();
    const startOutput = captureOutput();
    await runCli(["node", "agentfold", "start", "Implement OAuth", "--yes"], {
      ...fixture,
      gitInspector,
      stdinReader: new StringStdinReader(""),
      output: startOutput.output,
      now,
    });
    const reportOutput = captureOutput();
    const report = JSON.stringify({
      completed: ["Added callback route"],
      decisions: [{ decision: "Reuse session table", reason: "Avoid migration" }],
      nextActions: ["Fix callback test"],
    });

    const exitCode = await runCli(["node", "agentfold", "report", "--stdin", "--agent", "codex"], {
      ...fixture,
      gitInspector,
      stdinReader: new StringStdinReader(report),
      output: reportOutput.output,
      now: () => new Date("2026-07-20T16:00:00.000Z"),
    });

    expect(exitCode).toBe(0);
    expect(reportOutput.stdout()).toContain("Report accepted from codex");
    expect(reportOutput.stdout()).toContain("Added 1 completed item");
    const loaded = await loadActiveState(fixture.fileSystem, fixture.root);
    if (loaded.status !== "success") throw new Error("Expected active state");
    expect(loaded.state.lastAgent).toBe("codex");
    expect(loaded.state.completed).toEqual(["Added callback route"]);
  });

  it("returns invalid-input exit codes for empty titles and invalid stdin JSON", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const baseOptions = {
      ...fixture,
      gitInspector: new StubGitInspector(),
      output: captureOutput().output,
      now,
    };

    const titleExit = await runCli(["node", "agentfold", "start", "   ", "--yes"], {
      ...baseOptions,
      stdinReader: new StringStdinReader(""),
    });
    await runCli(["node", "agentfold", "start", "Valid", "--yes"], {
      ...baseOptions,
      stdinReader: new StringStdinReader(""),
    });
    const jsonExit = await runCli(["node", "agentfold", "report", "--stdin"], {
      ...baseOptions,
      stdinReader: new StringStdinReader("{"),
    });

    expect(titleExit).toBe(2);
    expect(jsonExit).toBe(2);
  });

  it("dry-runs and then persists a checkpoint by default without creating duplicates", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const gitInspector = new StubGitInspector(undefined, true);
    const startOutput = captureOutput();
    await runCli(["node", "agentfold", "start", "Implement OAuth", "--yes"], {
      ...fixture,
      gitInspector,
      stdinReader: new StringStdinReader(""),
      output: startOutput.output,
      now,
    });
    const statePath = path.join(fixture.root, ".briefonce", "state", "current.md");
    const stateBefore = await fixture.fileSystem.readText(statePath);
    const dryOutput = captureOutput();
    const dryExit = await runCli(["node", "agentfold", "checkpoint", "--dry-run"], {
      ...fixture,
      gitInspector,
      stdinReader: new StringStdinReader(""),
      output: dryOutput.output,
      now: () => new Date("2026-07-20T16:00:00.000Z"),
    });
    expect(dryExit).toBe(0);
    expect(dryOutput.stdout()).toContain("Dry run complete");
    await expect(fixture.fileSystem.readText(statePath)).resolves.toBe(stateBefore);

    const checkpointOutput = captureOutput();
    const checkpointOptions = {
      ...fixture,
      gitInspector,
      stdinReader: new StringStdinReader(""),
      output: checkpointOutput.output,
      now: () => new Date("2026-07-20T16:00:00.000Z"),
    };
    const checkpointExit = await runCli(
      ["node", "agentfold", "checkpoint", "--agent", "codex"],
      checkpointOptions,
    );
    expect(checkpointExit).toBe(0);
    expect(checkpointOutput.stdout()).toContain("Checkpoint: CP-001");
    expect(checkpointOutput.stdout()).toContain("Created .briefonce/state/history/");

    const duplicateOutput = captureOutput();
    const duplicateExit = await runCli(["node", "agentfold", "checkpoint"], {
      ...checkpointOptions,
      output: duplicateOutput.output,
    });
    expect(duplicateExit).toBe(0);
    expect(duplicateOutput.stdout()).toContain("No meaningful Git or semantic state changed");
    await expect(
      fixture.fileSystem.listDirectory(path.join(fixture.root, ".briefonce", "state", "history")),
    ).resolves.toHaveLength(1);
  });
});
