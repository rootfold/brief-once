# Getting started

BriefOnce currently supports safe initialization, canonical project diagnostics, active-task reports, immutable checkpoints, completed-task archives, continuation packets, and a local MCP boundary. Run it from any directory inside an existing Git repository.

## Preview initialization

```bash
pnpm b1 init --dry-run
```

This resolves the repository root, scans safe root-level metadata, reports existing agent instruction files, and lists the canonical files that would be created. It does not write anything. Running `pnpm b1 init` without an option is also a conservative preview and tells you to re-run with `--yes`.

## Initialize non-interactively

```bash
pnpm b1 init --yes
```

This creates:

```text
.briefonce/
├── config.yaml
├── context/
│   ├── project.md
│   ├── architecture.md
│   ├── commands.md
│   ├── conventions.md
│   └── safety.md
└── manifest.json
```

Initialization never overwrites an existing canonical file. If `.briefonce/config.yaml` already exists, the command reports the installation and exits without writing. A complete legacy `.agentfold` installation remains usable and is reported with a migration suggestion. A partial installation, or a repository containing both `.briefonce` and `.agentfold`, is a conflict for manual review. Existing `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Copilot instructions, and Cursor rules are detected but left untouched.

Initialization records only known top-level directories that actually exist. A detected configuration can include:

```yaml
paths:
  source:
    - src
  tests:
    - tests
  documentation:
    - docs
  generated:
    - dist
    - coverage
```

Each category is optional. Paths use forward slashes, remain relative to the Git repository, and are normalized and deduplicated during validation. Absolute paths and parent traversal are invalid. A configured path may be created later, but `doctor` warns while it does not exist.

New initialization also records the shared-service automation policy:

```yaml
automation:
  enabled: true
  sessions:
    heartbeat_interval_seconds: 20
    stale_after_seconds: 90
  checkpoints:
    on_agent_switch: true
    on_session_close: true
    recovery_on_timeout: true
    minimum_interval_seconds: 30
```

Older configuration without this optional section remains valid and receives these defaults only while resolving context; BriefOnce does not rewrite it.

Reliability settings are also optional and default only in memory:

```yaml
reliability:
  enabled: true
  maximum_events_per_repository: 1000
  retain_closed_sessions: 100
  interrupted_recovery_enabled: true
```

These settings govern private user-scoped lifecycle events and restart recovery;
they do not add files to the repository.

## Check project health

```bash
pnpm b1 doctor
```

The current doctor checks Git repository presence and `README.md`, then resolves the canonical project context through the same loader future adapters will use. It reports invalid YAML or schema values, missing or empty context files, unsafe paths, and configured paths that do not exist. It does not modify files.

Canonical BriefOnce files under `.briefonce` are intended to be tracked.
Initialization does not edit `.gitignore`; local task state can be ignored
separately.

## Migrate a legacy AgentFold project

Legacy `.agentfold` repositories remain readable and writable so upgrading the
package never strands active work. Migration is explicit:

```bash
b1 migrate
b1 migrate --dry-run
b1 migrate --yes
```

The first two commands are previews and write nothing. `--yes` validates the
legacy canonical context and manifest, rejects symbolic-link or dual-directory
conflicts, renames `.agentfold` to `.briefonce` on the same filesystem, and
normalizes manifest paths. It preserves context, active state, checkpoints, and
completed-task archives. It never merges two directories or edits unrelated
agent instruction files.

If local task state was ignored as `.agentfold/state/`, update that ignore rule
to `.briefonce/state/` after migration. BriefOnce does not edit `.gitignore`
automatically.

## Start an active task

Previewing is the default and writes nothing:

```bash
pnpm b1 start "Implement GitHub OAuth"
```

Create the active task non-interactively:

```bash
pnpm b1 start "Implement GitHub OAuth" --agent codex --yes
```

This atomically creates `.briefonce/state/current.md`. It records a repository-relative working context, the current branch and HEAD commit, and an explicit `null` commit when the repository has no commits. It never creates a branch, stages files, or commits changes. An existing active task is never replaced.

When `state.visibility` is `local`, BriefOnce warns if `.briefonce/state/` is not ignored. Add only this path when local task state should remain untracked:

```gitignore
.briefonce/state/
```

BriefOnce does not edit `.gitignore` automatically.

## Submit a structured agent report

Create `report.json`:

```json
{
  "agent": "codex",
  "completed": ["Added the GitHub OAuth callback route"],
  "decisions": [
    {
      "decision": "Reuse the existing session table",
      "reason": "Avoid changing the existing authentication model"
    }
  ],
  "nextActions": ["Fix the callback integration test"]
}
```

PowerShell:

```powershell
Get-Content .\report.json -Raw | pnpm b1 report --stdin
```

macOS, Linux, and other shells with `cat`:

```bash
cat report.json | pnpm b1 report --stdin
```

Use `--agent codex` to supply an omitted agent or explicitly override the JSON `agent` field. Reports append and deduplicate semantic progress; they do not replace earlier conclusions. Validation commands are stored as reported text and are never executed.

BriefOnce redacts likely secrets before persistence, but developers and coding agents should not submit secrets, private reasoning, complete conversations, or transcripts. Future agent integrations can submit this report structure automatically without exposing private conversations.

## Create an immutable checkpoint

Capture the active task, its previously reported semantic progress, and the current Git facts:

```bash
pnpm b1 checkpoint
```

Checkpointing persists by default. Use `--dry-run` to capture and preview the same facts without creating history or updating active state:

```bash
pnpm b1 checkpoint --dry-run
```

An integration can identify itself independently of the last semantic reporting agent:

```bash
pnpm b1 checkpoint --agent codex
```

Git branch, HEAD, staged and unstaged status, repository-relative changed paths, aggregate numstat totals, and recent commit subjects are collected automatically. A path changed in both the index and working tree is counted once as a file, while its two Git numstat layers are summed; these are aggregate layer totals rather than a stored combined diff. Binary paths are counted without line totals. Semantic conclusions come only from earlier `report --stdin` submissions. A Git-only checkpoint is allowed with a warning; BriefOnce does not infer decisions, blockers, failures, or next actions from a diff.

History is stored under `.briefonce/state/history/` as deterministic Markdown with YAML front matter. Observed Git facts and agent-reported conclusions remain visibly separate. Checkpoints contain no full diff, source-file content, environment values, terminal transcript, or private reasoning. Untracked files are named but their contents and line counts are not inspected.

Checkpointing never stages or commits files. Running it again without a meaningful Git or semantic change leaves both history and active state byte-for-byte unchanged.

## Finish a completed task

`checkpoint` preserves unfinished or paused work. `finish` records that the requested scope is complete. Preview is the default and writes nothing:

```bash
pnpm b1 finish
pnpm b1 finish --dry-run
```

Finish an already-ready active task non-interactively:

```bash
pnpm b1 finish --agent codex --yes
```

For a final report and exact resolutions, pipe structured JSON:

```powershell
Get-Content .\completion.json -Raw | pnpm b1 finish --stdin --yes
```

```json
{
  "summary": "Implemented and validated GitHub OAuth.",
  "finalReport": {
    "completed": ["Added callback and session persistence"],
    "validation": [{ "command": "pnpm test", "status": "passed", "summary": "All tests passed" }]
  },
  "resolvedInProgress": ["Persisting the OAuth session cookie"],
  "resolvedBlockers": ["Callback integration test was failing"],
  "followUp": ["Consider provider metrics separately"]
}
```

Resolution text must exactly match the normalized active entry. Omitting an entry does not silently resolve it, and any remaining in-progress work or blocker prevents completion. Reported validation is stored honestly and never executed.

A successful finish creates one immutable `kind: final` checkpoint under `.briefonce/state/history/`, archives a human-readable record at `.briefonce/state/completed/<task-id>.md`, and only then removes `.briefonce/state/current.md`. Existing history remains intact. Run `start` for the next substantive task; completed tasks cannot currently be reopened or deleted.

## Resume from a checkpoint

Render the latest immutable checkpoint for the active task as Markdown on standard output:

```bash
pnpm b1 resume
```

Add a small Codex-specific hint, serialize the typed packet as JSON, select a historical checkpoint, or atomically create an output file:

```bash
pnpm b1 resume --for codex
pnpm b1 resume --format json
pnpm b1 resume --checkpoint CP-001
pnpm b1 resume --output handoff.md
```

Resume follows active-state checkpoint metadata and validates the selected immutable history file. A historical checkpoint can be selected explicitly and is marked as not latest. The command does not rerun Git discovery, read source files, or include complete diffs. Automatically observed Git facts remain separate from earlier agent-reported conclusions, and reused or absent semantic reports are labeled explicitly.

Markdown is intended for pasting into a fresh coding-agent session. JSON contains the same bounded `ResumePacket` data for future integrations, with diagnostics kept on standard error. Target options add only a display and instruction-file hint; they do not generate or modify agent instructions. Relative output paths are resolved from the repository root, parent directories may be created inside that boundary, and existing files are never overwritten. A mismatched output extension produces a warning but the requested filename is preserved.

The continuation packet asks the receiving agent to submit concise structured conclusions before ending. Future work may automate report and checkpoint invocation, but resume itself has no adapters, managed processes, watchers, Git hooks, network calls, or model integration.

## Inspect lifecycle reliability

Reliability inspection is read-only and works even when the shared service is
stopped:

```bash
pnpm b1 reliability
pnpm b1 reliability --host codex
pnpm b1 reliability --task AF-20260724-001
pnpm b1 reliability --include-events --limit 25
pnpm b1 reliability --json
```

Only BriefOnce-observed sessions are counted. Private bounded history and
restart-recovery state live outside the repository and never contain prompt
text, report text, resume packets, source contents, changed paths, full diffs,
terminal output, environment values, secrets, tokens, or host configuration.
See [reliability monitoring](reliability.md) for retention, rating rules, and
restart behavior.

## Run the local MCP server

Start one stdio MCP process for the containing Git repository:

```bash
pnpm b1 mcp --workspace .
```

The server lets a compatible host open a session, read bounded context, begin a task, report progress, checkpoint, finish, resume, and close the session through the same validated core used by the CLI commands. It has no network listener and writes protocol messages only to standard output. Safe debug lifecycle messages are available with `--debug` on standard error.

The default `--service auto` mode uses the shared service when available and otherwise warns on stderr before preserving embedded behavior. For cross-application coordination:

```bash
pnpm b1 service start
pnpm b1 service status
pnpm b1 mcp --workspace . --service required
pnpm b1 service stop
```

See [Local MCP integration](integrations/mcp.md) for the tool lifecycle and [Shared local service](service.md) for runtime directories, authentication, leases, automatic switch checkpoints, recovery, and troubleshooting. Running the MCP command alone does not install application-specific configuration.

## Connect Google Antigravity

Preview the detected Antigravity surface and every proposed change without writing:

```bash
pnpm b1 connect antigravity
pnpm b1 connect antigravity --dry-run
```

Install the MCP registration and workspace continuity rule non-interactively, then verify the owned files and live protocol boundary:

```bash
pnpm b1 connect antigravity --yes
pnpm b1 verify antigravity
```

Automatic discovery refuses ambiguous host configurations. Use `--surface desktop`, `ide`, `cli`, or `all` when an explicit choice is required. Disconnect is also a preview unless `--yes` is supplied:

```bash
pnpm b1 disconnect antigravity
pnpm b1 disconnect antigravity --yes
```

The connector preserves unrelated and secret-bearing host configuration byte-for-byte, keeps restrictive backups outside the repository, and removes only content whose fingerprint still proves BriefOnce ownership. It does not change Antigravity approval settings, install an operating-system service, stop the shared service during removal, or claim that the Antigravity UI has ingested the entry. See [Google Antigravity connector](integrations/antigravity.md) for discovery paths, workspace selection, manual refresh, safety, and recovery details.

## Connect Codex

Preview the shared Codex configuration and repository instruction changes, then install only after review:

```bash
pnpm b1 connect codex
pnpm b1 connect codex --dry-run
pnpm b1 connect codex --surface all --yes
pnpm b1 verify codex
```

Supported surfaces are `auto`, `cli`, `ide`, `app`, and `all`. CLI, IDE, and desktop app share one user-level `config.toml`; each connected Git worktree keeps a separate root `AGENTS.md` managed region. Restart Codex or its IDE extension after installation and confirm `agentfold` is enabled under MCP servers.

Disconnect remains a preview unless `--yes` is supplied:

```bash
pnpm b1 disconnect codex
pnpm b1 disconnect codex --yes
```

The connector preserves unrelated TOML and `AGENTS.md` content, stores exact config backups outside the repository, retains the global entry while another repository depends on it, and leaves the shared service running. It installs no skill, plugin, hook, IDE extension, OS service, telemetry, or network integration. See [Codex connector](integrations/codex.md) for ownership, worktrees, refresh steps, and limitations.
