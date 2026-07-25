import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { StdinReader } from "../../src/cli/input/stdin-reader.js";
import { runCli } from "../../src/cli/run-cli.js";
import { parseCompletedTask } from "../../src/core/completion/parse-completed-task.js";
import { captureOutput } from "../helpers/capture-output.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];

class StringStdinReader implements StdinReader {
  constructor(private readonly value: string) {}
  readAll(): Promise<string> {
    return Promise.resolve(this.value);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function harness(stdin = "") {
  const fixture = await createContinuityFixture(temporaryDirectories, {
    name: "agentfold-cli-finish with spaces-",
  });
  const captured = captureOutput();
  const inspector = new StubGitInspector(undefined, true);
  let now = new Date("2026-07-21T01:00:00.000Z");
  const options = {
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector: inspector,
    stdinReader: new StringStdinReader(stdin),
    output: captured.output,
    now: () => now,
    version: "0.0.0-test",
  };
  expect(await runCli(["node", "agentfold", "start", "CLI task", "--yes"], options)).toBe(0);
  now = new Date("2026-07-21T02:00:00.000Z");
  return { ...fixture, captured, inspector, options };
}

describe("agentfold finish CLI", () => {
  it("previews by default and with --dry-run without writing", async () => {
    const fixture = await harness();
    const statePath = path.join(fixture.root, ".briefonce", "state", "current.md");
    const before = await fixture.fileSystem.readText(statePath);

    expect(await runCli(["node", "agentfold", "finish"], fixture.options)).toBe(0);
    expect(await runCli(["node", "agentfold", "finish", "--dry-run"], fixture.options)).toBe(0);
    await expect(fixture.fileSystem.readText(statePath)).resolves.toBe(before);
    await expect(
      fixture.fileSystem.exists(path.join(fixture.root, ".briefonce", "state", "history")),
    ).resolves.toBe(false);
    expect(fixture.captured.stdout()).toContain("--yes");
    expect(fixture.captured.stdout()).toContain("Dry run complete");
  });

  it("accepts structured stdin, uses --agent when input omits it, and applies only with --yes", async () => {
    const input = JSON.stringify({
      summary: "Completed the CLI task.",
      finalReport: {
        completed: ["Validated finish command"],
        validation: [{ command: "pnpm test", status: "passed", summary: "All passed" }],
      },
    });
    const fixture = await harness(input);

    const exitCode = await runCli(
      ["node", "agentfold", "finish", "--stdin", "--agent", "codex", "--yes"],
      fixture.options,
    );

    expect(exitCode).toBe(0);
    await expect(
      fixture.fileSystem.exists(path.join(fixture.root, ".briefonce", "state", "current.md")),
    ).resolves.toBe(false);
    const archive = path.join(
      fixture.root,
      ".briefonce",
      "state",
      "completed",
      "AF-20260721-001.md",
    );
    expect(parseCompletedTask(await fixture.fileSystem.readText(archive))).toMatchObject({
      finishingAgent: "codex",
      summary: "Completed the CLI task.",
      finalCheckpointId: "CP-001",
    });
    expect(fixture.captured.stdout()).toContain("Removed .briefonce/state/current.md");
  });

  it("returns safe errors for invalid JSON and a repeated finish", async () => {
    const invalid = await harness("{");
    expect(await runCli(["node", "agentfold", "finish", "--stdin", "--yes"], invalid.options)).toBe(
      2,
    );

    const fixture = await harness();
    expect(await runCli(["node", "agentfold", "finish", "--yes"], fixture.options)).toBe(0);
    expect(await runCli(["node", "agentfold", "finish", "--yes"], fixture.options)).toBe(5);
  });
});
