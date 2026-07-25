import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../src/core/config/parse-config.js";
import { serializeConfig } from "../../src/core/config/serialize-config.js";
import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import { AtomicInitializationWriter } from "../../src/core/initialization/atomic-writer.js";
import {
  commitInitialization,
  prepareInitialization,
} from "../../src/core/initialization/initialize.js";
import { codexMcpEntrySchema } from "../../src/integrations/connectors/codex/codex-launch-entry.js";
import { readCodexAgentFoldEntry } from "../../src/integrations/connectors/codex/codex-toml.js";
import { agentFoldMcpToolNames } from "../../src/integrations/mcp/tool-names.js";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];
const spawnedEnvironments: NodeJS.ProcessEnv[] = [];

afterEach(async () => {
  const cli = path.resolve(import.meta.dirname, "..", "..", "dist", "cli.js");
  await Promise.all(
    spawnedEnvironments
      .splice(0)
      .map((env) =>
        run(process.execPath, [cli, "service", "stop"], { env }).catch(() => undefined),
      ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(root: string, ...arguments_: string[]): Promise<string> {
  return (await run("git", arguments_, { cwd: root })).stdout.trim();
}

async function initializedRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentfold Codex E2E repository "));
  temporaryDirectories.push(root);
  await git(root, "init", "--quiet");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "fixture.ts"), "export const PRIVATE_SOURCE = true;\n");
  await writeFile(
    path.join(root, "AGENTS.md"),
    "# User instructions\n\nPreserve this exact text.\n",
  );
  const fileSystem = new NodeFileSystem(() => root);
  const locator = new FilesystemGitRepositoryLocator(fileSystem);
  const plan = await prepareInitialization({
    fileSystem,
    gitRepositoryLocator: locator,
    agentfoldVersion: "0.0.0-test",
    now: () => new Date("2026-07-21T12:00:00.000Z"),
  });
  if (plan.status !== "ready") throw new Error("Expected initialized Codex fixture");
  await commitInitialization(plan, new AtomicInitializationWriter(fileSystem, () => ".codex-init"));
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
  await writeFile(configPath, serializeConfig(config), "utf8");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.name=AgentFold Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  return root;
}

function resultData(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || !("structuredContent" in result)) return {};
  const structured = result.structuredContent;
  if (typeof structured !== "object" || structured === null || !("data" in structured)) return {};
  const data = structured.data;
  return typeof data === "object" && data !== null ? { ...data } : {};
}

async function pathWithoutCodexExecutables(): Promise<string> {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const safe: string[] = [];
  for (const entry of entries) {
    try {
      await access(path.join(entry, name));
    } catch {
      safe.push(entry);
    }
  }
  return safe.join(delimiter);
}

async function connectMcp(
  command: string,
  args: readonly string[],
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
) {
  const transport = new StdioClientTransport({
    command,
    args: [...args],
    cwd: repositoryRoot,
    env: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "codex-connector-fixture", version: "1.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: [{ uri: pathToFileURL(repositoryRoot).toString(), name: "fixture" }],
  }));
  await client.connect(transport);
  return client;
}

describe("built Codex connector workflow", () => {
  it.skipIf(process.env.AGENTFOLD_CONNECTOR_BUILT !== "1")(
    "previews, installs, hands off through MCP, verifies worktrees, and disconnects safely",
    async () => {
      const repositoryRoot = await initializedRepository();
      const linkedParent = await mkdtemp(path.join(os.tmpdir(), "agentfold Codex linked parent "));
      temporaryDirectories.push(linkedParent);
      const linkedRoot = path.join(linkedParent, "linked workspace");
      await git(repositoryRoot, "worktree", "add", "--quiet", "--detach", linkedRoot);
      const linkedAgentsBefore = await readFile(path.join(linkedRoot, "AGENTS.md"), "utf8");
      const home = await mkdtemp(path.join(os.tmpdir(), "agentfold isolated Codex home Å "));
      const runtime = await mkdtemp(path.join(os.tmpdir(), "agentfold isolated Codex runtime "));
      const state = await mkdtemp(
        path.join(os.tmpdir(), "agentfold isolated Codex connector state "),
      );
      temporaryDirectories.push(home, runtime, state);
      const codexHome = path.join(home, ".codex");
      await mkdir(codexHome, { recursive: true });
      const configPath = path.join(codexHome, "config.toml");
      const fakeSecret = "FAKE_CODEX_SECRET_MUST_NOT_LEAK";
      const originalConfig = `# preserve this\r\nmodel = "gpt-test"\r\nsecret = "${fakeSecret}"`;
      await writeFile(configPath, originalConfig, "utf8");
      const originalAgents = await readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: await pathWithoutCodexExecutables(),
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: path.join(home, "Local App Data"),
        CODEX_HOME: codexHome,
        AGENTFOLD_CONNECTOR_STATE_DIR: state,
        AGENTFOLD_RUNTIME_DIR: runtime,
      };
      spawnedEnvironments.push(env);
      await writeFile(path.join(state, "antigravity-ownership.json"), "ANTIGRAVITY_SENTINEL\n");
      const cli = path.resolve(import.meta.dirname, "..", "..", "dist", "cli.js");
      const runCli = (cwd: string, ...arguments_: string[]) =>
        run(process.execPath, [cli, ...arguments_], {
          cwd,
          env,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
      const branchBefore = await git(repositoryRoot, "symbolic-ref", "HEAD");
      const headBefore = await git(repositoryRoot, "rev-parse", "HEAD");
      const remotesBefore = await git(repositoryRoot, "remote", "-v");
      const stashBefore = await git(repositoryRoot, "stash", "list");
      const hooksBefore = (await readdir(path.join(repositoryRoot, ".git", "hooks"))).sort();
      const sourceBefore = await readFile(path.join(repositoryRoot, "src", "fixture.ts"), "utf8");

      const preview = await runCli(repositoryRoot, "connect", "codex", "--surface", "all");
      expect(preview.stdout).toContain("No files were changed");
      expect(preview.stdout).not.toContain(home);
      expect(preview.stdout).not.toContain(fakeSecret);
      expect(await readFile(configPath, "utf8")).toBe(originalConfig);
      expect(await readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8")).toBe(originalAgents);

      const installed = await runCli(
        repositoryRoot,
        "connect",
        "codex",
        "--surface",
        "all",
        "--yes",
      );
      expect(installed.stdout).toContain("Codex connector was installed");
      expect(installed.stdout).not.toContain(fakeSecret);
      const entry = codexMcpEntrySchema.parse(
        readCodexAgentFoldEntry(new Uint8Array(await readFile(configPath))),
      );
      expect(entry.args).toContain("--ensure-service");
      expect(entry.args).toContain("auto");
      expect(entry.args.join(" ")).not.toContain(repositoryRoot);
      expect(await readFile(configPath, "utf8")).toContain(fakeSecret);
      expect(await readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8")).toContain(
        "agentfold_open_session",
      );
      expect((await readdir(path.join(state, "backups"))).length).toBe(1);

      const codexClient = await connectMcp(entry.command, entry.args, repositoryRoot, env);
      expect((await codexClient.listTools()).tools).toHaveLength(9);
      const opened = await codexClient.callTool({
        name: agentFoldMcpToolNames.openSession,
        arguments: { client: "codex-cli", agent: "codex", target: "codex" },
      });
      const sessionId = String(resultData(opened).sessionId);
      await codexClient.callTool({
        name: agentFoldMcpToolNames.beginTask,
        arguments: {
          sessionId,
          title: "Codex connector fixture",
          objective: "Verify Codex continuity",
        },
      });
      await codexClient.callTool({
        name: agentFoldMcpToolNames.reportProgress,
        arguments: { sessionId, completed: ["Codex connector milestone complete"] },
      });
      await codexClient.callTool({
        name: agentFoldMcpToolNames.closeSession,
        arguments: { sessionId, createCheckpoint: true },
      });
      await codexClient.close();

      const antigravityClient = await connectMcp(entry.command, entry.args, repositoryRoot, env);
      const resumed = await antigravityClient.callTool({
        name: agentFoldMcpToolNames.openSession,
        arguments: { client: "antigravity-ide", agent: "antigravity", target: "antigravity" },
      });
      expect(JSON.stringify(resumed)).toContain("Codex connector milestone complete");
      expect(JSON.stringify(resumed)).not.toContain(repositoryRoot);
      expect(JSON.stringify(resumed)).not.toContain("PRIVATE_SOURCE");
      await antigravityClient.close();

      const verified = await runCli(repositoryRoot, "verify", "codex");
      expect(verified.stdout).toContain("verification passed");
      expect(verified.stdout).toContain("Tools: 9");
      const linkedPreview = await runCli(
        linkedRoot,
        "connect",
        "codex",
        "--surface",
        "cli",
        "--dry-run",
      );
      expect(linkedPreview.stdout).toContain("linked worktree");
      expect(linkedPreview.stdout).toContain("No files were changed");
      expect(await readFile(path.join(linkedRoot, "AGENTS.md"), "utf8")).toBe(linkedAgentsBefore);

      const disconnected = await runCli(repositoryRoot, "disconnect", "codex", "--yes");
      expect(disconnected.stdout).toContain("service was left running");
      expect(await readFile(configPath, "utf8")).toBe(originalConfig);
      expect(await readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8")).toBe(originalAgents);
      expect(await readFile(path.join(state, "antigravity-ownership.json"), "utf8")).toBe(
        "ANTIGRAVITY_SENTINEL\n",
      );
      expect((await runCli(repositoryRoot, "service", "status")).stdout).toContain("Running: yes");
      expect(await git(repositoryRoot, "symbolic-ref", "HEAD")).toBe(branchBefore);
      expect(await git(repositoryRoot, "rev-parse", "HEAD")).toBe(headBefore);
      expect(await git(repositoryRoot, "remote", "-v")).toBe(remotesBefore);
      expect(await git(repositoryRoot, "stash", "list")).toBe(stashBefore);
      expect((await readdir(path.join(repositoryRoot, ".git", "hooks"))).sort()).toEqual(
        hooksBefore,
      );
      expect(await readFile(path.join(repositoryRoot, "src", "fixture.ts"), "utf8")).toBe(
        sourceBefore,
      );
      await expect(stat(path.join(state, "codex-ownership.json"))).rejects.toThrow();
    },
    120_000,
  );
});
