import { describe, expect, it } from "vitest";

import {
  CommandGitInspector,
  GitInspectionError,
  parseRecentCommits,
} from "../../src/core/git/git-inspector.js";
import type {
  ProcessResult,
  ProcessRunner,
  ProcessRunOptions,
} from "../../src/core/process/process-runner.js";

class RecordingProcessRunner implements ProcessRunner {
  readonly calls: {
    readonly command: string;
    readonly arguments: readonly string[];
    readonly options: ProcessRunOptions;
  }[] = [];

  constructor(private readonly results: ProcessResult[]) {}

  run(
    command: string,
    arguments_: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ command, arguments: arguments_, options });
    const result = this.results.shift();
    if (result === undefined) {
      return Promise.reject(new Error("No fake process result"));
    }
    return Promise.resolve(result);
  }
}

const success = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const failure = (exitCode = 1): ProcessResult => ({ exitCode, stdout: "", stderr: "" });

describe("CommandGitInspector", () => {
  it("reads a normal branch and current commit using argument arrays", async () => {
    const runner = new RecordingProcessRunner([
      success("feat/oauth\n"),
      success("0123456789abcdef0123456789abcdef01234567\n"),
    ]);
    const inspector = new CommandGitInspector(runner);

    await expect(inspector.readWorkingFacts("C:\\repo space")).resolves.toEqual({
      branch: "feat/oauth",
      commit: "0123456789abcdef0123456789abcdef01234567",
      detached: false,
    });
    expect(runner.calls).toEqual([
      {
        command: "git",
        arguments: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        options: { cwd: "C:\\repo space" },
      },
      {
        command: "git",
        arguments: ["rev-parse", "--verify", "--quiet", "HEAD"],
        options: { cwd: "C:\\repo space" },
      },
    ]);
  });

  it("supports detached HEAD and repositories with no commits", async () => {
    const detached = new CommandGitInspector(
      new RecordingProcessRunner([
        failure(),
        success("0123456789abcdef0123456789abcdef01234567\n"),
      ]),
    );
    await expect(detached.readWorkingFacts("repo")).resolves.toMatchObject({
      branch: "HEAD (detached)",
      detached: true,
    });

    const unborn = new CommandGitInspector(
      new RecordingProcessRunner([success("main\n"), failure()]),
    );
    await expect(unborn.readWorkingFacts("repo")).resolves.toEqual({
      branch: "main",
      commit: null,
      detached: false,
    });
  });

  it("checks only the requested Git-ignore path and performs no Git mutation", async () => {
    const runner = new RecordingProcessRunner([success()]);
    const inspector = new CommandGitInspector(runner);

    await expect(inspector.isPathIgnored("repo", ".briefonce/state/")).resolves.toBe(true);
    expect(runner.calls[0]?.arguments).toEqual([
      "check-ignore",
      "--quiet",
      "--",
      ".briefonce/state/",
    ]);
    const allArguments = runner.calls.flatMap((call) => call.arguments);
    for (const forbidden of ["commit", "branch", "add", "reset", "stash", "push", "remote"]) {
      expect(allArguments).not.toContain(forbidden);
    }
  });

  it("captures checkpoint status, numstat, and commits after the starting commit", async () => {
    const start = "0123456789abcdef0123456789abcdef01234567";
    const current = "abcdef0123456789abcdef0123456789abcdef01";
    const status = [
      `1 .M N... 100644 100644 100644 ${start} ${start} src/file.ts`,
      "? tests/new test.ts",
      "",
    ].join("\0");
    const runner = new RecordingProcessRunner([
      success("feat/oauth\n"),
      success(`${current}\n`),
      success(status),
      success(["3\t1\tsrc/file.ts", ""].join("\0")),
      success(""),
      success(),
      success(`${current}\0Add callback route\0`),
    ]);
    const inspector = new CommandGitInspector(runner);

    const result = await inspector.readCheckpointFacts("C:\\repo space", {
      startingCommit: start,
      startedAt: "2026-07-20T12:00:00.000Z",
    });

    expect(result.facts).toMatchObject({
      branch: "feat/oauth",
      commit: current,
      workingTree: "dirty",
      hasStagedChanges: false,
      hasUnstagedChanges: true,
      diffStatistics: {
        filesChanged: 1,
        insertions: 3,
        deletions: 1,
        binaryFiles: 0,
        untrackedFiles: 1,
      },
      recentCommits: [{ hash: current, subject: "Add callback route" }],
    });
    expect(runner.calls.map((call) => call.arguments)).toEqual([
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude).briefonce/state/**",
        ":(exclude).agentfold/state/**",
      ],
      [
        "diff",
        "--numstat",
        "-z",
        "--",
        ".",
        ":(exclude).briefonce/state/**",
        ":(exclude).agentfold/state/**",
      ],
      [
        "diff",
        "--cached",
        "--numstat",
        "-z",
        "--",
        ".",
        ":(exclude).briefonce/state/**",
        ":(exclude).agentfold/state/**",
      ],
      ["merge-base", "--is-ancestor", start, current],
      ["log", "--max-count=51", "--format=%H%x00%s%x00", `${start}..${current}`],
    ]);
  });

  it("uses a timestamp fallback for an unreachable or initially absent commit", async () => {
    const start = "0123456789abcdef0123456789abcdef01234567";
    const current = "abcdef0123456789abcdef0123456789abcdef01";
    const unreachableRunner = new RecordingProcessRunner([
      success("other\n"),
      success(current),
      success(),
      success(),
      success(),
      failure(1),
      success(),
    ]);
    const unreachable = await new CommandGitInspector(unreachableRunner).readCheckpointFacts(
      "repo",
      { startingCommit: start, startedAt: "2026-07-20T12:00:00.000Z" },
    );
    expect(unreachable.diagnostics).toContainEqual(expect.objectContaining({ code: "AFG001" }));
    expect(unreachableRunner.calls.at(-1)?.arguments).toContain("--since=2026-07-20T12:00:00.000Z");

    const unbornRunner = new RecordingProcessRunner([
      success("main\n"),
      success(current),
      success(),
      success(),
      success(),
      success(),
    ]);
    await new CommandGitInspector(unbornRunner).readCheckpointFacts("repo", {
      startingCommit: null,
      startedAt: "2026-07-20T12:00:00.000Z",
    });
    expect(unbornRunner.calls.some((call) => call.arguments[0] === "merge-base")).toBe(false);
    expect(unbornRunner.calls.at(-1)?.arguments).toContain("--since=2026-07-20T12:00:00.000Z");
  });

  it("returns no recent commits when HEAD is unchanged and caps large results", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const unchangedRunner = new RecordingProcessRunner([
      success("main\n"),
      success(commit),
      success(),
      success(),
      success(),
    ]);
    const unchanged = await new CommandGitInspector(unchangedRunner).readCheckpointFacts("repo", {
      startingCommit: commit,
      startedAt: "2026-07-20T12:00:00.000Z",
    });
    expect(unchanged.facts.recentCommits).toEqual([]);
    expect(unchangedRunner.calls).toHaveLength(5);

    const records = Array.from({ length: 51 }, (_, index) => {
      const hash = index.toString(16).padStart(40, "0");
      return `${hash}\0Subject ${index}\0`;
    }).join("");
    const cappedRunner = new RecordingProcessRunner([
      success("main\n"),
      success(commit),
      success(),
      success(),
      success(),
      success(records),
    ]);
    const capped = await new CommandGitInspector(cappedRunner).readCheckpointFacts("repo", {
      startingCommit: null,
      startedAt: "2026-07-20T12:00:00.000Z",
    });
    expect(capped.facts.recentCommits).toHaveLength(50);
    expect(capped.diagnostics).toContainEqual(expect.objectContaining({ code: "AFG002" }));
  });

  it("surfaces process failures without invoking mutation commands", async () => {
    const runner = new RecordingProcessRunner([
      success("main\n"),
      success("0123456789abcdef0123456789abcdef01234567"),
      failure(128),
      success(),
      success(),
    ]);
    await expect(
      new CommandGitInspector(runner).readCheckpointFacts("repo", {
        startingCommit: null,
        startedAt: "2026-07-20T12:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(GitInspectionError);
    const allArguments = runner.calls.flatMap((call) => call.arguments);
    for (const forbidden of ["commit", "branch", "add", "reset", "stash", "push", "remote"])
      expect(allArguments).not.toContain(forbidden);
  });

  it("parses hashes and subjects only, never commit bodies", () => {
    const first = "0123456789abcdef0123456789abcdef01234567";
    const second = "abcdef0123456789abcdef0123456789abcdef01";
    expect(parseRecentCommits(`${first}\0Subject one\0\n${second}\0Subject two\0`)).toEqual([
      { hash: first, subject: "Subject one" },
      { hash: second, subject: "Subject two" },
    ]);
  });
});
