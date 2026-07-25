import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli/run-cli.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import { captureOutput } from "../helpers/capture-output.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AgentFold CLI", () => {
  it("starts and displays help", async () => {
    const captured = captureOutput();

    const exitCode = await runCli(["node", "agentfold", "--help"], {
      output: captured.output,
    });

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toContain("BriefOnce");
    expect(captured.stdout()).toContain("Brief once. Continue with any agent.");
    expect(captured.stdout()).toContain("Usage: b1");
    expect(captured.stdout()).toContain("doctor");
    expect(captured.stdout()).toContain("init");
    expect(captured.stdout()).toContain("migrate");
    expect(captured.stdout()).toContain("start");
    expect(captured.stdout()).toContain("report");
    expect(captured.stdout()).toContain("checkpoint");
    expect(captured.stdout()).toContain("mcp");
    expect(captured.stdout()).toContain("connect");
    expect(captured.stdout()).toContain("verify");
    expect(captured.stdout()).toContain("disconnect");
    expect(captured.stderr()).toBe("");
  });

  it.each(["connect", "verify", "disconnect"])(
    "returns a focused validation error for an unknown %s host",
    async (command) => {
      const captured = captureOutput();
      const exitCode = await runCli(["node", "agentfold", command, "unsupported"], {
        output: captured.output,
      });
      expect(exitCode).toBe(2);
      expect(captured.stdout()).toContain("Unsupported connector host: unsupported");
      if (process.env.LOCALAPPDATA !== undefined) {
        expect(`${captured.stdout()}${captured.stderr()}`).not.toContain(process.env.LOCALAPPDATA);
      }
    },
  );

  it("registers MCP options without printing a normal CLI banner during server operation", async () => {
    const captured = captureOutput();
    let workspace: string | undefined;
    let debug = false;
    const exitCode = await runCli(
      ["node", "agentfold", "mcp", "--workspace", "workspace with spaces", "--debug"],
      {
        output: captured.output,
        runMcpServer: (input) => {
          workspace = input.workspace;
          debug = input.debug ?? false;
          return Promise.resolve(0);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(workspace).toBe("workspace with spaces");
    expect(debug).toBe(true);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toBe("");
  });

  it("starts and displays its version", async () => {
    const captured = captureOutput();

    const exitCode = await runCli(["node", "agentfold", "--version"], {
      output: captured.output,
      version: "1.2.3-test",
    });

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toBe("1.2.3-test\n");
    expect(captured.stderr()).toBe("");
  });

  it("runs doctor in an isolated fixture directory", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "agentfold-doctor-"));
    temporaryDirectories.push(fixture);
    await mkdir(path.join(fixture, ".git"));
    await writeFile(path.join(fixture, "README.md"), "# Fixture\n", "utf8");

    const captured = captureOutput();
    const fileSystem = new NodeFileSystem(() => fixture);
    const exitCode = await runCli(["node", "agentfold", "doctor"], {
      fileSystem,
      gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
      output: captured.output,
    });

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toContain("✓ passed [AFD001]");
    expect(captured.stdout()).toContain("Git repository detected");
    expect(captured.stdout()).toContain("⚠ warning [AFD004]");
    expect(captured.stdout()).toContain("expected before BriefOnce initialization");
    expect(captured.stderr()).toBe("");
  });

  it("dry-runs init without creating files", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "agentfold-init-dry-"));
    temporaryDirectories.push(fixture);
    await mkdir(path.join(fixture, ".git"));
    await writeFile(path.join(fixture, "pnpm-lock.yaml"), "", "utf8");
    const captured = captureOutput();
    const fileSystem = new NodeFileSystem(() => fixture);

    const exitCode = await runCli(["node", "agentfold", "init", "--dry-run"], {
      fileSystem,
      gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
      output: captured.output,
      version: "0.0.0-test",
    });

    expect(exitCode).toBe(0);
    expect(captured.stdout()).toContain("Dry run complete. No files were written.");
    expect(captured.stdout()).toContain(".briefonce/config.yaml");
    await expect(fileSystem.exists(path.join(fixture, ".briefonce"))).resolves.toBe(false);
  });

  it("initializes non-interactively with --yes and does not overwrite existing instructions", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "agentfold-init-yes-"));
    temporaryDirectories.push(fixture);
    await mkdir(path.join(fixture, ".git"));
    await writeFile(path.join(fixture, "AGENTS.md"), "# Keep me\n", "utf8");
    const captured = captureOutput();
    const fileSystem = new NodeFileSystem(() => fixture);
    const options = {
      fileSystem,
      gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
      output: captured.output,
      version: "0.0.0-test",
    };

    const exitCode = await runCli(["node", "agentfold", "init", "--yes"], options);

    expect(exitCode).toBe(0);
    await expect(
      fileSystem.exists(path.join(fixture, ".briefonce", "manifest.json")),
    ).resolves.toBe(true);
    await expect(fileSystem.readText(path.join(fixture, "AGENTS.md"))).resolves.toBe("# Keep me\n");

    const configBefore = await fileSystem.readText(path.join(fixture, ".briefonce", "config.yaml"));
    const secondExitCode = await runCli(["node", "agentfold", "init", "--yes"], options);
    expect(secondExitCode).toBe(0);
    await expect(
      fileSystem.readText(path.join(fixture, ".briefonce", "config.yaml")),
    ).resolves.toBe(configBefore);
  });

  it("returns Git conflict exit code outside a repository", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "agentfold-init-no-git-"));
    temporaryDirectories.push(fixture);
    const captured = captureOutput();
    const fileSystem = new NodeFileSystem(() => fixture);

    const exitCode = await runCli(["node", "agentfold", "init", "--yes"], {
      fileSystem,
      gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
      output: captured.output,
    });

    expect(exitCode).toBe(6);
    expect(captured.stdout()).toContain("requires an existing Git repository");
    await expect(fileSystem.exists(path.join(fixture, ".briefonce"))).resolves.toBe(false);
  });
});
