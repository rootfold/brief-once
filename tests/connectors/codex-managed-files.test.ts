import { describe, expect, it } from "vitest";

import {
  fingerprintCodexAgentsRegion,
  prepareCodexAgentsEdit,
  prepareCodexAgentsRemoval,
  renderCodexAgentsRegion,
  renderAgentFoldCodexAgentsRegion,
  renderLegacyCodexAgentsRegion,
  renderPreviousCodexAgentsRegion,
} from "../../src/integrations/connectors/codex/codex-agents.js";
import { createCodexMcpEntry } from "../../src/integrations/connectors/codex/codex-launch-entry.js";
import {
  CodexConfigSyntaxError,
  fingerprintCodexRegion,
  prepareCodexTomlEdit,
  prepareCodexTomlRemoval,
  readCodexAgentFoldEntry,
  renderCodexMcpRegion,
  renderLegacyCodexMcpRegion,
} from "../../src/integrations/connectors/codex/codex-toml.js";

const descriptor = {
  command: "C:\\Program Files\\nodejs\\node.exe",
  argsPrefix: ["C:\\Program Files\\AgentFold\\dist\\cli.js"],
  fingerprint: "a".repeat(64),
} as const;
const entry = createCodexMcpEntry(descriptor);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(source: string, bom = false): Uint8Array {
  const content = encoder.encode(source);
  if (!bom) return content;
  const result = new Uint8Array(content.length + 3);
  result.set([0xef, 0xbb, 0xbf]);
  result.set(content, 3);
  return result;
}

function text(content: Uint8Array): string {
  return decoder.decode(content).replace(/^\uFEFF/u, "");
}

describe("Codex managed configuration files", () => {
  it("creates minimal TOML with the exact shell-free global launch", () => {
    const result = prepareCodexTomlEdit(undefined, entry);
    expect(result).toMatchObject({ status: "ready", action: "create" });
    if (result.status !== "ready") return;
    expect(readCodexAgentFoldEntry(result.bytes)).toEqual(entry);
    expect(text(result.bytes)).toContain("[mcp_servers.agentfold]");
    expect(text(result.bytes)).not.toContain("npx");
  });

  it.each([
    ["LF with final newline", "\n", true, false],
    ["CRLF without final newline", "\r\n", false, false],
    ["UTF-8 BOM", "\r\n", true, true],
  ] as const)(
    "preserves comments, fake secrets, %s, and final-newline behavior",
    (_name, eol, final, bom) => {
      const original = `# user comment${eol}model = "gpt-test"${eol}[provider]${eol}token = "FAKE_SECRET_CODEX_TEST"${final ? eol : ""}`;
      const result = prepareCodexTomlEdit(bytes(original, bom), entry);
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      const updated = text(result.bytes);
      expect(updated.startsWith(original)).toBe(true);
      expect(updated).toContain("FAKE_SECRET_CODEX_TEST");
      expect(updated.endsWith(eol)).toBe(final);
      expect(Array.from(result.bytes.slice(0, 3))).toEqual(
        bom ? [0xef, 0xbb, 0xbf] : Array.from(result.bytes.slice(0, 3)),
      );
    },
  );

  it("treats identical regions idempotently and updates a known legacy region", () => {
    const current = `${renderCodexMcpRegion(entry)}\n`;
    const identical = prepareCodexTomlEdit(bytes(current), entry);
    expect(identical).toMatchObject({ status: "ready", action: "identical" });
    if (identical.status === "ready") expect(text(identical.bytes)).toBe(current);

    const legacy = `${renderLegacyCodexMcpRegion(entry)}\n`;
    const updated = prepareCodexTomlEdit(bytes(legacy), entry);
    expect(updated).toMatchObject({ status: "ready", action: "update" });
    if (updated.status === "ready") expect(readCodexAgentFoldEntry(updated.bytes)).toEqual(entry);
  });

  it.each([
    ["user-owned entry", '[mcp_servers.agentfold]\ncommand = "user-tool"\n'],
    [
      "modified region",
      `${renderCodexMcpRegion(entry).replace("required = true", "required = false")}\n`,
    ],
    ["duplicate regions", `${renderCodexMcpRegion(entry)}\n${renderCodexMcpRegion(entry)}\n`],
  ])("rejects %s without returning replacement bytes", (_name, source) => {
    expect(prepareCodexTomlEdit(bytes(source), entry)).toMatchObject({ status: "collision" });
  });

  it("rejects malformed TOML", () => {
    expect(() => prepareCodexTomlEdit(bytes('model = "unterminated\n'), entry)).toThrow(
      CodexConfigSyntaxError,
    );
  });

  it("removes only a proven TOML region and restores unrelated bytes", () => {
    const original = '# exact user content\r\nsecret = "FAKE_SECRET_CODEX_TEST"';
    const edit = prepareCodexTomlEdit(bytes(original), entry);
    if (edit.status !== "ready") throw new Error("Expected edit");
    const removal = prepareCodexTomlRemoval(edit.bytes, edit.regionFingerprint);
    expect(removal.status).toBe("ready");
    if (removal.status === "ready") expect(text(removal.bytes)).toBe(original);
  });

  it("creates lifecycle-safe AGENTS.md instructions", () => {
    const result = prepareCodexAgentsEdit(undefined);
    expect(result).toMatchObject({ status: "ready", action: "create" });
    if (result.status !== "ready") return;
    const source = text(result.bytes);
    expect(source).toContain("agentfold_open_session");
    expect(source).toContain("agentfold_begin_task");
    expect(source).toContain("agentfold_report_progress");
    expect(source).toContain("agentfold_finish_task");
    expect(source).toContain("agentfold_close_session");
    expect(source).toContain("schema=3");
    expect(source).toContain("BriefOnce continuity for Codex");
    expect(source).toContain("compatibility MCP tools");
    expect(source).toContain("private chain of thought");
    expect(source).toContain("Never commit, push, discard work");
  });

  it("preserves AGENTS.md user bytes and removes only the managed region", () => {
    const original = "# User instructions\r\n\r\nKeep this exact.\r\n";
    const edit = prepareCodexAgentsEdit(bytes(original, true));
    if (edit.status !== "ready") throw new Error("Expected edit");
    expect(text(edit.bytes).startsWith(original)).toBe(true);
    const removal = prepareCodexAgentsRemoval(edit.bytes, edit.regionFingerprint);
    expect(removal.status).toBe("ready");
    if (removal.status === "ready") expect(text(removal.bytes)).toBe(original);
  });

  it("updates a known legacy AGENTS region and rejects modified or duplicate regions", () => {
    const legacy = renderLegacyCodexAgentsRegion();
    expect(prepareCodexAgentsEdit(bytes(legacy))).toMatchObject({
      status: "ready",
      action: "update",
    });
    expect(prepareCodexAgentsEdit(bytes(renderPreviousCodexAgentsRegion()))).toMatchObject({
      status: "ready",
      action: "update",
    });
    expect(prepareCodexAgentsEdit(bytes(renderAgentFoldCodexAgentsRegion()))).toMatchObject({
      status: "ready",
      action: "update",
    });
    const current = renderCodexAgentsRegion();
    const fingerprint = fingerprintCodexAgentsRegion(current);
    expect(fingerprint).toHaveLength(64);
    expect(prepareCodexAgentsEdit(bytes(current.replace("substantive", "all")))).toMatchObject({
      status: "collision",
    });
    expect(prepareCodexAgentsEdit(bytes(`${current}\n${current}`))).toMatchObject({
      status: "collision",
    });
  });

  it("uses stable fingerprints for exact managed TOML bytes", () => {
    expect(fingerprintCodexRegion(renderCodexMcpRegion(entry))).toHaveLength(64);
  });
});
