import { createHash } from "node:crypto";

const startPrefix = "<!-- agentfold:codex:start schema=";
const endMarker = "<!-- agentfold:codex:end -->";

interface TextDocument {
  readonly source: string;
  readonly hasBom: boolean;
  readonly lineEnding: "\n" | "\r\n";
  readonly hadFinalNewline: boolean;
}

interface LineSpan {
  readonly text: string;
  readonly start: number;
  readonly textEnd: number;
  readonly end: number;
}

interface ManagedRegion {
  readonly start: number;
  readonly textEnd: number;
  readonly end: number;
  readonly text: string;
}

export type CodexAgentsEditResult =
  | {
      readonly status: "ready";
      readonly action: "create" | "append" | "update" | "identical";
      readonly bytes: Uint8Array;
      readonly regionFingerprint: string;
    }
  | { readonly status: "collision"; readonly reason: string };

export type CodexAgentsRemovalResult =
  | { readonly status: "ready"; readonly changed: boolean; readonly bytes: Uint8Array }
  | { readonly status: "collision"; readonly reason: string };

function decode(bytes: Uint8Array | undefined): TextDocument {
  if (bytes === undefined) {
    return { source: "", hasBom: false, lineEnding: "\n", hadFinalNewline: true };
  }
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? bytes.slice(3) : bytes);
  } catch {
    throw new Error("AGENTS.md is not valid UTF-8.");
  }
  return {
    source,
    hasBom,
    lineEnding: source.includes("\r\n") ? "\r\n" : "\n",
    hadFinalNewline: source.endsWith("\n"),
  };
}

function encode(document: TextDocument, source: string): Uint8Array {
  const content = new TextEncoder().encode(source);
  if (!document.hasBom) return content;
  const bytes = new Uint8Array(content.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(content, 3);
  return bytes;
}

function lines(source: string): readonly LineSpan[] {
  const result: LineSpan[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline + 1;
    const textEnd =
      newline === -1
        ? source.length
        : newline > start && source[newline - 1] === "\r"
          ? newline - 1
          : newline;
    result.push({ text: source.slice(start, textEnd), start, textEnd, end });
    start = end;
  }
  return result;
}

function locateRegion(source: string): ManagedRegion | undefined | "malformed" {
  const sourceLines = lines(source);
  const starts = sourceLines.filter((line) => line.text.startsWith(startPrefix));
  const ends = sourceLines.filter((line) => line.text === endMarker);
  if (starts.length === 0 && ends.length === 0) {
    return source.includes("agentfold:codex:start") || source.includes("agentfold:codex:end")
      ? "malformed"
      : undefined;
  }
  if (starts.length !== 1 || ends.length !== 1) return "malformed";
  const versionText = starts[0]!.text.slice(startPrefix.length, -" -->".length);
  if (
    !starts[0]!.text.endsWith(" -->") ||
    !/^\d+$/u.test(versionText) ||
    starts[0]!.start >= ends[0]!.start
  ) {
    return "malformed";
  }
  return {
    start: starts[0]!.start,
    textEnd: ends[0]!.textEnd,
    end: ends[0]!.end,
    text: source.slice(starts[0]!.start, ends[0]!.textEnd),
  };
}

const instructionLines = [
  "## BriefOnce continuity for Codex",
  "",
  "- Use BriefOnce for substantive repository-changing work.",
  "- BriefOnce currently exposes compatibility MCP tools using the `agentfold_*` namespace.",
  "- Before modifying files, call `agentfold_open_session` and continue a relevant active task.",
  "- Call `agentfold_begin_task` only when no relevant active task exists; do not create tasks for simple questions or read-only inspection.",
  "- After meaningful milestones, call `agentfold_report_progress` with concise engineering conclusions only.",
  "- Call `agentfold_finish_task` when the requested scope is fully complete, blockers are resolved, and final validation is honestly reported.",
  "- Call `agentfold_close_session` with checkpointing when work is paused, incomplete, blocked, uncertain, or handed off; do not finish merely because context or usage limits were reached.",
  "- After finishing, keep the session open and call `agentfold_begin_task` for the next substantive unrelated request.",
  "- Preserve uncommitted work and avoid repeated failed approaches identified by continuation packets.",
  "- Treat reused or absent semantic context cautiously and verify assumptions against the repository.",
  "- Never report private chain of thought, complete conversations, secrets, or environment values.",
  "- Never commit, push, discard work, or replace an unrelated active task without the user's confirmation.",
];

const agentFoldInstructionLines = [
  "## AgentFold continuity for Codex",
  "",
  "- Use AgentFold for substantive repository-changing work.",
  "- Before modifying files, call `agentfold_open_session` and continue a relevant active task.",
  "- Call `agentfold_begin_task` only when no relevant active task exists; do not create tasks for simple questions or read-only inspection.",
  "- After meaningful milestones, call `agentfold_report_progress` with concise engineering conclusions only.",
  "- Call `agentfold_finish_task` when the requested scope is fully complete, blockers are resolved, and final validation is honestly reported.",
  "- Call `agentfold_close_session` with checkpointing when work is paused, incomplete, blocked, uncertain, or handed off; do not finish merely because context or usage limits were reached.",
  "- After finishing, keep the session open and call `agentfold_begin_task` for the next substantive unrelated request.",
  "- Preserve uncommitted work and avoid repeated failed approaches identified by continuation packets.",
  "- Treat reused or absent semantic context cautiously and verify assumptions against the repository.",
  "- Never report private chain of thought, complete conversations, secrets, or environment values.",
  "- Never commit, push, discard work, or replace an unrelated active task without the user's confirmation.",
];

const previousInstructionLines = [
  "## AgentFold continuity for Codex",
  "",
  "- Use AgentFold for substantive repository-changing work.",
  "- Before modifying files, call `agentfold_open_session` and continue a relevant active task.",
  "- Call `agentfold_begin_task` only when no relevant active task exists; do not create tasks for simple questions or read-only inspection.",
  "- After meaningful milestones, call `agentfold_report_progress` with concise engineering conclusions only.",
  "- Before ending substantial work, call `agentfold_close_session`, include a concise final report, and leave checkpoint creation enabled.",
  "- Preserve uncommitted work and avoid repeated failed approaches identified by continuation packets.",
  "- Treat reused or absent semantic context cautiously and verify assumptions against the repository.",
  "- Never report private chain of thought, complete conversations, secrets, or environment values.",
  "- Never commit, push, discard work, or replace an unrelated active task without the user's confirmation.",
];

export function renderCodexAgentsRegion(
  lineEnding: "\n" | "\r\n" = "\n",
  schemaVersion = 3,
): string {
  return [`${startPrefix}${schemaVersion} -->`, ...instructionLines, endMarker].join(lineEnding);
}

export function renderAgentFoldCodexAgentsRegion(lineEnding: "\n" | "\r\n" = "\n"): string {
  return [`${startPrefix}2 -->`, ...agentFoldInstructionLines, endMarker].join(lineEnding);
}

export function renderLegacyCodexAgentsRegion(lineEnding: "\n" | "\r\n" = "\n"): string {
  return [
    `${startPrefix}0 -->`,
    "## AgentFold continuity for Codex",
    "",
    "Use AgentFold MCP lifecycle tools for substantial repository work.",
    endMarker,
  ].join(lineEnding);
}

export function renderPreviousCodexAgentsRegion(lineEnding: "\n" | "\r\n" = "\n"): string {
  return [`${startPrefix}1 -->`, ...previousInstructionLines, endMarker].join(lineEnding);
}

export function fingerprintCodexAgentsRegion(region: string): string {
  return createHash("sha256").update(region, "utf8").digest("hex");
}

function appendRegion(document: TextDocument, region: string): string {
  if (document.source.length === 0) return `${region}${document.lineEnding}`;
  const separator = document.hadFinalNewline
    ? document.lineEnding
    : `${document.lineEnding}${document.lineEnding}`;
  return `${document.source}${separator}${region}${document.hadFinalNewline ? document.lineEnding : ""}`;
}

export function prepareCodexAgentsEdit(
  original: Uint8Array | undefined,
  provenFingerprints: readonly string[] = [],
): CodexAgentsEditResult {
  const document = decode(original);
  const region = locateRegion(document.source);
  if (region === "malformed") {
    return {
      status: "collision",
      reason: "AGENTS.md has malformed or duplicate AgentFold markers.",
    };
  }
  const expected = renderCodexAgentsRegion(document.lineEnding);
  const expectedFingerprint = fingerprintCodexAgentsRegion(expected);
  const legacyFingerprint = fingerprintCodexAgentsRegion(
    renderLegacyCodexAgentsRegion(document.lineEnding),
  );
  const previousFingerprint = fingerprintCodexAgentsRegion(
    renderPreviousCodexAgentsRegion(document.lineEnding),
  );
  const agentFoldFingerprint = fingerprintCodexAgentsRegion(
    renderAgentFoldCodexAgentsRegion(document.lineEnding),
  );
  if (region === undefined) {
    return {
      status: "ready",
      action: original === undefined ? "create" : "append",
      bytes: encode(document, appendRegion(document, expected)),
      regionFingerprint: expectedFingerprint,
    };
  }
  const currentFingerprint = fingerprintCodexAgentsRegion(region.text);
  if (currentFingerprint === expectedFingerprint) {
    return {
      status: "ready",
      action: "identical",
      bytes: encode(document, document.source),
      regionFingerprint: currentFingerprint,
    };
  }
  if (
    !provenFingerprints.includes(currentFingerprint) &&
    currentFingerprint !== legacyFingerprint &&
    currentFingerprint !== previousFingerprint &&
    currentFingerprint !== agentFoldFingerprint
  ) {
    return { status: "collision", reason: "The AgentFold-owned AGENTS.md region was modified." };
  }
  const source = `${document.source.slice(0, region.start)}${expected}${document.source.slice(region.textEnd)}`;
  return {
    status: "ready",
    action: "update",
    bytes: encode(document, source),
    regionFingerprint: expectedFingerprint,
  };
}

export function prepareCodexAgentsRemoval(
  original: Uint8Array,
  expectedFingerprint: string,
): CodexAgentsRemovalResult {
  const document = decode(original);
  const region = locateRegion(document.source);
  if (region === "malformed") {
    return {
      status: "collision",
      reason: "AGENTS.md has malformed or duplicate AgentFold markers.",
    };
  }
  if (region === undefined) return { status: "ready", changed: false, bytes: original };
  if (fingerprintCodexAgentsRegion(region.text) !== expectedFingerprint) {
    return { status: "collision", reason: "The AgentFold-owned AGENTS.md region was modified." };
  }
  let prefix = document.source.slice(0, region.start);
  const suffix = document.source.slice(region.end);
  if (prefix.endsWith(`${document.lineEnding}${document.lineEnding}`)) {
    prefix = prefix.slice(0, -document.lineEnding.length);
  }
  if (!document.hadFinalNewline && suffix.length === 0 && prefix.endsWith(document.lineEnding)) {
    prefix = prefix.slice(0, -document.lineEnding.length);
  }
  return { status: "ready", changed: true, bytes: encode(document, `${prefix}${suffix}`) };
}

export function readCodexAgentsRegion(bytes: Uint8Array): string | undefined {
  const region = locateRegion(decode(bytes).source);
  if (region === "malformed")
    throw new Error("AGENTS.md has malformed or duplicate AgentFold markers.");
  return region?.text;
}
