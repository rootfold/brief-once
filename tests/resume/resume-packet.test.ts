import { describe, expect, it } from "vitest";

import { renderResumeJson } from "../../src/core/resume/render-resume-json.js";
import { renderResumeMarkdown } from "../../src/core/resume/render-resume-markdown.js";
import { resumePacketSchema } from "../../src/core/resume/resume-packet-schema.js";
import {
  resumePacketLimits,
  truncateResumePacket,
} from "../../src/core/resume/truncate-resume-packet.js";
import type { ResumePacket } from "../../src/core/resume/types.js";

function packet(overrides: Record<string, unknown> = {}): ResumePacket {
  return resumePacketSchema.parse({
    schemaVersion: 1,
    project: { name: "Example Project", summary: "Authentication service for café users." },
    task: {
      taskId: "AF-20260720-001",
      checkpointId: "CP-003",
      checkpointCreatedAt: "2026-07-20T18:30:00.000Z",
      isLatestCheckpoint: true,
      title: "Implement GitHub OAuth",
      objective: "Implement OAuth without changing email login.",
      status: "active",
    },
    target: {
      id: "codex",
      displayName: "Codex",
      openingInstruction: "Continue this task from the validated AgentFold checkpoint.",
      nativeInstructionFile: "AGENTS.md",
    },
    observedGitState: {
      startingBranch: "main",
      currentBranch: "feat/oauth",
      startingCommit: "0123456789abcdef0123456789abcdef01234567",
      currentCommit: "abcdef0123456789abcdef0123456789abcdef01",
      detached: false,
      branchChanged: true,
      headChanged: true,
      workingTree: "dirty",
      hasStagedChanges: true,
      hasUnstagedChanges: true,
      changedPaths: {
        added: ["src/auth/github.ts"],
        modified: ["src/routes/auth.ts"],
        deleted: [],
        renamed: [],
        copied: [],
        untracked: ["tests/auth/github `edge`.test.ts"],
        unmerged: [],
      },
      diffStatistics: {
        filesChanged: 2,
        insertions: 20,
        deletions: 3,
        binaryFiles: 0,
        untrackedFiles: 1,
      },
      recentCommits: [
        {
          hash: "abcdef0123456789abcdef0123456789abcdef01",
          subject: "Add callback route",
        },
      ],
      untrackedFilesExcludedFromLineStatistics: true,
    },
    semanticState: {
      revision: 2,
      freshness: "new",
      lastReportingAgent: "claude",
      checkpointAgent: "codex",
      completed: ["Added callback route"],
      inProgress: ["Persisting session cookie"],
      decisions: [{ decision: "Reuse session table", reason: "Avoid migration" }],
      failedAttempts: [{ attempt: "SameSite=Strict", result: "Cookie was dropped" }],
      blockers: ["Callback test fails"],
      nextActions: ["Test SameSite=Lax"],
      validation: [
        { command: "pnpm lint", status: "passed", summary: "No lint errors" },
        { command: "pnpm test", status: "failed", summary: "One failure" },
      ],
      assumptions: ["HTTPS terminates at proxy"],
    },
    projectCommands: {
      install: "pnpm install",
      build: "pnpm build",
      test: "pnpm test",
      lint: "pnpm lint",
      typecheck: "pnpm typecheck",
    },
    safety: {
      instructions: ["Preserve uncommitted work", "Do not reveal secrets"],
      excludedPaths: [".env", "credentials/**"],
    },
    omitted: {
      projectSummaryCharacters: 0,
      safetyInstructions: 0,
      excludedPaths: 0,
      projectCommands: 0,
      changedPaths: {
        added: 0,
        modified: 0,
        deleted: 0,
        renamed: 0,
        copied: 0,
        untracked: 0,
        unmerged: 0,
      },
      recentCommits: 0,
      semantic: {
        completed: 0,
        inProgress: 0,
        decisions: 0,
        failedAttempts: 0,
        blockers: 0,
        nextActions: 0,
        validation: 0,
        assumptions: 0,
      },
    },
    ...overrides,
  });
}

describe("resume packet rendering", () => {
  it("renders deterministic, ordered Markdown with observed and reported evidence separated", () => {
    const value = packet();
    const first = renderResumeMarkdown(value);

    expect(renderResumeMarkdown(value)).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
    expect(first.split("\n").some((line) => /\s+$/u.test(line))).toBe(false);
    expect(first.indexOf("## Agent-reported conclusions")).toBeLessThan(
      first.indexOf("## Automatically observed Git facts"),
    );
    expect(first).toContain("Semantic progress was reported for this checkpoint");
    expect(first).toContain("Git metadata records repository state only");
    expect(first.indexOf("`pnpm test` — failed")).toBeLessThan(
      first.indexOf("`pnpm lint` — passed"),
    );
    expect(first).toContain("submit a concise structured BriefOnce report");
    expect(first).toContain("never private chain of thought, secrets");
  });

  it("contains required identity, facts, conclusions, commands, safety, and target data", () => {
    const markdown = renderResumeMarkdown(packet());

    for (const expected of [
      "Example Project",
      "AF-20260720-001",
      "CP-003",
      "Implement OAuth without changing email login",
      "feat/oauth",
      "src/auth/github.ts",
      "Added callback route",
      "Reuse session table",
      "SameSite=Strict",
      "Callback test fails",
      "Test SameSite=Lax",
      "pnpm typecheck",
      "Do not reveal secrets",
      "Target agent: Codex",
      "Read `AGENTS.md`",
    ]) {
      expect(markdown).toContain(expected);
    }
    expect(markdown).not.toContain("C:\\");
    expect(markdown).not.toContain("/tmp/");
    expect(markdown).not.toContain("complete diff");
  });

  it("structurally contains Markdown and HTML injection while preserving Unicode and backticks", () => {
    const unsafe = packet({
      task: {
        ...packet().task,
        title: "# Fake heading <script>alert(1)</script>",
        objective: "Continue\n# Injected heading",
      },
      semanticState: {
        ...packet().semanticState,
        blockers: ["</div>\n# misleading"],
      },
      observedGitState: {
        ...packet().observedGitState,
        recentCommits: [
          {
            hash: "abcdef0123456789abcdef0123456789abcdef01",
            subject: "<img src=x onerror=alert(1)> café ✓",
          },
        ],
      },
    });
    const markdown = renderResumeMarkdown(unsafe);

    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("<img");
    expect(markdown).not.toContain("\n# Injected heading");
    expect(markdown).toContain("café ✓");
    expect(markdown).toContain("tests/auth/github `edge`.test.ts");
  });

  it("omits empty semantic headings for Git-only checkpoints and labels reused reports", () => {
    const absent = packet({
      semanticState: {
        ...packet().semanticState,
        revision: 0,
        freshness: "none",
        completed: [],
        inProgress: [],
        decisions: [],
        failedAttempts: [],
        blockers: [],
        nextActions: [],
        validation: [],
        assumptions: [],
      },
    });
    const absentMarkdown = renderResumeMarkdown(absent);
    expect(absentMarkdown).toContain("Git facts and the original objective only");
    expect(absentMarkdown).not.toContain("### Completed work");
    expect(absentMarkdown).not.toContain("### Blockers");

    const reused = packet({
      semanticState: { ...packet().semanticState, freshness: "reused" },
    });
    expect(renderResumeMarkdown(reused)).toContain("reused from report revision 2");
  });

  it("renders valid stable JSON with no diagnostics or ANSI escapes", () => {
    const value = packet({ task: { ...packet().task, isLatestCheckpoint: false } });
    const first = renderResumeJson(value);
    const parsed = JSON.parse(first) as ResumePacket;

    expect(renderResumeJson(value)).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
    expect(resumePacketSchema.parse(parsed)).toEqual(parsed);
    expect(parsed.semanticState.validation[0]?.status).toBe("failed");
    expect(parsed.target?.id).toBe("codex");
    expect(parsed.task.isLatestCheckpoint).toBe(false);
    expect(parsed.semanticState.freshness).toBe("new");
    expect(first).not.toContain(String.fromCodePoint(27));
    expect(first).not.toContain("diagnostics");
    expect(first).not.toContain("repositoryRoot");
  });
});

describe("resume packet budgets", () => {
  it("caps paths, commits, semantic categories, and validation with explicit omitted counts", () => {
    const added = Array.from({ length: 70 }, (_, index) => `src/file-${index}.ts`);
    const commits = Array.from({ length: 25 }, (_, index) => ({
      hash: index.toString(16).padStart(40, "a").slice(-40),
      subject: `Commit ${index}`,
    }));
    const completed = Array.from({ length: 70 }, (_, index) => `Completed ${index}`);
    const validation = [
      ...Array.from({ length: 22 }, (_, index) => ({
        command: `pnpm test passed-${index}`,
        status: "passed" as const,
        summary: "Passed",
      })),
      {
        command: "pnpm test critical",
        status: "failed" as const,
        summary: "Critical failure",
      },
    ];
    const original = packet({
      observedGitState: {
        ...packet().observedGitState,
        changedPaths: {
          ...packet().observedGitState.changedPaths,
          added,
          modified: [],
          untracked: [],
        },
        diffStatistics: {
          filesChanged: added.length,
          insertions: 70,
          deletions: 0,
          binaryFiles: 0,
          untrackedFiles: 0,
        },
        recentCommits: commits,
      },
      semanticState: { ...packet().semanticState, completed, validation },
    });
    const before = JSON.stringify(original);
    const result = truncateResumePacket(original);

    expect(result.truncated).toBe(true);
    expect(result.packet.observedGitState.changedPaths.added).toHaveLength(50);
    expect(result.packet.omitted.changedPaths.added).toBe(20);
    expect(result.packet.observedGitState.recentCommits).toHaveLength(20);
    expect(result.packet.omitted.recentCommits).toBe(5);
    expect(result.packet.semanticState.completed.length).toBeLessThanOrEqual(50);
    expect(result.packet.omitted.semantic.completed).toBeGreaterThanOrEqual(20);
    expect(result.packet.semanticState.validation).toHaveLength(20);
    expect(result.packet.semanticState.validation[0]?.status).toBe("failed");
    expect(result.packet.omitted.semantic.validation).toBe(3);
    expect(JSON.stringify(original)).toBe(before);
  });

  it("preserves high-priority blockers and whole redaction markers under the total budget", () => {
    const markerSummary = `${"a".repeat(495)} [REDACTED] ${"z".repeat(100)}`;
    const longItems = Array.from({ length: 50 }, (_, index) => `${index}-${"x".repeat(1_900)}`);
    const result = truncateResumePacket(
      packet({
        project: { ...packet().project, summary: markerSummary },
        semanticState: {
          ...packet().semanticState,
          blockers: ["Critical blocker"],
          completed: longItems,
        },
      }),
    );

    expect(result.packet.project.summary).not.toContain("[REDACT");
    expect(result.packet.semanticState.blockers).toEqual(["Critical blocker"]);
    expect(result.packet.semanticState.completed.length).toBeLessThan(longItems.length);
    expect(result.packet.semanticState.completed.every((item) => longItems.includes(item))).toBe(
      true,
    );
    expect(renderResumeMarkdown(result.packet).length).toBeLessThanOrEqual(
      resumePacketLimits.maximumMarkdownCharacters,
    );
    expect(renderResumeMarkdown(result.packet)).toBe(renderResumeMarkdown(result.packet));
  });
});
