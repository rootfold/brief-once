import path from "node:path";

import type { Diagnostic } from "../../core/diagnostics/diagnostic.js";

function replaceAllCaseInsensitive(value: string, search: string, replacement: string): string {
  if (search.length === 0) return value;
  return value.replace(
    new RegExp(search.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"),
    replacement,
  );
}

export function sanitizeMcpDiagnostics(
  diagnostics: readonly Diagnostic[],
  repositoryRoot: string,
): readonly Diagnostic[] {
  const portableRoot = repositoryRoot.replaceAll("\\", "/");
  return diagnostics.map((diagnostic) => {
    const sanitize = (value: string): string => {
      const nativeSanitized = replaceAllCaseInsensitive(value, repositoryRoot, ".");
      return replaceAllCaseInsensitive(nativeSanitized.replaceAll("\\", "/"), portableRoot, ".");
    };
    return {
      ...diagnostic,
      message: sanitize(diagnostic.message),
      ...(diagnostic.suggestion === undefined
        ? {}
        : { suggestion: sanitize(diagnostic.suggestion) }),
    };
  });
}

export function safeUnexpectedDiagnostic(): Diagnostic {
  return {
    code: "AFMCP014",
    severity: "error",
    message: "BriefOnce could not complete the tool operation safely.",
    suggestion: "Review safe stderr diagnostics in debug mode and retry.",
  };
}

export function safeDebugMessage(error: unknown, repositoryRoot?: string): string {
  const message = error instanceof Error ? error.message : "Unknown failure";
  if (repositoryRoot === undefined) return message;
  return (
    sanitizeMcpDiagnostics(
      [{ code: "AFMCP014", severity: "error", message }],
      path.resolve(repositoryRoot),
    )[0]?.message ?? "Unknown failure"
  );
}
