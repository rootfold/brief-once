import { describe, expect, it } from "vitest";

import {
  AntigravityConfigSyntaxError,
  prepareAntigravityConfigEdit,
  prepareAntigravityConfigRemoval,
  readAntigravityAgentFoldEntry,
} from "../../src/integrations/connectors/antigravity/antigravity-config.js";
import {
  createAntigravityMcpEntry,
  fingerprintAntigravityMcpEntry,
} from "../../src/integrations/connectors/antigravity/antigravity-launch-entry.js";
import {
  agentFoldAntigravityContinuityRule,
  antigravityContinuityRule,
  antigravityRuleOwnershipMarker,
  fingerprintAntigravityRule,
  prepareAntigravityRule,
  previousAntigravityContinuityRule,
  previousAntigravityRuleOwnershipMarker,
} from "../../src/integrations/connectors/antigravity/antigravity-rule.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const descriptor = {
  command: "C:\\Program Files\\nodejs\\node.exe",
  argsPrefix: ["C:\\AgentFold build\\dist\\cli.js"],
  fingerprint: "a".repeat(64),
};
const entry = createAntigravityMcpEntry(descriptor);

function text(
  result: Extract<ReturnType<typeof prepareAntigravityConfigEdit>, { status: "ready" }>,
) {
  return decoder.decode(result.bytes);
}

describe("Antigravity configuration editing", () => {
  it("creates the documented local stdio entry with argument arrays", () => {
    const result = prepareAntigravityConfigEdit(undefined, entry);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(JSON.parse(text(result))).toEqual({ mcpServers: { agentfold: entry } });
    expect(text(result)).toMatch(/\n$/u);
    expect(entry.args).toEqual([
      "C:\\AgentFold build\\dist\\cli.js",
      "mcp",
      "--service",
      "required",
      "--ensure-service",
      "--workspace-mode",
      "auto",
    ]);
    expect(entry.command).not.toBe("npx");
  });

  it("accepts an existing empty file without inventing unrelated fields", () => {
    const result = prepareAntigravityConfigEdit(new Uint8Array(), entry);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(JSON.parse(text(result))).toEqual({ mcpServers: { agentfold: entry } });
    expect(text(result).endsWith("\n")).toBe(false);
  });

  it("preserves unrelated fields, MCP entries, OAuth values, and header text", () => {
    const secret = "FAKE_SECRET_MUST_REMAIN_EXACT";
    const source = `{
    "theme": "dark",
    "mcpServers": {
        "private": { "serverUrl": "https://example.test", "headers": { "Authorization": "${secret}" }, "oauth": { "clientSecret": "keep-me" } }
    },
    "unknown": { "number": 1e3 }
}`;
    const result = prepareAntigravityConfigEdit(encoder.encode(source), entry);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const updated = text(result);
    expect(updated).toContain(`"Authorization": "${secret}"`);
    expect(updated).toContain('"clientSecret": "keep-me"');
    expect(updated).toContain('"number": 1e3');
    expect(updated.indexOf('"private"')).toBeLessThan(updated.indexOf('"agentfold"'));
    expect(readAntigravityAgentFoldEntry(result.bytes)).toEqual(entry);
  });

  it.each([
    ["BOM and CRLF", `\uFEFF{\r\n\t"mcpServers": {}\r\n}\r\n`, true, "\r\n"],
    ["LF", `{\n  "mcpServers": {}\n}\n`, false, "\n"],
    ["no final newline", `{"mcpServers":{}}`, false, "\n"],
  ])("preserves %s formatting boundaries", (_name, source, hasBom, eol) => {
    const result = prepareAntigravityConfigEdit(encoder.encode(source), entry);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const updated = text(result);
    expect(Array.from(result.bytes.slice(0, 3))).toEqual(
      hasBom ? [0xef, 0xbb, 0xbf] : Array.from(new TextEncoder().encode(updated).slice(0, 3)),
    );
    expect(updated.includes(eol)).toBe(true);
    expect(updated.endsWith(eol)).toBe(source.endsWith(eol));
  });

  it("is idempotent for an identical entry", () => {
    const first = prepareAntigravityConfigEdit(undefined, entry);
    if (first.status !== "ready") throw new Error("Expected edit");
    const second = prepareAntigravityConfigEdit(first.bytes, entry);
    expect(second).toMatchObject({ status: "ready", action: "identical" });
    if (second.status === "ready") expect(second.bytes).toEqual(first.bytes);
  });

  it("rejects a user-owned collision and updates only a proven older entry", () => {
    const oldEntry = { command: "node", args: ["old.js", "mcp"] };
    const bytes = encoder.encode(JSON.stringify({ mcpServers: { agentfold: oldEntry, keep: {} } }));
    const collision = prepareAntigravityConfigEdit(bytes, entry);
    expect(collision.status).toBe("collision");
    const update = prepareAntigravityConfigEdit(bytes, entry, [
      fingerprintAntigravityMcpEntry(oldEntry),
    ]);
    expect(update).toMatchObject({ status: "ready", action: "update" });
    if (update.status === "ready") {
      expect(readAntigravityAgentFoldEntry(update.bytes)).toEqual(entry);
      expect(decoder.decode(update.bytes)).toContain('"keep"');
    }
  });

  it("removes only the fingerprint-matched entry", () => {
    const installed = prepareAntigravityConfigEdit(
      encoder.encode('{"mcpServers":{"keep":{"command":"safe"}}}'),
      entry,
    );
    if (installed.status !== "ready") throw new Error("Expected edit");
    const removed = prepareAntigravityConfigRemoval(
      installed.bytes,
      fingerprintAntigravityMcpEntry(entry),
    );
    expect(removed.status).toBe("ready");
    if (removed.status !== "ready") return;
    expect(JSON.parse(decoder.decode(removed.bytes))).toEqual({
      mcpServers: { keep: { command: "safe" } },
    });
  });

  it.each([
    "{",
    "[]",
    '{"mcpServers": null}',
    '{// unsupported\n"mcpServers":{}}',
    '{/* unsupported */"mcpServers":{}}',
    '{"mcpServers":{},"mcpServers":{}}',
    '{"mcpServers":{"agentfold":{},"agentfold":{}}}',
  ])("rejects malformed or unsupported JSON safely: %s", (source) => {
    expect(() => prepareAntigravityConfigEdit(encoder.encode(source), entry)).toThrow(
      AntigravityConfigSyntaxError,
    );
  });
});

describe("Antigravity continuity rule", () => {
  it("is deterministic, owned, concise, and enforces safe lifecycle boundaries", () => {
    expect(antigravityContinuityRule).toContain(antigravityRuleOwnershipMarker);
    expect(antigravityContinuityRule).toContain("agentfold_open_session");
    expect(antigravityContinuityRule).toContain("agentfold_report_progress");
    expect(antigravityContinuityRule).toContain("agentfold_finish_task");
    expect(antigravityContinuityRule).toContain("agentfold_close_session");
    expect(antigravityContinuityRule).toContain("conceptual questions");
    expect(antigravityContinuityRule).toContain("private chain of thought");
    expect(antigravityContinuityRule).toContain("Never discard uncommitted work");
    expect(antigravityContinuityRule.length).toBeLessThan(12_000);
    expect(prepareAntigravityRule(undefined)).toMatchObject({ action: "create" });
    expect(prepareAntigravityRule(antigravityContinuityRule)).toMatchObject({
      action: "identical",
    });
    const crlfRule = antigravityContinuityRule.replace(/\n/gu, "\r\n");
    expect(fingerprintAntigravityRule(crlfRule)).toBe(
      fingerprintAntigravityRule(antigravityContinuityRule),
    );
    expect(prepareAntigravityRule(crlfRule)).toMatchObject({ action: "identical" });
    for (const legacy of [
      agentFoldAntigravityContinuityRule,
      agentFoldAntigravityContinuityRule.replace(/\n/gu, "\r\n"),
      previousAntigravityContinuityRule,
      previousAntigravityContinuityRule.replace(/\n/gu, "\r\n"),
      previousAntigravityContinuityRule.replace(/\n/gu, "\r"),
    ]) {
      expect(prepareAntigravityRule(legacy)).toMatchObject({ action: "update" });
    }
    const previous = `${previousAntigravityRuleOwnershipMarker}\n# Previous owned rule\n`;
    expect(prepareAntigravityRule(previous, [fingerprintAntigravityRule(previous)])).toMatchObject({
      action: "update",
    });
  });

  it("preserves user-created and manually modified rule files", () => {
    expect(prepareAntigravityRule("# My rule\n").status).toBe("collision");
    expect(prepareAntigravityRule(`${antigravityRuleOwnershipMarker}\n# modified\n`).status).toBe(
      "collision",
    );
    expect(
      prepareAntigravityRule(
        agentFoldAntigravityContinuityRule.replace(
          "Use AgentFold for substantive coding work",
          "Use AgentFold for every message",
        ),
      ).status,
    ).toBe("collision");
    expect(
      prepareAntigravityRule(
        previousAntigravityContinuityRule.replace(
          "Never discard uncommitted work",
          "Discard uncommitted work",
        ),
      ).status,
    ).toBe("collision");
  });
});
