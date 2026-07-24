import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import { AtomicInitializationWriter } from "../../src/core/initialization/atomic-writer.js";
import {
  commitInitialization,
  prepareInitialization,
} from "../../src/core/initialization/initialize.js";
import { agentFoldMcpToolNames } from "../../src/integrations/mcp/tool-names.js";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function resultEnvelope(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || !("structuredContent" in result)) return {};
  const structuredContent = result.structuredContent;
  return typeof structuredContent === "object" && structuredContent !== null
    ? Object.fromEntries(Object.entries(structuredContent))
    : {};
}

function resultData(result: unknown): Record<string, unknown> {
  const envelope = resultEnvelope(result);
  return typeof envelope.data === "object" && envelope.data !== null
    ? Object.fromEntries(Object.entries(envelope.data))
    : {};
}

async function git(root: string, ...arguments_: string[]): Promise<string> {
  return (await run("git", arguments_, { cwd: root })).stdout.trim();
}

async function createRealGitFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentfold mcp stdio with spaces "));
  temporaryDirectories.push(root);
  await git(root, "init", "--quiet");
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "application.ts"),
    "export const sourceMarker = 'SOURCE_MUST_NOT_LEAK';\n",
    "utf8",
  );
  await writeFile(path.join(root, "README.md"), "# MCP fixture\n", "utf8");
  const fileSystem = new NodeFileSystem(() => root);
  const locator = new FilesystemGitRepositoryLocator(fileSystem);
  const plan = await prepareInitialization({
    fileSystem,
    gitRepositoryLocator: locator,
    agentfoldVersion: "0.0.0-test",
    now: () => new Date("2026-07-21T01:00:00.000Z"),
  });
  if (plan.status !== "ready") throw new Error("Expected stdio fixture initialization");
  await commitInitialization(plan, new AtomicInitializationWriter(fileSystem, () => ".mcp-init"));
  return root;
}

describe("real MCP stdio workflow", () => {
  it("connects with the official client and completes continuity without stdout pollution", async () => {
    const fixture = await createRealGitFixture();
    const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
    const useBuiltCli = process.env.AGENTFOLD_MCP_BUILT === "1";
    const entry = path.join(repositoryRoot, useBuiltCli ? "dist/cli.js" : "src/cli/index.ts");
    const serverArguments = useBuiltCli
      ? [entry, "mcp", "--workspace", fixture, "--service", "disabled", "--debug"]
      : [
          "--import",
          "tsx",
          entry,
          "mcp",
          "--workspace",
          fixture,
          "--service",
          "disabled",
          "--debug",
        ];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: serverArguments,
      cwd: repositoryRoot,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "agentfold-stdio-test", version: "1.0.0" });
    const branchBefore = await git(fixture, "symbolic-ref", "HEAD");
    const stagedBefore = await git(fixture, "diff", "--cached", "--name-only");
    const hooksBefore = (await readdir(path.join(fixture, ".git", "hooks"))).sort();
    const remotesBefore = await git(fixture, "remote");
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
      Object.values(agentFoldMcpToolNames).sort(),
    );
    const responses: unknown[] = [];
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: arguments_ });
      responses.push(result);
      expect(result.isError).not.toBe(true);
      return result;
    };

    const first = await call(agentFoldMcpToolNames.openSession, {
      client: "codex-desktop",
      agent: "codex",
      target: "codex",
      resumeFormat: "json",
    });
    expect(resultEnvelope(first).status).toBe("no_active_task");
    const firstSessionId = String(resultData(first).sessionId);
    const started = await call(agentFoldMcpToolNames.beginTask, {
      sessionId: firstSessionId,
      title: "Implement fixture MCP workflow",
      objective: "Exercise continuity without changing Git history",
    });
    expect(String(resultData(started).taskId)).toMatch(/^AF-\d{8}-\d{3}$/u);
    await call(agentFoldMcpToolNames.reportProgress, {
      sessionId: firstSessionId,
      completed: ["Connected through official MCP client"],
      decisions: [{ decision: "Use stdio", reason: "Keep the integration local" }],
      validation: [{ command: "pnpm test", status: "passed", summary: "Fixture passed" }],
    });
    await call(agentFoldMcpToolNames.createCheckpoint, { sessionId: firstSessionId });
    const resume = await call(agentFoldMcpToolNames.getResumePacket, {
      sessionId: firstSessionId,
      target: "codex",
      format: "json",
    });
    const resumePacket = resultData(resume).packet as Record<string, unknown>;
    expect((resumePacket.observedGitState as Record<string, unknown>).changedPaths).toBeDefined();
    expect((resumePacket.semanticState as Record<string, unknown>).completed).toContain(
      "Connected through official MCP client",
    );
    await call(agentFoldMcpToolNames.closeSession, {
      sessionId: firstSessionId,
      finalReport: { completed: ["Completed stdio workflow"] },
      createCheckpoint: true,
      returnResumePacket: true,
    });
    const second = await call(agentFoldMcpToolNames.openSession, {
      client: "antigravity-ide",
      agent: "antigravity",
      target: "antigravity",
      resumeFormat: "markdown",
    });
    expect(resultEnvelope(second).status).toBe("resumable");
    expect(String(resultData(second).resumePacket)).toContain("# BriefOnce continuation packet");

    expect(JSON.stringify(responses)).not.toContain("SOURCE_MUST_NOT_LEAK");
    expect(JSON.stringify(responses)).not.toContain(fixture);
    expect(JSON.stringify(responses)).not.toContain("diff --git");
    expect(await git(fixture, "symbolic-ref", "HEAD")).toBe(branchBefore);
    expect(await git(fixture, "diff", "--cached", "--name-only")).toBe(stagedBefore);
    expect((await readdir(path.join(fixture, ".git", "hooks"))).sort()).toEqual(hooksBefore);
    expect(await git(fixture, "remote")).toBe(remotesBefore);
    await expect(readFile(path.join(fixture, ".git", "HEAD"), "utf8")).resolves.toContain(
      branchBefore.replace("refs/heads/", ""),
    );

    await client.close();
    expect(stderr).toContain("MCP stdio server started");
    expect(stderr).not.toContain("SOURCE_MUST_NOT_LEAK");
  }, 60_000);
});
