import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import type { ProcessRunner } from "../../src/core/process/process-runner.js";
import {
  antigravityConfigCandidateDefinitions,
  antigravityDocumentation,
} from "../../src/integrations/connectors/antigravity/antigravity-paths.js";
import {
  discoverAntigravity,
  selectAntigravityTargets,
} from "../../src/integrations/connectors/antigravity/antigravity-discovery.js";
import {
  fingerprintLaunchDescriptor,
  resolveAgentFoldLaunchDescriptor,
} from "../../src/integrations/connectors/executable-descriptor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Antigravity path discovery", () => {
  it("centralizes current official global, CLI-transition, and workspace candidates", () => {
    const windows = antigravityConfigCandidateDefinitions(
      { platform: "win32", environment: {}, homeDirectory: "C:\\Users\\A B" },
      "D:\\repo",
    );
    expect(windows.map((item) => item.path)).toEqual([
      "C:\\Users\\A B\\.gemini\\config\\mcp_config.json",
      "C:\\Users\\A B\\.gemini\\antigravity-cli\\mcp_config.json",
      "D:\\repo\\.agents\\mcp_config.json",
    ]);
    const mac = antigravityConfigCandidateDefinitions(
      { platform: "darwin", environment: {}, homeDirectory: "/Users/Å User" },
      "/work/project",
    );
    expect(mac[0]?.path).toBe("/Users/Å User/.gemini/config/mcp_config.json");
    const linux = antigravityConfigCandidateDefinitions(
      { platform: "linux", environment: {}, homeDirectory: "/home/test" },
      "/work/project",
    );
    expect(linux[1]?.path).toBe("/home/test/.gemini/antigravity-cli/mcp_config.json");
    expect(new Set(Object.values(antigravityDocumentation)).size).toBe(5);
  });

  it("detects bounded central evidence without recursively scanning the home", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentfold-agy-home "));
    const repository = await mkdtemp(path.join(os.tmpdir(), "agentfold-agy-repo "));
    temporaryDirectories.push(home, repository);
    const central = path.join(home, ".gemini", "config", "mcp_config.json");
    await mkdir(path.dirname(central), { recursive: true });
    await writeFile(central, "{}\n", "utf8");
    const discovery = await discoverAntigravity({
      fileSystem: new NodeFileSystem(() => repository),
      platform: { platform: process.platform, environment: process.env, homeDirectory: home },
      repositoryRoot: repository,
    });
    expect(discovery.surfaces.map((item) => item.installed)).toEqual([true, true, true]);
    expect(discovery.workspaceCandidate.path).toBe(
      path.join(repository, ".agents", "mcp_config.json"),
    );
    expect(selectAntigravityTargets(discovery, "auto")).toMatchObject({ status: "selected" });
    expect(selectAntigravityTargets(discovery, "desktop")).toMatchObject({
      status: "selected",
    });
  });

  it("reports ambiguity when central and CLI-transition configs both exist", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentfold-agy-ambiguous "));
    const repository = await mkdtemp(path.join(os.tmpdir(), "agentfold-agy-project "));
    temporaryDirectories.push(home, repository);
    for (const relative of [
      [".gemini", "config", "mcp_config.json"],
      [".gemini", "antigravity-cli", "mcp_config.json"],
    ]) {
      const file = path.join(home, ...relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "{}", "utf8");
    }
    const discovery = await discoverAntigravity({
      fileSystem: new NodeFileSystem(() => repository),
      platform: { platform: process.platform, environment: process.env, homeDirectory: home },
      repositoryRoot: repository,
    });
    expect(selectAntigravityTargets(discovery, "auto")).toMatchObject({
      status: "error",
      exitCode: 5,
    });
    expect(selectAntigravityTargets(discovery, "all")).toMatchObject({ status: "selected" });
    expect(selectAntigravityTargets(discovery, "desktop")).toMatchObject({ status: "selected" });
    expect(selectAntigravityTargets(discovery, "cli")).toMatchObject({ status: "error" });
  });

  it("fails automatic discovery without bounded evidence but permits an explicit surface", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentfold empty agy home "));
    const repository = await mkdtemp(path.join(os.tmpdir(), "agentfold explicit agy project "));
    temporaryDirectories.push(home, repository);
    const discovery = await discoverAntigravity({
      fileSystem: new NodeFileSystem(() => repository),
      platform: { platform: process.platform, environment: {}, homeDirectory: home },
      repositoryRoot: repository,
    });
    expect(selectAntigravityTargets(discovery, "auto")).toMatchObject({
      status: "error",
      exitCode: 6,
    });
    expect(selectAntigravityTargets(discovery, "ide")).toMatchObject({ status: "selected" });
  });
});

describe("BriefOnce launch descriptors", () => {
  it("resolves a verified built or npm-installed CLI without a shell or package-manager shim", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentfold package Å "));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "dist"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@rootfold/brief-once",
        bin: { b1: "./dist/cli.js", agentfold: "./dist/cli.js" },
      }),
      "utf8",
    );
    await writeFile(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n", "utf8");
    const calls: { command: string; arguments_: readonly string[] }[] = [];
    const processRunner: ProcessRunner = {
      run(command, arguments_) {
        calls.push({ command, arguments_ });
        return Promise.resolve({ exitCode: 0, stdout: "0.0.0", stderr: "" });
      },
    };
    const descriptor = await resolveAgentFoldLaunchDescriptor({
      fileSystem: new NodeFileSystem(() => root),
      processRunner,
      executable: process.execPath,
      modulePath: path.join(root, "dist", "module.js"),
      allowTemporaryPath: true,
    });
    expect(descriptor.command).toBe(path.resolve(process.execPath));
    expect(descriptor.argsPrefix).toEqual([path.join(root, "dist", "cli.js")]);
    expect(calls[0]?.arguments_).toEqual([path.join(root, "dist", "cli.js"), "--version"]);
    expect(descriptor.command).not.toMatch(/(?:npm|pnpm|npx)/iu);
    expect(descriptor.fingerprint).toBe(fingerprintLaunchDescriptor(descriptor));
  });

  it("resolves the official scoped package from a global-style installation path", async () => {
    const prefix = await mkdtemp(path.join(os.tmpdir(), "agentfold global prefix Å "));
    temporaryDirectories.push(prefix);
    const packageRoot = path.join(prefix, "lib", "node_modules", "@rootfold", "brief-once");
    const cliEntry = path.join(packageRoot, "dist", "cli.js");
    await mkdir(path.dirname(cliEntry), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@rootfold/brief-once",
        bin: { b1: "./dist/cli.js", agentfold: "./dist/cli.js" },
      }),
      "utf8",
    );
    await writeFile(cliEntry, "#!/usr/bin/env node\n", "utf8");

    const descriptor = await resolveAgentFoldLaunchDescriptor({
      fileSystem: new NodeFileSystem(() => prefix),
      processRunner: {
        run: () => Promise.resolve({ exitCode: 0, stdout: "0.1.1", stderr: "" }),
      },
      executable: process.execPath,
      modulePath: path.join(packageRoot, "dist", "module.js"),
      allowTemporaryPath: true,
    });

    expect(descriptor.command).toBe(path.resolve(process.execPath));
    expect(descriptor.argsPrefix).toEqual([cliEntry]);
  });

  it("keeps resolving the legacy scoped AgentFold package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentfold legacy package "));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "dist"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@rootfold/agentfold", bin: { agentfold: "./dist/cli.js" } }),
      "utf8",
    );
    await writeFile(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n", "utf8");
    const descriptor = await resolveAgentFoldLaunchDescriptor({
      fileSystem: new NodeFileSystem(() => root),
      processRunner: {
        run: () => Promise.resolve({ exitCode: 0, stdout: "0.1.3", stderr: "" }),
      },
      executable: process.execPath,
      modulePath: path.join(root, "dist", "module.js"),
      allowTemporaryPath: true,
    });
    expect(descriptor.argsPrefix).toEqual([path.join(root, "dist", "cli.js")]);
  });

  it("rejects missing package, executable, and CLI entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentfold descriptor missing "));
    temporaryDirectories.push(root);
    const runner: ProcessRunner = {
      run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    };
    await expect(
      resolveAgentFoldLaunchDescriptor({
        fileSystem: new NodeFileSystem(() => root),
        processRunner: runner,
        modulePath: path.join(root, "x.js"),
        allowTemporaryPath: true,
      }),
    ).rejects.toThrow(/package boundary/u);

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@rootfold/agentfold", bin: "./dist/cli.js" }),
      "utf8",
    );
    await expect(
      resolveAgentFoldLaunchDescriptor({
        fileSystem: new NodeFileSystem(() => root),
        processRunner: runner,
        modulePath: path.join(root, "module.js"),
        allowTemporaryPath: true,
      }),
    ).rejects.toThrow(/CLI entry/u);

    const shim = path.join(root, "pnpm.cmd");
    await writeFile(shim, "@echo off\n", "utf8");
    await expect(
      resolveAgentFoldLaunchDescriptor({
        fileSystem: new NodeFileSystem(() => root),
        processRunner: runner,
        executable: shim,
        modulePath: path.join(root, "module.js"),
        allowTemporaryPath: true,
      }),
    ).rejects.toThrow(/shims/u);
  });

  it("rejects an unscoped package that uses the AgentFold binary name", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentfold untrusted package "));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "dist"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "agentfold", bin: { agentfold: "./dist/cli.js" } }),
      "utf8",
    );
    await writeFile(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n", "utf8");

    await expect(
      resolveAgentFoldLaunchDescriptor({
        fileSystem: new NodeFileSystem(() => root),
        processRunner: {
          run: () => Promise.resolve({ exitCode: 0, stdout: "0.1.1", stderr: "" }),
        },
        executable: process.execPath,
        modulePath: path.join(root, "dist", "module.js"),
        allowTemporaryPath: true,
      }),
    ).rejects.toThrow(/package boundary/u);
  });
});
