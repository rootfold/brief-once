import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { loadCanonicalContext } from "../../src/core/context/load-context.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import { AtomicInitializationWriter } from "../../src/core/initialization/atomic-writer.js";
import { AtomicTextFileWriter } from "../../src/core/filesystem/atomic-text-file-writer.js";
import type { GitInspector } from "../../src/core/git/git-inspector.js";
import {
  commitInitialization,
  prepareInitialization,
} from "../../src/core/initialization/initialize.js";
import {
  commitProjectStorageMigration,
  prepareProjectStorageMigration,
} from "../../src/core/migration/migrate-project-storage.js";
import { commitTaskStart, prepareTaskStart } from "../../src/core/state/start-task.js";
import { captureOutput } from "../helpers/capture-output.js";

const temporaryDirectories: string[] = [];
const gitInspector: GitInspector = {
  async readWorkingFacts() {
    return { branch: "main", commit: null, detached: false };
  },
  async isPathIgnored() {
    return true;
  },
  async readCheckpointFacts() {
    throw new Error("Checkpoint facts are not needed by this migration fixture");
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function initializedFixture(): Promise<{
  readonly root: string;
  readonly fileSystem: NodeFileSystem;
  readonly gitRepositoryLocator: FilesystemGitRepositoryLocator;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "briefonce migration with spaces "));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, ".git"));
  const fileSystem = new NodeFileSystem(() => root);
  const gitRepositoryLocator = new FilesystemGitRepositoryLocator(fileSystem);
  const plan = await prepareInitialization({
    fileSystem,
    gitRepositoryLocator,
    agentfoldVersion: "0.1.3-test",
    now: () => new Date("2026-07-25T00:00:00.000Z"),
  });
  if (plan.status !== "ready") throw new Error("Expected initialization fixture");
  await commitInitialization(
    plan,
    new AtomicInitializationWriter(fileSystem, () => ".briefonce.init-migration-test"),
  );
  return { root, fileSystem, gitRepositoryLocator };
}

async function convertToLegacy(
  fixture: Awaited<ReturnType<typeof initializedFixture>>,
): Promise<void> {
  const preferred = path.join(fixture.root, ".briefonce");
  const legacy = path.join(fixture.root, ".agentfold");
  await fixture.fileSystem.rename(preferred, legacy);
  const manifestPath = path.join(legacy, "manifest.json");
  const manifest = await fixture.fileSystem.readText(manifestPath);
  await fixture.fileSystem.writeText(
    manifestPath,
    manifest.replaceAll(".briefonce/", ".agentfold/"),
  );
}

describe("project storage migration", () => {
  it("loads legacy storage read-only with a migration warning", async () => {
    const fixture = await initializedFixture();
    await convertToLegacy(fixture);

    const result = await loadCanonicalContext({
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      startDirectory: fixture.root,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.context.storage).toEqual({ directory: ".agentfold", legacy: true });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "AFC012", severity: "warning" }),
    );
    await expect(fixture.fileSystem.exists(path.join(fixture.root, ".briefonce"))).resolves.toBe(
      false,
    );
  });

  it("keeps legacy repositories operational until their explicit migration", async () => {
    const fixture = await initializedFixture();
    await convertToLegacy(fixture);

    const plan = await prepareTaskStart(
      {
        fileSystem: fixture.fileSystem,
        gitRepositoryLocator: fixture.gitRepositoryLocator,
        gitInspector,
        startDirectory: fixture.root,
        now: () => new Date("2026-07-25T01:00:00.000Z"),
      },
      { title: "Legacy-compatible task", agent: "codex" },
    );

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.statePath).toBe(path.join(fixture.root, ".agentfold", "state", "current.md"));
    await commitTaskStart(plan, new AtomicTextFileWriter(fixture.fileSystem));
    await expect(fixture.fileSystem.exists(plan.statePath)).resolves.toBe(true);
    await expect(
      fixture.fileSystem.exists(path.join(fixture.root, ".briefonce", "state", "current.md")),
    ).resolves.toBe(false);
  });

  it("previews without writes, then atomically renames storage and normalizes the manifest", async () => {
    const fixture = await initializedFixture();
    await convertToLegacy(fixture);

    const plan = await prepareProjectStorageMigration(fixture);
    expect(plan.status).toBe("ready");
    await expect(fixture.fileSystem.exists(path.join(fixture.root, ".agentfold"))).resolves.toBe(
      true,
    );
    await expect(fixture.fileSystem.exists(path.join(fixture.root, ".briefonce"))).resolves.toBe(
      false,
    );
    if (plan.status !== "ready") return;

    const diagnostics = await commitProjectStorageMigration(plan, fixture.fileSystem);

    expect(diagnostics.at(-1)).toMatchObject({ code: "AFMG008", severity: "success" });
    await expect(fixture.fileSystem.exists(path.join(fixture.root, ".agentfold"))).resolves.toBe(
      false,
    );
    await expect(fixture.fileSystem.exists(path.join(fixture.root, ".briefonce"))).resolves.toBe(
      true,
    );
    const manifest = await fixture.fileSystem.readText(
      path.join(fixture.root, ".briefonce", "manifest.json"),
    );
    expect(manifest).toContain(".briefonce/context/project.md");
    expect(manifest).not.toContain(".agentfold/");
    const canonical = await loadCanonicalContext({
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      startDirectory: fixture.root,
    });
    expect(canonical.status).toBe("success");
    if (canonical.status === "success") {
      expect(canonical.context.storage).toEqual({ directory: ".briefonce", legacy: false });
      expect(canonical.diagnostics).not.toContainEqual(expect.objectContaining({ code: "AFC012" }));
    }
  });

  it("is idempotent after migration and never overwrites a preferred directory", async () => {
    const fixture = await initializedFixture();
    const alreadyMigrated = await prepareProjectStorageMigration(fixture);
    expect(alreadyMigrated).toMatchObject({
      status: "already-migrated",
      exitCode: 0,
      diagnostics: [expect.objectContaining({ code: "AFMG004" })],
    });

    await fixture.fileSystem.rename(
      path.join(fixture.root, ".briefonce"),
      path.join(fixture.root, ".agentfold"),
    );
    await mkdir(path.join(fixture.root, ".briefonce"));
    const conflict = await prepareProjectStorageMigration(fixture);
    expect(conflict).toMatchObject({
      status: "conflict",
      exitCode: 5,
      diagnostics: [expect.objectContaining({ code: "AFMG002" })],
    });
    await expect(
      fixture.fileSystem.exists(path.join(fixture.root, ".agentfold", "config.yaml")),
    ).resolves.toBe(true);
  });

  it("rejects invalid legacy manifests without renaming either directory", async () => {
    const fixture = await initializedFixture();
    await convertToLegacy(fixture);
    await fixture.fileSystem.writeText(
      path.join(fixture.root, ".agentfold", "manifest.json"),
      "{ invalid",
    );

    const plan = await prepareProjectStorageMigration(fixture);

    expect(plan).toMatchObject({
      status: "invalid-installation",
      exitCode: 2,
      diagnostics: [expect.objectContaining({ code: "AFMG006" })],
    });
    await expect(fixture.fileSystem.exists(path.join(fixture.root, ".agentfold"))).resolves.toBe(
      true,
    );
    await expect(fixture.fileSystem.exists(path.join(fixture.root, ".briefonce"))).resolves.toBe(
      false,
    );
  });

  it("rejects a symbolic-link legacy project directory on every supported platform", async () => {
    const fixture = await initializedFixture();
    await convertToLegacy(fixture);
    const legacy = path.join(fixture.root, ".agentfold");
    const actual = path.join(fixture.root, "legacy-storage-target");
    await fixture.fileSystem.rename(legacy, actual);
    await symlink(actual, legacy, process.platform === "win32" ? "junction" : "dir");

    const plan = await prepareProjectStorageMigration(fixture);

    expect(plan).toMatchObject({
      status: "invalid-installation",
      exitCode: 2,
      diagnostics: [expect.objectContaining({ code: "AFMG006" })],
    });
    await expect(fixture.fileSystem.exists(path.join(actual, "config.yaml"))).resolves.toBe(true);
    await expect(fixture.fileSystem.exists(path.join(fixture.root, ".briefonce"))).resolves.toBe(
      false,
    );
  });

  it("rejects ambiguous canonical context when both namespaces exist", async () => {
    const fixture = await initializedFixture();
    await mkdir(path.join(fixture.root, ".agentfold"));

    const result = await loadCanonicalContext({
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      startDirectory: fixture.root,
    });

    expect(result).toMatchObject({
      status: "error",
      diagnostics: [expect.objectContaining({ code: "AFC011", severity: "error" })],
    });
  });

  it("exposes conservative preview and explicit apply behavior through the CLI", async () => {
    const fixture = await initializedFixture();
    await convertToLegacy(fixture);
    const previewOutput = captureOutput();

    expect(
      await runCli(["node", "b1", "migrate"], {
        fileSystem: fixture.fileSystem,
        gitRepositoryLocator: fixture.gitRepositoryLocator,
        output: previewOutput.output,
      }),
    ).toBe(0);
    expect(previewOutput.stdout()).toContain("Preview complete");
    await expect(fixture.fileSystem.exists(path.join(fixture.root, ".agentfold"))).resolves.toBe(
      true,
    );

    const applyOutput = captureOutput();
    expect(
      await runCli(["node", "b1", "migrate", "--yes"], {
        fileSystem: fixture.fileSystem,
        gitRepositoryLocator: fixture.gitRepositoryLocator,
        output: applyOutput.output,
      }),
    ).toBe(0);
    expect(applyOutput.stdout()).toContain("[AFMG008]");
    await expect(
      fixture.fileSystem.exists(path.join(fixture.root, ".briefonce", "config.yaml")),
    ).resolves.toBe(true);
  });
});
