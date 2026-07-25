import { rm } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentFoldMcpServer,
  agentFoldMcpInstructions,
} from "../../src/integrations/mcp/create-mcp-server.js";
import { createMcpApplicationContext } from "../../src/integrations/mcp/mcp-context.js";
import { runMcpServer, type McpSignalSource } from "../../src/integrations/mcp/run-mcp-server.js";
import { InMemorySessionRegistry } from "../../src/integrations/mcp/session-registry.js";
import { agentFoldMcpToolNames } from "../../src/integrations/mcp/tool-names.js";
import { createContinuityFixture, StubGitInspector } from "../helpers/continuity-fixture.js";
import packageJson from "../../package.json" with { type: "json" };

const temporaryDirectories: string[] = [];

class FakeSignalSource implements McpSignalSource {
  private readonly listeners = new Map<"SIGINT" | "SIGTERM", Set<() => void>>();

  once(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function connectedServer(generateId: () => string = () => "server-session") {
  const fixture = await createContinuityFixture(temporaryDirectories);
  const context = await createMcpApplicationContext({
    workspace: fixture.root,
    version: "1.2.3-test",
    fileSystem: fixture.fileSystem,
    gitRepositoryLocator: fixture.gitRepositoryLocator,
    gitInspector: new StubGitInspector(undefined, true),
    sessions: new InMemorySessionRegistry({
      now: () => new Date("2026-07-21T01:00:00.000Z"),
      generateId,
    }),
    logger: { debug: () => undefined, error: () => undefined },
  });
  if (context.status !== "success") throw new Error("Expected MCP context");
  const server = createAgentFoldMcpServer({ context: context.context });
  const client = new Client({ name: "agentfold-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { fixture, server, client };
}

describe("AgentFold MCP server", () => {
  it("advertises stable identity, instructions, nine tools, and no resources or prompts", async () => {
    expect(packageJson.dependencies["@modelcontextprotocol/sdk"]).toBe("1.29.0");
    const { server, client } = await connectedServer();
    expect(client.getServerVersion()).toEqual({ name: "agentfold", version: "1.2.3-test" });
    expect(client.getInstructions()).toBe(agentFoldMcpInstructions);
    expect(client.getInstructions()).toContain("agentfold_open_session");
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeUndefined();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
      Object.values(agentFoldMcpToolNames).sort(),
    );
    expect(tools.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    expect(tools.tools.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
    await client.close();
    await server.close();
  });

  it("returns safe structured tool and validation errors without stopping the server", async () => {
    const { fixture, server, client } = await connectedServer(() => "same-session");
    const status = await client.callTool({ name: agentFoldMcpToolNames.getStatus, arguments: {} });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      ok: true,
      operation: agentFoldMcpToolNames.getStatus,
      status: "no_active_task",
    });
    expect(JSON.stringify(status)).not.toContain(fixture.root);

    const invalid = await client.callTool({
      name: agentFoldMcpToolNames.getStatus,
      arguments: { workspace: fixture.root },
    });
    expect(invalid.isError).toBe(true);

    const first = await client.callTool({
      name: agentFoldMcpToolNames.openSession,
      arguments: { client: "test", agent: "codex" },
    });
    expect(first.isError).not.toBe(true);
    const collision = await client.callTool({
      name: agentFoldMcpToolNames.openSession,
      arguments: { client: "test-two", agent: "claude" },
    });
    expect(collision.isError).toBe(true);
    expect(JSON.stringify(collision)).not.toContain("Error:");

    const afterFailure = await client.callTool({
      name: agentFoldMcpToolNames.getStatus,
      arguments: {},
    });
    expect(afterFailure.isError).not.toBe(true);
    await client.close();
    await server.close();
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "closes cleanly on %s without creating repository state",
    async (signal) => {
      const fixture = await createContinuityFixture(temporaryDirectories);
      const signals = new FakeSignalSource();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "shutdown-test", version: "1.0.0" });
      const running = runMcpServer({
        workspace: fixture.root,
        version: "1.2.3-test",
        fileSystem: fixture.fileSystem,
        gitRepositoryLocator: fixture.gitRepositoryLocator,
        gitInspector: new StubGitInspector(undefined, true),
        logger: { debug: () => undefined, error: () => undefined },
        signalSource: signals,
        transport: serverTransport,
        serviceMode: "disabled",
      });
      await client.connect(clientTransport);
      signals.emit(signal);
      await expect(running).resolves.toBe(0);
      expect(
        await fixture.fileSystem.exists(
          path.join(fixture.root, ".briefonce", "state", "current.md"),
        ),
      ).toBe(false);
      await client.close();
    },
  );
});
