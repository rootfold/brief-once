import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/cli/commands/doctor.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import { AtomicInitializationWriter } from "../../src/core/initialization/atomic-writer.js";
import {
  commitInitialization,
  prepareInitialization,
} from "../../src/core/initialization/initialize.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  readonly root: string;
  readonly fileSystem: NodeFileSystem;
  readonly gitRepositoryLocator: FilesystemGitRepositoryLocator;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentfold-doctor-state-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  const fileSystem = new NodeFileSystem(() => root);
  return {
    root,
    fileSystem,
    gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
  };
}

async function initializeFixture(testFixture: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const plan = await prepareInitialization({
    ...testFixture,
    agentfoldVersion: "0.0.0-test",
    now: () => new Date("2026-07-20T12:00:00.000Z"),
  });
  if (plan.status !== "ready") {
    throw new Error("Expected fixture initialization to be ready");
  }
  await commitInitialization(
    plan,
    new AtomicInitializationWriter(testFixture.fileSystem, () => ".doctor-init"),
  );
}

describe("doctor installation checks", () => {
  it("recognizes a valid initialized project", async () => {
    const testFixture = await fixture();
    await initializeFixture(testFixture);

    const result = await runDoctor(testFixture);

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "AFD004",
        severity: "success",
        message: expect.stringContaining("project context is valid"),
      }),
    );
  });

  it("reports missing canonical context files through the canonical loader", async () => {
    const testFixture = await fixture();
    await initializeFixture(testFixture);
    await rm(path.join(testFixture.root, ".agentfold", "context", "architecture.md"));

    const result = await runDoctor(testFixture);

    expect(result.exitCode).toBe(1);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC005", severity: "error" }),
    );
  });

  it("reports empty context and missing configured paths as non-failing warnings", async () => {
    const testFixture = await fixture();
    await initializeFixture(testFixture);
    await writeFile(
      path.join(testFixture.root, ".agentfold", "context", "commands.md"),
      "  \r\n",
      "utf8",
    );
    const configPath = path.join(testFixture.root, ".agentfold", "config.yaml");
    const config = await testFixture.fileSystem.readText(configPath);
    await writeFile(
      configPath,
      config.replace("state:\n", "paths:\n  source:\n    - missing-source\nstate:\n"),
      "utf8",
    );

    const result = await runDoctor(testFixture);

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC006", severity: "warning" }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC008", severity: "warning" }),
    );
  });

  it("uses invalid-configuration exit code for unsafe configured traversal", async () => {
    const testFixture = await fixture();
    await initializeFixture(testFixture);
    const configPath = path.join(testFixture.root, ".agentfold", "config.yaml");
    const config = await testFixture.fileSystem.readText(configPath);
    await writeFile(
      configPath,
      config.replace("state:\n", "paths:\n  source:\n    - ../secrets\nstate:\n"),
      "utf8",
    );

    const result = await runDoctor(testFixture);

    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC007", severity: "error" }),
    );
  });

  it("reports an invalid configuration with exit code 2", async () => {
    const testFixture = await fixture();
    await mkdir(path.join(testFixture.root, ".agentfold"));
    await writeFile(
      path.join(testFixture.root, ".agentfold", "config.yaml"),
      "version: 99\n",
      "utf8",
    );

    const result = await runDoctor(testFixture);

    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFD004", severity: "error" }),
    );
  });

  it("recognizes a partial installation without modifying it", async () => {
    const testFixture = await fixture();
    const context = path.join(testFixture.root, ".agentfold", "context");
    await mkdir(context, { recursive: true });
    await writeFile(path.join(context, "project.md"), "# Partial\n", "utf8");

    const result = await runDoctor(testFixture);

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "AFD004",
        severity: "warning",
        message: expect.stringContaining("partial BriefOnce installation"),
      }),
    );
    await expect(testFixture.fileSystem.readText(path.join(context, "project.md"))).resolves.toBe(
      "# Partial\n",
    );
  });
});
