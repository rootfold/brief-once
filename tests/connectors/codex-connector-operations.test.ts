import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import type { ProcessRunner } from "../../src/core/process/process-runner.js";
import {
  applyCodexConnection,
  prepareCodexConnection,
  type CodexConnectorDependencies,
} from "../../src/integrations/connectors/codex/codex-connector.js";
import {
  applyCodexDisconnect,
  prepareCodexDisconnect,
} from "../../src/integrations/connectors/codex/codex-disconnect.js";
import { CodexOwnershipStore } from "../../src/integrations/connectors/codex/codex-ownership.js";
import { readCodexAgentFoldEntry } from "../../src/integrations/connectors/codex/codex-toml.js";
import { resolveCodexWorktreeIdentity } from "../../src/integrations/connectors/codex/codex-worktree.js";
import { verifyCodexConnection } from "../../src/integrations/connectors/codex/codex-verification.js";
import { createContinuityFixture } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const testDescriptor = {
  command: process.execPath,
  argsPrefix: [path.resolve("dist/cli.js")],
  fingerprint: "c".repeat(64),
} as const;

function gitRunner(
  root: string,
  commonDirectory = path.join(root, ".git"),
  gitDirectory = commonDirectory,
  calls: string[][] = [],
): ProcessRunner {
  return {
    run: (command, arguments_) => {
      calls.push([command, ...arguments_]);
      if (command !== "git") return Promise.resolve({ exitCode: 0, stdout: "0.0.0", stderr: "" });
      const selector = arguments_[1];
      const stdout =
        selector === "--show-toplevel"
          ? root
          : selector === "--git-common-dir"
            ? commonDirectory
            : selector === "--git-dir"
              ? gitDirectory
              : "";
      return Promise.resolve({
        exitCode: stdout === "" ? 1 : 0,
        stdout: `${stdout}\n`,
        stderr: "",
      });
    },
  };
}

function dependencies(
  root: string,
  home: string,
  stateDirectory: string,
  options: {
    readonly backupIdentity?: string;
    readonly fileSystem?: NodeFileSystem;
    readonly processRunner?: ProcessRunner;
  } = {},
): CodexConnectorDependencies {
  const fileSystem = options.fileSystem ?? new NodeFileSystem(() => root);
  const codexHome = path.join(home, ".codex");
  return {
    fileSystem,
    gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
    processRunner: options.processRunner ?? gitRunner(root),
    version: "0.0.0-test",
    platform: {
      platform: process.platform,
      environment: { ...process.env, CODEX_HOME: codexHome, PATH: "", LOCALAPPDATA: home },
      homeDirectory: home,
    },
    codexHome,
    stateDirectory,
    now: () => new Date("2026-07-21T12:00:00.000Z"),
    generateBackupIdentity: () => options.backupIdentity ?? "codex-backup-unit-test",
    resolveLaunchDescriptor: () => Promise.resolve(testDescriptor),
    verifyConnection: () =>
      Promise.resolve({
        host: "codex",
        valid: true,
        toolsAvailable: 9,
        serviceAvailable: true,
        exitCode: 0,
        diagnostics: [],
      }),
  };
}

async function fixture() {
  const repository = await createContinuityFixture(temporaryDirectories, {
    name: "agentfold Codex repository with spaces ",
  });
  const home = await mkdtemp(path.join(os.tmpdir(), "agentfold fake Codex home "));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "agentfold Codex state "));
  temporaryDirectories.push(home, stateDirectory);
  const config = path.join(home, ".codex", "config.toml");
  await mkdir(path.dirname(config), { recursive: true });
  const originalConfig =
    '# user comment\r\nmodel = "gpt-test"\r\nsecret = "FAKE_SECRET_CODEX_CONNECTOR"';
  const agents = path.join(repository.root, "AGENTS.md");
  const originalAgents = "# User repository instructions\n\nPreserve this exact text.\n";
  await writeFile(config, originalConfig, "utf8");
  await writeFile(agents, originalAgents, "utf8");
  return { repository, home, stateDirectory, config, originalConfig, agents, originalAgents };
}

describe("Codex connector operations", () => {
  it.each([
    ["missing config", "AFCD023"],
    ["missing AGENTS.md", "AFCD027"],
    ["modified AGENTS.md", "AFCD028"],
    ["stale executable", "AFCD026"],
  ] as const)("detects %s during read-only verification", async (scenario, code) => {
    const current = await fixture();
    const deps = dependencies(current.repository.root, current.home, current.stateDirectory);
    const plan = await prepareCodexConnection(deps, "cli");
    if (!plan.safe) throw new Error("Expected plan");
    await applyCodexConnection(plan, deps);
    if (scenario === "missing config") await deps.fileSystem.remove(current.config);
    if (scenario === "missing AGENTS.md") await deps.fileSystem.remove(current.agents);
    if (scenario === "modified AGENTS.md") {
      await writeFile(
        current.agents,
        (await readFile(current.agents, "utf8")).replace(
          "Use BriefOnce for substantive repository-changing work.",
          "Use BriefOnce for every message.",
        ),
        "utf8",
      );
    }
    const ownershipPath = path.join(current.stateDirectory, "codex-ownership.json");
    const ownershipBefore = await deps.fileSystem.readBytes(ownershipPath);
    const result = await verifyCodexConnection({
      fileSystem: deps.fileSystem,
      gitRepositoryLocator: deps.gitRepositoryLocator,
      processRunner: deps.processRunner,
      version: deps.version,
      platform: deps.platform!,
      stateDirectory: current.stateDirectory,
      codexHome: deps.codexHome!,
      startDirectory: current.repository.root,
      resolveDescriptor: () =>
        Promise.resolve(
          scenario === "stale executable"
            ? { ...testDescriptor, fingerprint: "d".repeat(64) }
            : testDescriptor,
        ),
      launchMcp: () => Promise.resolve({ toolsAvailable: 9, statusVerified: true }),
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((item) => item.code === code)).toBe(true);
    expect(await deps.fileSystem.readBytes(ownershipPath)).toEqual(ownershipBefore);
  });

  it("previews without writes, installs atomically, backs up config, and is idempotent", async () => {
    const current = await fixture();
    const deps = dependencies(current.repository.root, current.home, current.stateDirectory);
    const preview = await prepareCodexConnection(deps, "all");
    expect(preview.safe).toBe(true);
    if (!preview.safe) return;
    expect(preview.actions.map((action) => action.kind)).toEqual([
      "create_backup",
      "modify_config",
      "update_instructions",
      "write_ownership",
    ]);
    expect(await readFile(current.config, "utf8")).toBe(current.originalConfig);
    expect(await readFile(current.agents, "utf8")).toBe(current.originalAgents);

    expect((await applyCodexConnection(preview, deps)).exitCode).toBe(0);
    expect(readCodexAgentFoldEntry(await deps.fileSystem.readBytes(current.config))).toMatchObject({
      command: process.execPath,
      required: true,
    });
    expect(await readFile(current.config, "utf8")).toContain("FAKE_SECRET_CODEX_CONNECTOR");
    expect(await readFile(current.agents, "utf8")).toContain(current.originalAgents);
    expect(await readFile(current.agents, "utf8")).toContain("agentfold_open_session");
    expect(
      await readFile(
        path.join(current.stateDirectory, "backups", "codex-backup-unit-test.backup"),
        "utf8",
      ),
    ).toBe(current.originalConfig);
    const ownership = await new CodexOwnershipStore(deps.fileSystem, current.stateDirectory).read();
    expect(ownership?.surfaces.map((surface) => surface.surface).sort()).toEqual([
      "app",
      "cli",
      "ide",
    ]);
    expect(ownership?.workspaces).toHaveLength(1);
    expect(
      await readFile(path.join(current.stateDirectory, "codex-ownership.json"), "utf8"),
    ).not.toContain("FAKE_SECRET_CODEX_CONNECTOR");

    const second = await prepareCodexConnection(deps, "all");
    expect(second.safe).toBe(true);
    if (second.safe) {
      expect(second.configTarget.edit.action).toBe("identical");
      expect(second.agentsEdit.action).toBe("identical");
      expect(second.actions).toHaveLength(0);
    }
  });

  it("shares one global entry across repositories and removes it only after the last dependency", async () => {
    const current = await fixture();
    const first = dependencies(current.repository.root, current.home, current.stateDirectory, {
      backupIdentity: "codex-backup-first",
    });
    const firstPlan = await prepareCodexConnection(first, "ide");
    if (!firstPlan.safe) throw new Error("Expected first plan");
    await applyCodexConnection(firstPlan, first);

    const secondRepository = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold second Codex repository ",
    });
    const second = dependencies(secondRepository.root, current.home, current.stateDirectory, {
      backupIdentity: "codex-backup-second",
    });
    const secondPlan = await prepareCodexConnection(second, "ide");
    if (!secondPlan.safe) throw new Error("Expected second plan");
    expect(secondPlan.configTarget.edit.action).toBe("identical");
    await applyCodexConnection(secondPlan, second);
    expect(
      (await new CodexOwnershipStore(second.fileSystem, current.stateDirectory).read())?.workspaces,
    ).toHaveLength(2);

    const firstDisconnect = await prepareCodexDisconnect(first);
    if (!firstDisconnect.safe) throw new Error("Expected disconnect");
    expect(firstDisconnect.configTarget).toBeUndefined();
    await applyCodexDisconnect(firstDisconnect, first);
    expect(readCodexAgentFoldEntry(await first.fileSystem.readBytes(current.config))).toBeDefined();

    const secondDisconnect = await prepareCodexDisconnect(second);
    if (!secondDisconnect.safe) throw new Error("Expected final disconnect");
    expect(secondDisconnect.configTarget).toBeDefined();
    await applyCodexDisconnect(secondDisconnect, second);
    expect(
      readCodexAgentFoldEntry(await second.fileSystem.readBytes(current.config)),
    ).toBeUndefined();
    expect(await readFile(current.config, "utf8")).toBe(current.originalConfig);
    expect(await readFile(current.agents, "utf8")).toBe(current.originalAgents);
    expect(
      await second.fileSystem.exists(path.join(current.stateDirectory, "codex-ownership.json")),
    ).toBe(false);
  });

  it("blocks config backup failure before mutation", async () => {
    const current = await fixture();
    const deps = dependencies(current.repository.root, current.home, current.stateDirectory, {
      backupIdentity: "unsafe identity",
    });
    const plan = await prepareCodexConnection(deps, "cli");
    if (!plan.safe) throw new Error("Expected plan");
    expect(await applyCodexConnection(plan, deps)).toMatchObject({ status: "failed" });
    expect(await readFile(current.config, "utf8")).toBe(current.originalConfig);
    expect(await readFile(current.agents, "utf8")).toBe(current.originalAgents);
  });

  it("rolls back a config mutation when the AGENTS.md atomic write fails", async () => {
    const current = await fixture();
    class AgentsWriteFailureFileSystem extends NodeFileSystem {
      override writeBytesAndFlush(filePath: string, content: Uint8Array): Promise<void> {
        if (filePath.includes("AGENTS.md"))
          return Promise.reject(new Error("simulated write failure"));
        return super.writeBytesAndFlush(filePath, content);
      }
    }
    const fileSystem = new AgentsWriteFailureFileSystem(() => current.repository.root);
    const deps = dependencies(current.repository.root, current.home, current.stateDirectory, {
      fileSystem,
    });
    const plan = await prepareCodexConnection(deps, "cli");
    if (!plan.safe) throw new Error("Expected plan");
    expect(await applyCodexConnection(plan, deps)).toMatchObject({ status: "failed" });
    expect(await readFile(current.config, "utf8")).toBe(current.originalConfig);
    expect(await readFile(current.agents, "utf8")).toBe(current.originalAgents);
  });

  it("returns a severe diagnostic when Codex installation rollback also fails", async () => {
    const current = await fixture();
    class RollbackFailureFileSystem extends NodeFileSystem {
      private configRenames = 0;

      override writeBytesAndFlush(filePath: string, content: Uint8Array): Promise<void> {
        if (filePath.includes("AGENTS.md")) {
          return Promise.reject(new Error("simulated AGENTS write failure"));
        }
        return super.writeBytesAndFlush(filePath, content);
      }

      override rename(source: string, destination: string): Promise<void> {
        if (destination === current.config) {
          this.configRenames += 1;
          if (this.configRenames > 1) {
            return Promise.reject(new Error("simulated rollback failure"));
          }
        }
        return super.rename(source, destination);
      }
    }
    const fileSystem = new RollbackFailureFileSystem(() => current.repository.root);
    const deps = dependencies(current.repository.root, current.home, current.stateDirectory, {
      fileSystem,
    });
    const plan = await prepareCodexConnection(deps, "cli");
    if (!plan.safe) throw new Error("Expected plan");
    const result = await applyCodexConnection(plan, deps);
    expect(result.status).toBe("rollback_failed");
    expect(result.diagnostics.some((item) => item.code === "AFCD016")).toBe(true);
  });

  it("disconnects one selected surface while retaining shared config and AGENTS.md", async () => {
    const current = await fixture();
    const deps = dependencies(current.repository.root, current.home, current.stateDirectory);
    const plan = await prepareCodexConnection(deps, "all");
    if (!plan.safe) throw new Error("Expected plan");
    await applyCodexConnection(plan, deps);
    const disconnect = await prepareCodexDisconnect(deps, "cli");
    if (!disconnect.safe) throw new Error("Expected disconnect");
    expect(disconnect.configTarget).toBeUndefined();
    expect(disconnect.agentsTarget).toBeUndefined();
    await applyCodexDisconnect(disconnect, deps);
    const ownership = await new CodexOwnershipStore(deps.fileSystem, current.stateDirectory).read();
    expect(ownership?.surfaces.map((surface) => surface.surface).sort()).toEqual(["app", "ide"]);
    expect(readCodexAgentFoldEntry(await deps.fileSystem.readBytes(current.config))).toBeDefined();
    expect(await readFile(current.agents, "utf8")).toContain("agentfold_open_session");
  });

  it("preserves modified owned config and AGENTS regions as conflicts", async () => {
    const current = await fixture();
    const deps = dependencies(current.repository.root, current.home, current.stateDirectory);
    const plan = await prepareCodexConnection(deps, "cli");
    if (!plan.safe) throw new Error("Expected plan");
    await applyCodexConnection(plan, deps);
    await writeFile(
      current.config,
      (await readFile(current.config, "utf8")).replace("required = true", "required = false"),
      "utf8",
    );
    expect(await prepareCodexDisconnect(deps)).toMatchObject({ safe: false, exitCode: 5 });

    const reinstalledConfig = plan.configTarget.edit.bytes;
    await writeFile(current.config, reinstalledConfig);
    await writeFile(
      current.agents,
      (await readFile(current.agents, "utf8")).replace(
        "Use BriefOnce for substantive repository-changing work.",
        "Use BriefOnce for every message.",
      ),
      "utf8",
    );
    expect(await prepareCodexDisconnect(deps)).toMatchObject({ safe: false, exitCode: 5 });
  });

  it("uses only read-only rev-parse commands and distinguishes linked worktrees", async () => {
    const current = await fixture();
    const common = path.join(current.repository.root, ".git");
    const linkedGit = path.join(common, "worktrees", "linked");
    await mkdir(linkedGit, { recursive: true });
    const calls: string[][] = [];
    const identity = await resolveCodexWorktreeIdentity({
      fileSystem: current.repository.fileSystem,
      processRunner: gitRunner(current.repository.root, common, linkedGit, calls),
      repositoryRoot: current.repository.root,
      platform: process.platform,
    });
    expect(identity.kind).toBe("linked");
    expect(identity.repositoryId).toHaveLength(24);
    expect(identity.repositoryFamilyId).toHaveLength(24);
    expect(calls).toEqual([
      ["git", "rev-parse", "--show-toplevel"],
      ["git", "rev-parse", "--git-common-dir"],
      ["git", "rev-parse", "--git-dir"],
    ]);
  });

  it("never changes the Antigravity ownership record", async () => {
    const current = await fixture();
    const sentinel = path.join(current.stateDirectory, "antigravity-ownership.json");
    await writeFile(sentinel, "ANTIGRAVITY_SENTINEL\n", "utf8");
    const deps = dependencies(current.repository.root, current.home, current.stateDirectory);
    const plan = await prepareCodexConnection(deps, "app");
    if (!plan.safe) throw new Error("Expected plan");
    await applyCodexConnection(plan, deps);
    const disconnect = await prepareCodexDisconnect(deps);
    if (!disconnect.safe) throw new Error("Expected disconnect");
    await applyCodexDisconnect(disconnect, deps);
    expect(await readFile(sentinel, "utf8")).toBe("ANTIGRAVITY_SENTINEL\n");
  });

  it("rejects a Codex configuration path that traverses a symbolic link", async () => {
    const current = await fixture();
    const escaped = await mkdtemp(path.join(os.tmpdir(), "agentfold escaped Codex config "));
    const linkedHome = await mkdtemp(path.join(os.tmpdir(), "agentfold linked Codex home "));
    temporaryDirectories.push(escaped, linkedHome);
    await symlink(
      escaped,
      path.join(linkedHome, ".codex"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const deps = dependencies(current.repository.root, linkedHome, current.stateDirectory);
    expect(await prepareCodexConnection(deps, "cli")).toMatchObject({
      safe: false,
      exitCode: 1,
    });
  });
});
