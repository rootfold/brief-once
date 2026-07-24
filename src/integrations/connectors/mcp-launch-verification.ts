import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { agentFoldMcpToolNames } from "../mcp/tool-names.js";
import type { LaunchDescriptor } from "./connector-types.js";

export interface AgentFoldMcpLaunchVerification {
  readonly toolsAvailable: number;
  readonly statusVerified: boolean;
}

function filteredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export async function launchAgentFoldMcpWithOfficialClient(input: {
  readonly descriptor: LaunchDescriptor;
  readonly repositoryRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly clientName: string;
}): Promise<AgentFoldMcpLaunchVerification> {
  const transport = new StdioClientTransport({
    command: input.descriptor.command,
    args: [
      ...input.descriptor.argsPrefix,
      "mcp",
      "--service",
      "required",
      "--ensure-service",
      "--workspace-mode",
      "auto",
    ],
    cwd: input.repositoryRoot,
    env: filteredEnvironment(input.environment),
    stderr: "pipe",
  });
  const client = new Client(
    { name: input.clientName, version: "1.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: [
      {
        uri: pathToFileURL(input.repositoryRoot).toString(),
        name: "BriefOnce workspace",
      },
    ],
  }));
  try {
    await client.connect(transport, { signal: AbortSignal.timeout(10_000) });
    const listed = await client.listTools(undefined, { signal: AbortSignal.timeout(10_000) });
    const names = listed.tools.map((tool) => tool.name).sort();
    const expected = Object.values(agentFoldMcpToolNames).sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error("The configured MCP server did not expose all BriefOnce lifecycle tools.");
    }
    const status = await client.callTool(
      { name: agentFoldMcpToolNames.getStatus, arguments: {} },
      undefined,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (status.isError === true) {
      throw new Error("The configured MCP server rejected agentfold_get_status.");
    }
    return { toolsAvailable: names.length, statusVerified: true };
  } finally {
    await client.close().catch(() => undefined);
  }
}
