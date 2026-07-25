import type { ProcessRunner } from "../process/process-runner.js";
import type { Diagnostic } from "../diagnostics/diagnostic.js";
import type {
  CheckpointGitObservation,
  CheckpointGitRequest,
  RecentCommit,
} from "./checkpoint-git-types.js";
import { aggregateDiffStatistics, parseNumstat } from "./parse-numstat.js";
import { parsePorcelainV2 } from "./parse-porcelain-v2.js";

export interface GitWorkingFacts {
  readonly branch: string;
  readonly commit: string | null;
  readonly detached: boolean;
}

export interface GitInspector {
  readWorkingFacts(repositoryRoot: string): Promise<GitWorkingFacts>;
  isPathIgnored(repositoryRoot: string, repositoryRelativePath: string): Promise<boolean>;
  readCheckpointFacts(
    repositoryRoot: string,
    request: CheckpointGitRequest,
  ): Promise<CheckpointGitObservation>;
}

export class GitInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitInspectionError";
  }
}

export class CommandGitInspector implements GitInspector {
  constructor(private readonly processRunner: ProcessRunner) {}

  private async required(
    repositoryRoot: string,
    arguments_: readonly string[],
    operation: string,
  ): Promise<string> {
    const result = await this.processRunner.run("git", arguments_, { cwd: repositoryRoot });
    if (result.exitCode !== 0) {
      throw new GitInspectionError(`Git could not ${operation}.`);
    }
    return result.stdout;
  }

  async readWorkingFacts(repositoryRoot: string): Promise<GitWorkingFacts> {
    const [branchResult, commitResult] = await Promise.all([
      this.processRunner.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: repositoryRoot,
      }),
      this.processRunner.run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
        cwd: repositoryRoot,
      }),
    ]);

    if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1) {
      throw new GitInspectionError("Git could not determine the current branch.");
    }

    if (commitResult.exitCode !== 0 && commitResult.exitCode !== 1) {
      throw new GitInspectionError("Git could not determine the current HEAD commit.");
    }

    const detached = branchResult.exitCode === 1;
    const branch = detached ? "HEAD (detached)" : branchResult.stdout.trim();
    const commit = commitResult.exitCode === 0 ? commitResult.stdout.trim() : null;

    if (branch.length === 0 || (commit !== null && commit.length === 0)) {
      throw new GitInspectionError("Git returned incomplete branch or commit metadata.");
    }

    return { branch, commit, detached };
  }

  async isPathIgnored(repositoryRoot: string, repositoryRelativePath: string): Promise<boolean> {
    const result = await this.processRunner.run(
      "git",
      ["check-ignore", "--quiet", "--", repositoryRelativePath],
      { cwd: repositoryRoot },
    );

    if (result.exitCode === 0) {
      return true;
    }

    if (result.exitCode === 1) {
      return false;
    }

    throw new GitInspectionError("Git could not inspect ignore rules for active state.");
  }

  async readCheckpointFacts(
    repositoryRoot: string,
    request: CheckpointGitRequest,
  ): Promise<CheckpointGitObservation> {
    const workingFacts = await this.readWorkingFacts(repositoryRoot);
    const [statusOutput, unstagedNumstat, stagedNumstat] = await Promise.all([
      this.required(
        repositoryRoot,
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
        "read working-tree status",
      ),
      this.required(
        repositoryRoot,
        [
          "diff",
          "--numstat",
          "-z",
          "--",
          ".",
          ":(exclude).briefonce/state/**",
          ":(exclude).agentfold/state/**",
        ],
        "read unstaged diff statistics",
      ),
      this.required(
        repositoryRoot,
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
        "read staged diff statistics",
      ),
    ]);
    const status = parsePorcelainV2(statusOutput);
    const diffStatistics = aggregateDiffStatistics(
      status.changedPaths,
      parseNumstat(stagedNumstat),
      parseNumstat(unstagedNumstat),
    );
    const recent = await this.readRecentCommits(repositoryRoot, workingFacts.commit, request);

    return {
      facts: {
        ...workingFacts,
        workingTree: status.workingTree,
        hasStagedChanges: status.hasStagedChanges,
        hasUnstagedChanges: status.hasUnstagedChanges,
        changedPaths: status.changedPaths,
        diffStatistics,
        recentCommits: recent.commits,
      },
      diagnostics: recent.diagnostics,
    };
  }

  private async readRecentCommits(
    repositoryRoot: string,
    currentCommit: string | null,
    request: CheckpointGitRequest,
  ): Promise<{ readonly commits: readonly RecentCommit[]; readonly diagnostics: Diagnostic[] }> {
    if (currentCommit === null || currentCommit === request.startingCommit) {
      return { commits: [], diagnostics: [] };
    }

    const diagnostics: Diagnostic[] = [];
    const limit = request.recentCommitLimit ?? 50;
    let revisionArguments: readonly string[];

    if (request.startingCommit === null) {
      revisionArguments = [`--since=${request.startedAt}`, currentCommit];
    } else {
      const ancestor = await this.processRunner.run(
        "git",
        ["merge-base", "--is-ancestor", request.startingCommit, currentCommit],
        { cwd: repositoryRoot },
      );
      if (ancestor.exitCode === 0) {
        revisionArguments = [`${request.startingCommit}..${currentCommit}`];
      } else if (ancestor.exitCode === 1 || ancestor.exitCode === 128) {
        diagnostics.push({
          code: "AFG001",
          severity: "warning",
          message: "The task's starting commit is not reachable from the current HEAD.",
          suggestion: "Recent commits were bounded by the task start timestamp instead.",
        });
        revisionArguments = [`--since=${request.startedAt}`, currentCommit];
      } else {
        throw new GitInspectionError("Git could not compare the starting and current commits.");
      }
    }

    const output = await this.required(
      repositoryRoot,
      ["log", `--max-count=${limit + 1}`, "--format=%H%x00%s%x00", ...revisionArguments],
      "read recent commit subjects",
    );
    const commits = parseRecentCommits(output);
    if (commits.length > limit) {
      diagnostics.push({
        code: "AFG002",
        severity: "warning",
        message: `Recent commit metadata was limited to ${limit} entries.`,
        suggestion: "Only hashes and subjects are stored; older commits were omitted.",
      });
    }

    return { commits: commits.slice(0, limit), diagnostics };
  }
}

export function parseRecentCommits(source: string): readonly RecentCommit[] {
  const parts = source.split("\0");
  const commits: RecentCommit[] = [];

  for (let index = 0; index + 1 < parts.length; index += 2) {
    const hash = (parts[index] ?? "").replace(/^\r?\n/gu, "").trim();
    const subject = (parts[index + 1] ?? "").replace(/^\r?\n/gu, "").trim();
    if (hash.length === 0 && subject.length === 0) continue;
    if (!/^[0-9a-f]{7,64}$/iu.test(hash)) {
      throw new GitInspectionError("Git returned invalid recent commit metadata.");
    }
    commits.push({ hash, subject });
  }

  return commits;
}
