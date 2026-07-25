import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "../../src/core/filesystem/node-filesystem.js";
import { FilesystemGitRepositoryLocator } from "../../src/core/git/filesystem-git-repository-locator.js";
import {
  decodeMcpFileRootUri,
  McpWorkspaceResolver,
} from "../../src/integrations/mcp/workspace-resolver.js";
import { runMcpServer } from "../../src/integrations/mcp/run-mcp-server.js";
import { agentFoldMcpToolNames } from "../../src/integrations/mcp/tool-names.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP dynamic workspace resolution", () => {
  it("decodes portable file roots including spaces, Unicode, and Windows drives", () => {
    expect(decodeMcpFileRootUri("file:///tmp/AgentFold%20%E2%9C%93", "linux")).toBe(
      "/tmp/AgentFold ✓",
    );
    expect(decodeMcpFileRootUri("file:///C:/Work/AgentFold%20Repo", "win32")).toBe(
      "C:\\Work\\AgentFold Repo",
    );
    expect(() => decodeMcpFileRootUri("https://example.test/repo", "linux")).toThrow(/file:\/\//u);
    expect(() => decodeMcpFileRootUri("file:///tmp/a%2Fb", "linux")).toThrow(/separators/u);
  });

  it("resolves and deduplicates one initialized repository from roots", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold roots with spaces ",
    });
    const resolver = new McpWorkspaceResolver({
      mode: "roots",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
    });
    resolver.setRootsProvider(() =>
      Promise.resolve({
        supported: true,
        roots: [
          { uri: pathToFileURL(fixture.root).toString() },
          { uri: pathToFileURL(fixture.workingDirectory).toString() },
        ],
      }),
    );
    const result = await resolver.resolve();
    expect(result).toMatchObject({ status: "resolved", source: "roots" });
    expect(resolver.lockedRepositoryRoot).toBe(await fixture.fileSystem.realPath(fixture.root));
  });

  it("rejects multiple initialized root repositories without guessing", async () => {
    const first = await createContinuityFixture(temporaryDirectories);
    const second = await createContinuityFixture(temporaryDirectories);
    const resolver = new McpWorkspaceResolver({
      mode: "auto",
      fileSystem: first.fileSystem,
      gitRepositoryLocator: first.gitRepositoryLocator,
    });
    resolver.setRootsProvider(() =>
      Promise.resolve({
        supported: true,
        roots: [
          { uri: pathToFileURL(first.root).toString() },
          { uri: pathToFileURL(second.root).toString() },
        ],
      }),
    );
    const result = await resolver.resolve();
    expect(result.status).toBe("error");
    expect(result.diagnostics.some((item) => item.code === "AFMCP019")).toBe(true);
  });

  it("falls back to cwd in auto mode but roots-only fails when roots are unsupported", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const auto = new McpWorkspaceResolver({
      mode: "auto",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
    });
    auto.setRootsProvider(() => Promise.resolve({ supported: false }));
    expect(await auto.resolve()).toMatchObject({ status: "resolved", source: "cwd" });

    const roots = new McpWorkspaceResolver({
      mode: "roots",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
    });
    roots.setRootsProvider(() => Promise.resolve({ supported: false }));
    expect(await roots.resolve()).toMatchObject({ status: "error" });
  });

  it("lets an explicit workspace win and rejects outside-Git, uninitialized, and malformed roots", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const explicit = new McpWorkspaceResolver({
      mode: "roots",
      workspace: fixture.workingDirectory,
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
    });
    explicit.setRootsProvider(() =>
      Promise.resolve({ supported: true, roots: [{ uri: "file:///not-selected" }] }),
    );
    expect(await explicit.resolve()).toMatchObject({ status: "resolved", source: "explicit" });

    const outside = await mkdtemp(path.join(os.tmpdir(), "agentfold outside git "));
    temporaryDirectories.push(outside);
    const outsideFileSystem = new NodeFileSystem(() => outside);
    const outsideResolver = new McpWorkspaceResolver({
      mode: "roots",
      fileSystem: outsideFileSystem,
      gitRepositoryLocator: new FilesystemGitRepositoryLocator(outsideFileSystem),
    });
    outsideResolver.setRootsProvider(() =>
      Promise.resolve({ supported: true, roots: [{ uri: pathToFileURL(outside).toString() }] }),
    );
    expect(await outsideResolver.resolve()).toMatchObject({ status: "error" });

    await fixture.fileSystem.remove(path.join(fixture.root, ".briefonce", "config.yaml"));
    const invalid = new McpWorkspaceResolver({
      mode: "roots",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
    });
    invalid.setRootsProvider(() =>
      Promise.resolve({ supported: true, roots: [{ uri: "file:///bad%2Fseparator" }] }),
    );
    expect(await invalid.resolve()).toMatchObject({ status: "error" });
  });

  it("canonicalizes a symlinked root and rejects a cwd outside an initialized repository", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories);
    const links = await mkdtemp(path.join(os.tmpdir(), "agentfold root links "));
    temporaryDirectories.push(links);
    const link = path.join(links, "workspace-link");
    await symlink(fixture.root, link, process.platform === "win32" ? "junction" : "dir");
    const linked = new McpWorkspaceResolver({
      mode: "roots",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
    });
    linked.setRootsProvider(() =>
      Promise.resolve({ supported: true, roots: [{ uri: pathToFileURL(link).toString() }] }),
    );
    expect(await linked.resolve()).toMatchObject({
      status: "resolved",
      repositoryRoot: await fixture.fileSystem.realPath(fixture.root),
    });

    const outside = await mkdtemp(path.join(os.tmpdir(), "agentfold cwd outside "));
    temporaryDirectories.push(outside);
    const fileSystem = new NodeFileSystem(() => outside);
    const cwd = new McpWorkspaceResolver({
      mode: "cwd",
      fileSystem,
      gitRepositoryLocator: new FilesystemGitRepositoryLocator(fileSystem),
    });
    expect(await cwd.resolve()).toMatchObject({ status: "error" });
  });

  it("locks after first resolution and warns instead of switching on roots change", async () => {
    const first = await createContinuityFixture(temporaryDirectories);
    const second = await createContinuityFixture(temporaryDirectories);
    let selected = first.root;
    const resolver = new McpWorkspaceResolver({
      mode: "roots",
      fileSystem: first.fileSystem,
      gitRepositoryLocator: first.gitRepositoryLocator,
    });
    resolver.setRootsProvider(() =>
      Promise.resolve({ supported: true, roots: [{ uri: pathToFileURL(selected).toString() }] }),
    );
    await resolver.resolve();
    selected = second.root;
    expect(await resolver.resolve()).toMatchObject({
      repositoryRoot: await first.fileSystem.realPath(first.root),
    });
    expect(await resolver.inspectRootsAfterLock()).toMatchObject({ code: "AFMCP021" });
  });

  it("serves all nine tools after lazy roots selection without exposing the root", async () => {
    const fixture = await createContinuityFixture(temporaryDirectories, {
      name: "agentfold lazy MCP roots ",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "roots-test", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(fixture.root).toString(), name: "fixture" }],
    }));
    const running = runMcpServer({
      workspaceMode: "auto",
      version: "0.0.0-test",
      fileSystem: fixture.fileSystem,
      gitRepositoryLocator: fixture.gitRepositoryLocator,
      gitInspector: new StubGitInspector(undefined, true),
      logger: { debug: () => undefined, error: () => undefined },
      serviceMode: "disabled",
      transport: serverTransport,
    });
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(9);
    const status = await client.callTool({ name: agentFoldMcpToolNames.getStatus, arguments: {} });
    expect(status.isError).not.toBe(true);
    expect(JSON.stringify(status)).not.toContain(fixture.root);
    await client.close();
    await expect(running).resolves.toBe(0);
  });
});
