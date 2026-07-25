import { describe, expect, it } from "vitest";

import { formatDiagnostic } from "../../src/core/diagnostics/format-diagnostic.js";

const warning = {
  code: "AFD004",
  severity: "warning" as const,
  message: ".briefonce/config.yaml was not found.",
  suggestion: "This is expected before AgentFold initialization.",
};

describe("formatDiagnostic", () => {
  it("formats predictable text without color", () => {
    const formatted = formatDiagnostic(warning, { color: false });

    expect(formatted).toContain("⚠ warning [AFD004]");
    expect(formatted).toContain("Suggestion:");
    expect(formatted).not.toContain("\u001B[");
  });

  it("adds ANSI color codes when color is enabled", () => {
    expect(formatDiagnostic(warning, { color: true })).toContain("\u001B[");
  });
});
