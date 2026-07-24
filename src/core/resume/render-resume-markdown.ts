import { markdownCode, markdownText } from "./markdown-escape.js";
import { resumePacketSchema } from "./resume-packet-schema.js";
import { resumePacketLimits, truncateResumePacket } from "./truncate-resume-packet.js";
import type { ResumePacket } from "./types.js";

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function list(items: readonly string[], omitted = 0): string {
  const lines = items.map((item) => "- " + markdownText(item));
  if (omitted > 0)
    lines.push("- _" + omitted + " additional item" + plural(omitted) + " omitted._");
  return lines.join("\n");
}

function numbered(items: readonly string[], omitted = 0): string {
  const lines = items.map((item, index) => index + 1 + ". " + markdownText(item));
  if (omitted > 0)
    lines.push(
      items.length + 1 + ". _" + omitted + " additional action" + plural(omitted) + " omitted._",
    );
  return lines.join("\n");
}

function pathList(items: readonly string[], omitted: number, label: string): string {
  const lines = items.map((item) => "- " + markdownCode(item));
  if (omitted > 0)
    lines.push("- _" + omitted + " additional " + label + " path" + plural(omitted) + " omitted._");
  return lines.join("\n");
}

function moveList(
  items: readonly { readonly from: string; readonly to: string }[],
  omitted: number,
  label: string,
): string {
  const lines = items.map((item) => "- " + markdownCode(item.from) + " → " + markdownCode(item.to));
  if (omitted > 0)
    lines.push("- _" + omitted + " additional " + label + " path" + plural(omitted) + " omitted._");
  return lines.join("\n");
}

function optionalSection(heading: string, body: string): string | undefined {
  return body.length === 0 ? undefined : heading + "\n\n" + body;
}

function semanticSections(packet: ResumePacket): readonly string[] {
  const semantic = packet.semanticState;
  if (semantic.freshness === "none") {
    return [
      "## Agent-reported conclusions\n\nNo semantic report had been submitted when this checkpoint was created. This packet contains Git facts and the original objective only. Verify task intent with the developer before making broad architectural decisions.",
    ];
  }

  const freshness =
    semantic.freshness === "new"
      ? "Semantic progress was reported for this checkpoint at revision " + semantic.revision + "."
      : "Semantic progress is reused from report revision " +
        semantic.revision +
        " and may not describe the latest Git-only changes.";
  const sections = [
    "## Agent-reported conclusions\n\n" + freshness,
    optionalSection(
      "### Completed work",
      list(semantic.completed, packet.omitted.semantic.completed),
    ),
    optionalSection(
      "### Work in progress",
      list(semantic.inProgress, packet.omitted.semantic.inProgress),
    ),
    optionalSection("### Blockers", list(semantic.blockers, packet.omitted.semantic.blockers)),
    optionalSection(
      "## Next actions",
      numbered(semantic.nextActions, packet.omitted.semantic.nextActions),
    ),
  ].filter((section): section is string => section !== undefined);

  if (semantic.decisions.length > 0 || packet.omitted.semantic.decisions > 0) {
    const entries = semantic.decisions.map(
      (item, index) =>
        "#### Decision " +
        (index + 1) +
        "\n\n- Decision: " +
        markdownText(item.decision) +
        "\n- Reason: " +
        markdownText(item.reason),
    );
    if (packet.omitted.semantic.decisions > 0)
      entries.push("_" + packet.omitted.semantic.decisions + " additional decisions omitted._");
    sections.push("## Decisions to preserve\n\n" + entries.join("\n\n"));
  }
  if (semantic.failedAttempts.length > 0 || packet.omitted.semantic.failedAttempts > 0) {
    const entries = semantic.failedAttempts.map(
      (item, index) =>
        "#### Failed approach " +
        (index + 1) +
        "\n\n- Attempt: " +
        markdownText(item.attempt) +
        "\n- Result: " +
        markdownText(item.result),
    );
    if (packet.omitted.semantic.failedAttempts > 0)
      entries.push(
        "_" + packet.omitted.semantic.failedAttempts + " additional failed approaches omitted._",
      );
    sections.push("## Failed approaches\n\n" + entries.join("\n\n"));
  }
  if (semantic.validation.length > 0 || packet.omitted.semantic.validation > 0) {
    const entries = semantic.validation.map(
      (item) =>
        "- " + markdownCode(item.command) + " — " + item.status + ": " + markdownText(item.summary),
    );
    if (packet.omitted.semantic.validation > 0)
      entries.push(
        "- _" +
          packet.omitted.semantic.validation +
          " additional reported validation entries omitted._",
      );
    sections.push("## Reported validation\n\n" + entries.join("\n"));
  }
  if (semantic.assumptions.length > 0 || packet.omitted.semantic.assumptions > 0) {
    sections.push(
      "## Unverified assumptions\n\n" +
        list(semantic.assumptions, packet.omitted.semantic.assumptions),
    );
  }
  return sections;
}

function changedPathSections(packet: ResumePacket): readonly string[] {
  const paths = packet.observedGitState.changedPaths;
  const omitted = packet.omitted.changedPaths;
  const groups = [
    ["#### Added", pathList(paths.added, omitted.added, "added")],
    ["#### Modified", pathList(paths.modified, omitted.modified, "modified")],
    ["#### Deleted", pathList(paths.deleted, omitted.deleted, "deleted")],
    ["#### Renamed", moveList(paths.renamed, omitted.renamed, "renamed")],
    ["#### Copied", moveList(paths.copied, omitted.copied, "copied")],
    ["#### Untracked", pathList(paths.untracked, omitted.untracked, "untracked")],
    ["#### Unmerged", pathList(paths.unmerged, omitted.unmerged, "unmerged")],
  ] as const;
  const populated = groups
    .filter(([, body]) => body.length > 0)
    .map(([heading, body]) => heading + "\n\n" + body);
  return populated.length === 0 ? ["No changed paths were recorded."] : populated;
}

export function renderResumeMarkdown(input: ResumePacket): string {
  const packet = resumePacketSchema.parse(truncateResumePacket(input).packet);
  const git = packet.observedGitState;
  const preparationSteps = [
    packet.target === undefined
      ? "Inspect the repository instructions before changing code."
      : markdownText(packet.target.openingInstruction),
    ...(packet.target === undefined
      ? []
      : packet.target.nativeInstructionFile === undefined
        ? ["Inspect the repository instructions before changing code."]
        : ["Read " + markdownCode(packet.target.nativeInstructionFile) + " before changing code."]),
    "Preserve existing uncommitted work.",
    "Do not repeat failed approaches listed below.",
    "Run relevant validation after making changes.",
  ];
  const projectLines = [
    "- Name: " + markdownText(packet.project.name),
    ...(packet.project.summary.length === 0
      ? []
      : ["- Summary: " + markdownText(packet.project.summary)]),
    "- Task title: " + markdownText(packet.task.title),
    "- Task status: " + packet.task.status,
    "- Checkpoint created: " + packet.task.checkpointCreatedAt,
    ...(packet.target === undefined
      ? []
      : ["- Target agent: " + markdownText(packet.target.displayName)]),
    ...(packet.semanticState.lastReportingAgent === undefined
      ? []
      : [
          "- Last semantic reporting agent: " +
            markdownText(packet.semanticState.lastReportingAgent),
        ]),
    ...(packet.semanticState.checkpointAgent === undefined
      ? []
      : ["- Checkpointing agent: " + markdownText(packet.semanticState.checkpointAgent)]),
  ];
  if (packet.omitted.projectSummaryCharacters > 0)
    projectLines.push(
      "- Project summary reduced by " + packet.omitted.projectSummaryCharacters + " characters.",
    );

  const gitLines = [
    "- Starting branch: " + markdownCode(git.startingBranch),
    "- Current branch: " + markdownCode(git.currentBranch),
    "- Starting commit: " +
      (git.startingCommit === null ? "none" : markdownCode(git.startingCommit)),
    "- Current commit: " + (git.currentCommit === null ? "none" : markdownCode(git.currentCommit)),
    "- Detached HEAD: " + (git.detached ? "yes" : "no"),
    "- Branch changed: " + (git.branchChanged ? "yes" : "no"),
    "- HEAD changed: " + (git.headChanged ? "yes" : "no"),
    "- Working tree at checkpoint: " + git.workingTree,
    "- Staged changes: " + (git.hasStagedChanges ? "yes" : "no"),
    "- Unstaged or untracked changes: " + (git.hasUnstagedChanges ? "yes" : "no"),
  ];
  const stats = git.diffStatistics;
  const recentCommits = git.recentCommits.map(
    (commit) => "- " + markdownCode(commit.hash) + " " + markdownText(commit.subject),
  );
  if (packet.omitted.recentCommits > 0)
    recentCommits.push(
      "- _" + packet.omitted.recentCommits + " additional recent commits omitted._",
    );

  const commandLabels: Readonly<Record<string, string>> = {
    install: "Install",
    dev: "Development",
    build: "Build",
    test: "Test",
    lint: "Lint",
    typecheck: "Type-check",
  };
  const commands = Object.entries(packet.projectCommands).flatMap(([name, command]) =>
    command === undefined
      ? []
      : ["- " + (commandLabels[name] ?? name) + ": " + markdownCode(command)],
  );
  if (packet.omitted.projectCommands > 0)
    commands.push("- _" + packet.omitted.projectCommands + " additional commands omitted._");
  const safety = packet.safety.instructions.map((item) => "- " + markdownText(item));
  if (packet.omitted.safetyInstructions > 0)
    safety.push(
      "- _" + packet.omitted.safetyInstructions + " additional safety instructions omitted._",
    );
  for (const excludedPath of packet.safety.excludedPaths)
    safety.push("- Do not read or modify excluded path " + markdownCode(excludedPath) + ".");
  if (packet.omitted.excludedPaths > 0)
    safety.push("- _" + packet.omitted.excludedPaths + " additional excluded paths omitted._");

  const checkpointLines = [
    "> Continue task " +
      markdownCode(packet.task.taskId) +
      " from checkpoint " +
      markdownCode(packet.task.checkpointId) +
      ".",
    ...(packet.task.isLatestCheckpoint
      ? []
      : ["> This is a historical checkpoint, not the latest checkpoint for the active task."]),
  ];
  const assignment =
    "## Your assignment\n\n" +
    markdownText(packet.task.objective) +
    "\n\nBefore modifying code:\n\n" +
    preparationSteps.map((step, index) => index + 1 + ". " + step).join("\n");
  const observed =
    "## Automatically observed Git facts\n\nGit metadata records repository state only; it does not prove engineering decisions, blockers, or intent.\n\n### Branch and working tree\n\n" +
    gitLines.join("\n") +
    "\n\n### Changed paths\n\n" +
    changedPathSections(packet).join("\n\n") +
    "\n\n### Diff statistics\n\n- Files changed: " +
    stats.filesChanged +
    "\n- Insertions: " +
    stats.insertions +
    "\n- Deletions: " +
    stats.deletions +
    "\n- Binary files: " +
    stats.binaryFiles +
    "\n- Untracked files: " +
    stats.untrackedFiles +
    "\n- Untracked-file contents were not inspected and are excluded from line totals.\n\n### Recent commits\n\n" +
    (recentCommits.length === 0 ? "No recent commits were recorded." : recentCommits.join("\n"));
  const sections = [
    "# BriefOnce continuation packet",
    checkpointLines.join("\n"),
    assignment,
    "## Project\n\n" + projectLines.join("\n"),
    ...semanticSections(packet),
    observed,
    ...(commands.length === 0 ? [] : ["## Project commands\n\n" + commands.join("\n")]),
    ...(safety.length === 0 ? [] : ["## Safety constraints\n\n" + safety.join("\n")]),
    "## Completion requirement\n\nBefore ending the new session, submit a concise structured BriefOnce report covering completed work, work in progress, decisions, failed attempts, blockers, reported validation, next actions, and assumptions. Include conclusions only—never private chain of thought, secrets, complete conversations, or terminal transcripts.",
  ];
  const output = sections.join("\n\n").trimEnd() + "\n";
  if (output.length > resumePacketLimits.maximumMarkdownCharacters) {
    throw new Error("Resume packet exceeds the deterministic Markdown budget");
  }
  return output;
}
