import { createHash } from "node:crypto";

export const antigravityRuleRelativePath = ".agents/rules/agentfold-continuity.md" as const;
export const antigravityRuleOwnershipMarker = "<!-- agentfold:connector=antigravity schema=3 -->";
export const previousAntigravityRuleOwnershipMarker =
  "<!-- agentfold:connector=antigravity schema=1 -->";
const agentFoldAntigravityRuleOwnershipMarker = "<!-- agentfold:connector=antigravity schema=2 -->";

export const previousAntigravityContinuityRule = `${previousAntigravityRuleOwnershipMarker}
# AgentFold continuity

Use AgentFold for substantive coding work in this workspace.

At the beginning of substantive implementation, debugging, refactoring, test, documentation, or architecture work:

1. Call \`agentfold_open_session\` before modifying files.
2. Read the returned continuation packet or project context and preserve existing uncommitted work.
3. If an active task exists, compare it with the user's request. Continue it when relevant; when unrelated, ask before changing task lifecycle. Do not replace, finish, or duplicate it automatically.
4. If no active task exists and the user requested substantive repository changes, call \`agentfold_begin_task\` with a concise title and objective.
5. Do not create a task for conceptual questions, explanations, read-only inspection, status requests, non-project conversation, or trivial formatting help without repository changes.

During substantial work:

1. Call \`agentfold_report_progress\` after meaningful milestones, not after every edit.
2. Record concise engineering conclusions: completed and current work, decisions, failed attempts, blockers, validation, next actions, and assumptions.
3. Never report private chain of thought, full conversations, source-file contents, environment values, tokens, passwords, or secrets.

Before ending the session or returning control after substantial changes:

1. Call \`agentfold_close_session\` with a final structured report and leave checkpoint creation enabled.
2. Do not claim continuity was recorded when an AgentFold tool failed.
3. Never discard uncommitted work, create commits, or push unless the user separately requested it.

When AgentFold returns a continuation packet, follow its next actions, preserve recorded decisions, avoid repeated failed approaches, and verify absent or stale semantic context before broad changes.
`;

export const agentFoldAntigravityContinuityRule = `${agentFoldAntigravityRuleOwnershipMarker}
# AgentFold continuity

Use AgentFold for substantive coding work in this workspace.

At the beginning of substantive implementation, debugging, refactoring, test, documentation, or architecture work:

1. Call \`agentfold_open_session\` before modifying files.
2. Read the returned continuation packet or project context and preserve existing uncommitted work.
3. If an active task exists, compare it with the user's request. Continue it when relevant; when unrelated, ask before changing task lifecycle. Do not replace, finish, or duplicate it automatically.
4. If no active task exists and the user requested substantive repository changes, call \`agentfold_begin_task\` with a concise title and objective.
5. Do not create a task for conceptual questions, explanations, read-only inspection, status requests, non-project conversation, or trivial formatting help without repository changes.

During substantial work:

1. Call \`agentfold_report_progress\` after meaningful milestones, not after every edit.
2. Record concise engineering conclusions: completed and current work, decisions, failed attempts, blockers, validation, next actions, and assumptions.
3. Never report private chain of thought, full conversations, source-file contents, environment values, tokens, passwords, or secrets.

When the requested scope is fully complete:

1. Call \`agentfold_finish_task\` only after in-progress work and blockers are resolved and required validation is honestly reported.
2. Keep the same session open; call \`agentfold_begin_task\` for the next substantive unrelated request.
3. If the user explicitly says the task is complete, finish it after recording an honest final report.

Before ending work that is paused, incomplete, blocked, uncertain, or being handed off:

1. Call \`agentfold_close_session\` with a final structured progress report and leave checkpoint creation enabled.
2. Do not finish merely because context or usage limits were reached, validation still fails, or the user requested only a checkpoint or handoff.
3. Do not claim continuity was recorded when an AgentFold tool failed.
4. Never discard uncommitted work, create commits, or push unless the user separately requested it.

When AgentFold returns a continuation packet, follow its next actions, preserve recorded decisions, avoid repeated failed approaches, and verify absent or stale semantic context before broad changes.
`;

export const antigravityContinuityRule = `${antigravityRuleOwnershipMarker}
# BriefOnce continuity

Use BriefOnce for substantive coding work in this workspace.

BriefOnce currently exposes compatibility MCP tools using the \`agentfold_*\` namespace.

At the beginning of substantive implementation, debugging, refactoring, test, documentation, or architecture work:

1. Call \`agentfold_open_session\` before modifying files.
2. Read the returned continuation packet or project context and preserve existing uncommitted work.
3. If an active task exists, compare it with the user's request. Continue it when relevant; when unrelated, ask before changing task lifecycle. Do not replace, finish, or duplicate it automatically.
4. If no active task exists and the user requested substantive repository changes, call \`agentfold_begin_task\` with a concise title and objective.
5. Do not create a task for conceptual questions, explanations, read-only inspection, status requests, non-project conversation, or trivial formatting help without repository changes.

During substantial work:

1. Call \`agentfold_report_progress\` after meaningful milestones, not after every edit.
2. Record concise engineering conclusions: completed and current work, decisions, failed attempts, blockers, validation, next actions, and assumptions.
3. Never report private chain of thought, full conversations, source-file contents, environment values, tokens, passwords, or secrets.

When the requested scope is fully complete:

1. Call \`agentfold_finish_task\` only after in-progress work and blockers are resolved and required validation is honestly reported.
2. Keep the same session open; call \`agentfold_begin_task\` for the next substantive unrelated request.
3. If the user explicitly says the task is complete, finish it after recording an honest final report.

Before ending work that is paused, incomplete, blocked, uncertain, or being handed off:

1. Call \`agentfold_close_session\` with a final structured progress report and leave checkpoint creation enabled.
2. Do not finish merely because context or usage limits were reached, validation still fails, or the user requested only a checkpoint or handoff.
3. Do not claim continuity was recorded when a BriefOnce tool failed.
4. Never discard uncommitted work, create commits, or push unless the user separately requested it.

When BriefOnce returns a continuation packet, follow its next actions, preserve recorded decisions, avoid repeated failed approaches, and verify absent or stale semantic context before broad changes.
`;

export function fingerprintAntigravityRule(content: string): string {
  const portableContent = content.replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(portableContent, "utf8").digest("hex");
}

export type AntigravityRulePlan =
  | {
      readonly status: "ready";
      readonly action: "create" | "update" | "identical";
      readonly content: string;
      readonly fingerprint: string;
    }
  | {
      readonly status: "collision";
      readonly existingFingerprint: string;
      readonly fingerprint: string;
    };

export function prepareAntigravityRule(
  existing: string | undefined,
  provenOwnedFingerprints: readonly string[] = [],
): AntigravityRulePlan {
  const fingerprint = fingerprintAntigravityRule(antigravityContinuityRule);
  if (existing === undefined) {
    return { status: "ready", action: "create", content: antigravityContinuityRule, fingerprint };
  }
  const existingFingerprint = fingerprintAntigravityRule(existing);
  if (existingFingerprint === fingerprint) {
    return { status: "ready", action: "identical", content: existing, fingerprint };
  }
  if (existingFingerprint === fingerprintAntigravityRule(previousAntigravityContinuityRule)) {
    return { status: "ready", action: "update", content: antigravityContinuityRule, fingerprint };
  }
  if (existingFingerprint === fingerprintAntigravityRule(agentFoldAntigravityContinuityRule)) {
    return { status: "ready", action: "update", content: antigravityContinuityRule, fingerprint };
  }
  if (
    (existing.includes(antigravityRuleOwnershipMarker) ||
      existing.includes(agentFoldAntigravityRuleOwnershipMarker) ||
      existing.includes(previousAntigravityRuleOwnershipMarker)) &&
    provenOwnedFingerprints.includes(existingFingerprint)
  ) {
    return { status: "ready", action: "update", content: antigravityContinuityRule, fingerprint };
  }
  return { status: "collision", existingFingerprint, fingerprint };
}
