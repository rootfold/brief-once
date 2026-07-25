import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../../src/core/config/parse-config.js";
import { serializeConfig } from "../../src/core/config/serialize-config.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import type {
  CheckpointGitFacts,
  CheckpointGitObservation,
  CheckpointGitRequest,
} from "../../src/core/git/checkpoint-git-types.js";
import type { GitInspector, GitWorkingFacts } from "../../src/core/git/git-inspector.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import { AtomicInitializationWriter } from "../../src/core/initialization/atomic-writer.js";
import {
  commitInitialization,
  prepareInitialization,
} from "../../src/core/initialization/initialize.js";

export interface ContinuityFixture {
  readonly root: string;
  readonly workingDirectory: string;
  readonly fileSystem: NodeFileSystem;
  readonly gitRepositoryLocator: FilesystemGitRepositoryLocator;
}

export class StubGitInspector implements GitInspector {
  readonly factReads: string[] = [];
  readonly ignoreReads: { readonly root: string; readonly path: string }[] = [];
  readonly checkpointReads: {
    readonly root: string;
    readonly request: CheckpointGitRequest;
  }[] = [];

  constructor(
    readonly facts: GitWorkingFacts = {
      branch: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      detached: false,
    },
    readonly ignored = false,
    readonly checkpointFacts: CheckpointGitFacts = {
      branch: facts.branch,
      commit: facts.commit,
      detached: facts.detached,
      workingTree: "clean",
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      changedPaths: {
        added: [],
        modified: [],
        deleted: [],
        renamed: [],
        copied: [],
        untracked: [],
        unmerged: [],
      },
      diffStatistics: {
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        binaryFiles: 0,
        untrackedFiles: 0,
      },
      recentCommits: [],
    },
  ) {}

  readWorkingFacts(repositoryRoot: string): Promise<GitWorkingFacts> {
    this.factReads.push(repositoryRoot);
    return Promise.resolve(this.facts);
  }

  isPathIgnored(repositoryRoot: string, repositoryRelativePath: string): Promise<boolean> {
    this.ignoreReads.push({ root: repositoryRoot, path: repositoryRelativePath });
    return Promise.resolve(this.ignored);
  }

  readCheckpointFacts(
    repositoryRoot: string,
    request: CheckpointGitRequest,
  ): Promise<CheckpointGitObservation> {
    this.checkpointReads.push({ root: repositoryRoot, request });
    return Promise.resolve({ facts: this.checkpointFacts, diagnostics: [] });
  }
}

export async function createContinuityFixture(
  temporaryDirectories: string[],
  options: {
    readonly name?: string;
    readonly visibility?: "local" | "tracked";
    readonly nestedWorkingDirectory?: string;
  } = {},
): Promise<ContinuityFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), options.name ?? "agentfold-continuity-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  const workingDirectory =
    options.nestedWorkingDirectory === undefined
      ? root
      : path.join(root, ...options.nestedWorkingDirectory.split("/"));
  await mkdir(workingDirectory, { recursive: true });
  const fileSystem = new NodeFileSystem(() => workingDirectory);
  const gitRepositoryLocator = new FilesystemGitRepositoryLocator(fileSystem);
  const plan = await prepareInitialization({
    fileSystem,
    gitRepositoryLocator,
    agentfoldVersion: "0.0.0-test",
    now: () => new Date("2026-07-20T12:00:00.000Z"),
  });
  if (plan.status !== "ready") {
    throw new Error("Expected continuity fixture initialization to be ready");
  }
  await commitInitialization(
    plan,
    new AtomicInitializationWriter(fileSystem, () => ".continuity-init"),
  );

  if (options.visibility === "tracked") {
    const configPath = path.join(root, ".briefonce", "config.yaml");
    const config = parseConfig({
      version: 1,
      project: { name: path.basename(root), summary: "" },
      runtime: { node: ">=20" },
      commands: {},
      state: { visibility: "tracked" },
      safety: { respect_gitignore: true, excluded_paths: [] },
      adapters: {},
    });
    await fileSystem.writeText(configPath, serializeConfig(config));
  }

  return { root, workingDirectory, fileSystem, gitRepositoryLocator };
}
