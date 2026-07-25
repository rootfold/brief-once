import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/core/config/load-config.js";
import type {
  FileSystem,
  FileSystemEntryType,
  RemoveOptions,
} from "../../src/core/filesystem/filesystem.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import { AtomicInitializationWriter } from "../../src/core/initialization/atomic-writer.js";
import {
  commitInitialization,
  prepareInitialization,
  type PrepareInitializationDependencies,
  type ReadyInitializationPlan,
} from "../../src/core/initialization/initialize.js";
import { initializationFilePaths, portablePath } from "../../src/core/initialization/paths.js";
import { sha256 } from "../../src/core/initialization/manifest.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function repositoryFixture(name = "agentfold-init-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".git"));
  return root;
}

function dependencies(root: string, workingDirectory = root): PrepareInitializationDependencies {
  const fileSystem = new NodeFileSystem(() => workingDirectory);
  return {
    fileSystem,
    gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
    agentfoldVersion: "0.0.0-test",
    now: () => new Date("2026-07-20T12:00:00.000Z"),
  };
}

function readyPlan(
  plan: Awaited<ReturnType<typeof prepareInitialization>>,
): ReadyInitializationPlan {
  expect(plan.status).toBe("ready");
  if (plan.status !== "ready") {
    throw new Error("Expected a ready initialization plan");
  }
  return plan;
}

class FailingWriteFileSystem implements FileSystem {
  constructor(
    private readonly delegate: FileSystem,
    private readonly failingSuffix: string,
  ) {}

  exists(path_: string): Promise<boolean> {
    return this.delegate.exists(path_);
  }

  entryType(path_: string): Promise<FileSystemEntryType | undefined> {
    return this.delegate.entryType(path_);
  }

  isSymbolicLink(path_: string): Promise<boolean> {
    return this.delegate.isSymbolicLink?.(path_) ?? Promise.resolve(false);
  }

  listDirectory(path_: string): Promise<readonly string[]> {
    return this.delegate.listDirectory(path_);
  }

  realPath(path_: string): Promise<string> {
    return this.delegate.realPath(path_);
  }

  readText(path_: string): Promise<string> {
    return this.delegate.readText(path_);
  }

  readBytes(path_: string): Promise<Uint8Array> {
    return this.delegate.readBytes(path_);
  }

  writeText(path_: string, content: string): Promise<void> {
    if (path_.endsWith(this.failingSuffix)) {
      return Promise.reject(new Error("Simulated write failure"));
    }
    return this.delegate.writeText(path_, content);
  }

  writeTextAndFlush(path_: string, content: string): Promise<void> {
    if (path_.endsWith(this.failingSuffix)) {
      return Promise.reject(new Error("Simulated write failure"));
    }
    return this.delegate.writeTextAndFlush(path_, content);
  }

  writeBytesAndFlush(path_: string, content: Uint8Array): Promise<void> {
    if (path_.endsWith(this.failingSuffix)) {
      return Promise.reject(new Error("Simulated write failure"));
    }
    return this.delegate.writeBytesAndFlush(path_, content);
  }

  ensureDirectory(path_: string): Promise<void> {
    return this.delegate.ensureDirectory(path_);
  }

  link(source: string, destination: string): Promise<void> {
    return this.delegate.link(source, destination);
  }

  rename(source: string, destination: string): Promise<void> {
    return this.delegate.rename(source, destination);
  }

  remove(path_: string, options?: RemoveOptions): Promise<void> {
    return this.delegate.remove(path_, options);
  }

  currentWorkingDirectory(): string {
    return this.delegate.currentWorkingDirectory();
  }
}

describe("safe AgentFold initialization", () => {
  it("normalizes Windows-style paths for portable metadata", () => {
    expect(portablePath(".briefonce\\context\\project.md")).toBe(".briefonce/context/project.md");
  });

  it("prepares initialization from a nested directory with spaces", async () => {
    const root = await repositoryFixture("agentfold init spaces ");
    const nested = path.join(root, "packages", "example app");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "pnpm-lock.yaml"), "", "utf8");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
      "utf8",
    );

    const plan = readyPlan(await prepareInitialization(dependencies(root, nested)));

    expect(plan.repositoryRoot).toBe(root);
    expect(plan.metadata.packageManager).toBe("pnpm");
    expect(plan.metadata.commands).toMatchObject({ install: "pnpm install", test: "pnpm test" });
  });

  it("refuses initialization outside a Git repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentfold-outside-git-"));
    temporaryDirectories.push(root);

    const plan = await prepareInitialization(dependencies(root));

    expect(plan.status).toBe("not-git");
    expect(plan.exitCode).toBe(6);
    await expect(
      new NodeFileSystem(() => root).exists(path.join(root, ".briefonce")),
    ).resolves.toBe(false);
  });

  it("creates valid YAML, templates, portable manifest hashes, and preserves AGENTS.md", async () => {
    const root = await repositoryFixture();
    const fileSystem = new NodeFileSystem(() => root);
    const agentsPath = path.join(root, "AGENTS.md");
    await writeFile(agentsPath, "# Existing instructions\n", "utf8");
    await writeFile(path.join(root, "pnpm-lock.yaml"), "", "utf8");
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "tests"));
    await mkdir(path.join(root, "docs"));
    await mkdir(path.join(root, "dist"));

    const plan = readyPlan(await prepareInitialization(dependencies(root)));
    await commitInitialization(
      plan,
      new AtomicInitializationWriter(fileSystem, () => ".init-test"),
    );

    for (const relativePath of initializationFilePaths) {
      await expect(
        fileSystem.exists(path.join(root, ".briefonce", ...relativePath.split("/"))),
      ).resolves.toBe(true);
    }

    const config = await loadConfig(fileSystem, path.join(root, ".briefonce", "config.yaml"));
    expect(config.project.name).toBe(path.basename(root));
    expect(config.package_manager).toBe("pnpm");
    expect(config.paths).toEqual({
      source: ["src"],
      tests: ["tests"],
      documentation: ["docs"],
      generated: ["dist"],
    });
    expect(await fileSystem.readText(agentsPath)).toBe("# Existing instructions\n");
    expect(
      await fileSystem.readText(path.join(root, ".briefonce", "context", "project.md")),
    ).toContain("## Detected stack");

    const manifestInput: unknown = JSON.parse(
      await fileSystem.readText(path.join(root, ".briefonce", "manifest.json")),
    );
    expect(manifestInput).toMatchObject({
      schemaVersion: 1,
      agentfoldVersion: "0.0.0-test",
      initializedAt: "2026-07-20T12:00:00.000Z",
      repositoryRoot: ".",
    });
    const manifest = manifestInput as {
      readonly generatedFiles: readonly string[];
      readonly hashes: Readonly<Record<string, string>>;
    };
    for (const generatedFile of manifest.generatedFiles) {
      expect(generatedFile).not.toContain("\\");
      const content = await fileSystem.readText(path.join(root, ...generatedFile.split("/")));
      expect(manifest.hashes[generatedFile]).toBe(sha256(content));
    }

    const secondPlan = await prepareInitialization(dependencies(root));
    expect(secondPlan.status).toBe("already-initialized");
    expect(secondPlan.exitCode).toBe(0);
  });

  it("does not invent path groups when no known directories exist", async () => {
    const root = await repositoryFixture();
    const plan = readyPlan(await prepareInitialization(dependencies(root)));
    const configFile = plan.files.find((file) => file.relativePath === "config.yaml");

    expect(configFile).toBeDefined();
    expect(configFile?.content).not.toContain("\npaths:\n");
  });

  it("reports a partial installation as a conflict", async () => {
    const root = await repositoryFixture();
    const context = path.join(root, ".briefonce", "context");
    await mkdir(context, { recursive: true });
    await writeFile(path.join(context, "project.md"), "# Partial\n", "utf8");

    const plan = await prepareInitialization(dependencies(root));

    expect(plan.status).toBe("conflict");
    expect(plan.exitCode).toBe(5);
    expect(plan.inspection?.presentFiles).toEqual([".briefonce/context/project.md"]);
    expect(plan.inspection?.missingFiles).toContain(".briefonce/config.yaml");
  });

  it("treats an existing config as initialized and never rewrites it", async () => {
    const root = await repositoryFixture();
    const agentFold = path.join(root, ".briefonce");
    const configPath = path.join(agentFold, "config.yaml");
    const content = "# User-owned existing configuration\nversion: 1\n";
    await mkdir(agentFold);
    await writeFile(configPath, content, "utf8");

    const plan = await prepareInitialization(dependencies(root));

    expect(plan.status).toBe("already-initialized");
    expect(plan.exitCode).toBe(0);
    expect(plan.inspection?.presentFiles).toEqual([".briefonce/config.yaml"]);
    expect(plan.inspection?.missingFiles).toContain(".briefonce/manifest.json");
    await expect(new NodeFileSystem(() => root).readText(configPath)).resolves.toBe(content);
  });

  it("removes the staging directory after a simulated atomic-write failure", async () => {
    const root = await repositoryFixture();
    const baseFileSystem = new NodeFileSystem(() => root);
    const plan = readyPlan(await prepareInitialization(dependencies(root)));
    const failingFileSystem = new FailingWriteFileSystem(baseFileSystem, "commands.md");
    const writer = new AtomicInitializationWriter(failingFileSystem, () => ".briefonce.init-test");

    await expect(commitInitialization(plan, writer)).rejects.toThrow("Simulated write failure");
    await expect(baseFileSystem.exists(path.join(root, ".briefonce"))).resolves.toBe(false);
    await expect(baseFileSystem.exists(path.join(root, ".briefonce.init-test"))).resolves.toBe(
      false,
    );
  });
});
