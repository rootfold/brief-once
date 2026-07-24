# AgentFold

> **One project context. Every coding agent. Every session.**

AgentFold is a local-first, open-source CLI that keeps project instructions and active development progress synchronized across coding agents.

Developers often move between Codex, Claude Code, Google Antigravity, Gemini CLI, GitHub Copilot, Cursor, Windsurf, Cline, Roo Code, OpenCode, and other tools because each agent has different strengths, free limits, availability, and pricing. The problem is that every switch loses context:

- The new agent does not know the architecture.
- Project rules are duplicated across incompatible files.
- Decisions made in the previous session are missing.
- Completed work is rediscovered.
- The next agent repeats exploration and may reverse earlier decisions.

AgentFold gives the repository a shared, tool-independent memory layer.

```text
Stable project knowledge ──> generated instructions for each agent
Current work state       ──> compact checkpoints and handoff packets
```

## Install using node package manager

```bash
npm install --global @rootfold/agentfold
```

```bash
npx @rootfold/agentfold init
npx @rootfold/agentfold start "Add GitHub OAuth"
npx @rootfold/agentfold checkpoint --agent antigravity
npx @rootfold/agentfold resume --for codex
```

No paid model is required. No cloud account is required. The core workflow is deterministic and runs locally.

---

## Project status

AgentFold is currently in the **design and early implementation stage**.

This README doubles as the product specification and engineering source of truth for the first public release. Until dedicated specification documents are introduced, implementation decisions must remain consistent with this file.

---

## The problem

Coding agents currently store context in separate places.

```text
Codex              -> AGENTS.md and its own session
Claude Code        -> CLAUDE.md and its own memory
Antigravity        -> AGENTS.md or GEMINI.md and its own session
Gemini CLI         -> GEMINI.md and its own session
GitHub Copilot     -> .github/copilot-instructions.md
Cursor             -> .cursor/rules/*.mdc
Other agents       -> their own rules, prompts, or session history
```

Static instruction files solve only part of the problem. They can tell an agent how the repository works, but they usually do not explain:

- What task is active
- What has already been completed
- Which files were changed
- Which approach was rejected and why
- What tests were run
- What is currently broken
- What the next agent should do first

AgentFold manages both kinds of context.

### Durable project context

Long-lived facts that should remain consistent across sessions:

- Project purpose
- Architecture
- Technology stack
- Setup, development, build, lint, and test commands
- Coding conventions
- Directory responsibilities
- Security restrictions
- Files agents should not edit
- Review expectations

### Active work state

Short-lived progress needed to continue the current task:

- Current objective
- Current branch and commit
- Completed steps
- Work in progress
- Technical decisions
- Changed files
- Validation already performed
- Known failures and blockers
- Exact next actions

> **An agent session may end, but the repository should still remember where the work stopped.**

---

## Product goals

AgentFold must:

1. Maintain one source of truth for project-level agent instructions.
2. Generate compatible instruction files for multiple coding agents.
3. Preserve active task progress independently of any one agent.
4. Produce compact handoff context when switching agents.
5. Detect drift, duplication, contradictions, stale state, and context bloat.
6. Work locally without requiring an AI API, subscription, or hosted service.
7. Protect secrets and avoid collecting unnecessary repository content.
8. Be safe to introduce into an existing repository.
9. Be useful for solo developers first and teams later.
10. Remain extensible through a small adapter system.

---

## Non-goals

The first release will not:

- Build another autonomous coding agent.
- Proxy prompts or model API calls.
- Scrape proprietary chat histories from coding tools.
- Upload source code to an AgentFold server.
- Replace Git, issues, pull requests, or project-management tools.
- Store complete source-code diffs inside handoff files.
- Automatically make architectural decisions.
- Guarantee that an agent follows generated instructions.
- Depend on an LLM for core functionality.
- Attempt perfect bidirectional conversion between every proprietary format.

AgentFold coordinates context. It does not perform the coding task itself.

---

## Core principles

### Local first

Project analysis, context generation, state tracking, and diagnostics run on the developer's machine.

### Deterministic first

The same configuration should generate the same output. Optional AI-assisted features may be added later, but the core must remain useful without them.

### Minimal context

Agents should receive the smallest useful context, not an entire documentation dump. Generated files must prioritize commands, constraints, architecture, and task-relevant facts.

### Safe by default

AgentFold must never silently destroy an existing instruction file. Existing content is preserved unless the user explicitly authorizes replacement.

### Human-readable storage

Project context and work state use Markdown and YAML so developers can inspect, edit, review, and version them without AgentFold.

### Agent-neutral design

The canonical format must not copy the structure or terminology of one vendor.

### Honest handoffs

A checkpoint must clearly separate verified work, assumptions, failed attempts, blockers, and remaining work.

---

## How AgentFold works

```text
                           ┌────────────────────────┐
                           │ .agentfold/config.yaml │
                           └────────────┬───────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    │                                       │
          ┌─────────▼─────────┐                   ┌─────────▼─────────┐
          │ Durable context   │                   │ Active work state │
          │ architecture      │                   │ objective         │
          │ commands          │                   │ progress          │
          │ conventions       │                   │ decisions         │
          │ safety rules      │                   │ next actions      │
          └─────────┬─────────┘                   └─────────┬─────────┘
                    │                                       │
          ┌─────────▼─────────┐                   ┌─────────▼─────────┐
          │ Adapter renderer  │                   │ Handoff renderer  │
          └─────────┬─────────┘                   └─────────┬─────────┘
                    │                                       │
        ┌───────────┼────────────┐              ┌───────────┼────────────┐
        │           │            │              │           │            │
   AGENTS.md   CLAUDE.md   GEMINI.md       Terminal     Clipboard    Markdown
```

AgentFold does not need access to an agent's private conversation. Instead, it stores the important result of the session in a shared repository state file.

---

## Quick start

The currently implemented workflow is documented in
[docs/getting-started.md](docs/getting-started.md), including the local stdio
[MCP integration](docs/integrations/mcp.md), [shared local service](docs/service.md),
[Google Antigravity connector](docs/integrations/antigravity.md), and
[Codex connector](docs/integrations/codex.md). Read-only lifecycle quality and
restart recovery are documented in [docs/reliability.md](docs/reliability.md).

Install the public CLI globally, or use the scoped package directly through
`npx`:

```bash
npm install --global @rootfold/agentfold
agentfold --version
agentfold reliability

# One-off execution without a global install
npx --yes @rootfold/agentfold --version
```

### Connect AgentFold to Codex

Run the connector from an initialized repository. Preview is read-only; `--yes`
is required to install the shared MCP registration and the repository-scoped
Codex continuity instructions.

```bash
# Preview the exact changes
pnpm agentfold connect codex --dry-run

# Connect the Codex CLI, IDE extension, and desktop app configuration
pnpm agentfold connect codex --surface all --yes

# Verify ownership, the local service, the MCP handshake, and all nine tools
pnpm agentfold verify codex
```

When using an installed AgentFold package, replace `pnpm agentfold` with
`agentfold`. After installation or an update, restart Codex or its IDE extension,
then confirm that `agentfold` is enabled under MCP servers. In the Codex CLI/TUI,
use `/mcp` to inspect the connection.

### Use AgentFold from Codex

The connector adds a managed `AGENTS.md` region that asks Codex to use the MCP
lifecycle for substantive repository work. You can verify the connection with a
normal prompt:

```text
Verify that the AgentFold MCP server is connected and call agentfold_get_status.
```

Start focused work without manually copying project context:

```text
Use AgentFold for this task. Open a session, continue a relevant active task if
one exists, and otherwise begin a task named "Add GitHub OAuth". Read the bounded
project context, implement the change, validate it, report concise progress, and
finish the task when its scope is complete.
```

Continue existing work in a later Codex session or another connected host:

```text
Open an AgentFold session and continue the active task from its latest
checkpoint. Verify repository facts before editing, then report new conclusions
and close the session with checkpoint creation enabled.
```

The tool lifecycle behind those prompts is:

1. `agentfold_get_status` checks initialization and active-task state.
2. `agentfold_open_session` returns the current task or continuation status.
3. `agentfold_begin_task` creates state only when no relevant task exists.
4. `agentfold_get_context` reads bounded canonical project context.
5. `agentfold_report_progress` stores structured engineering conclusions.
6. `agentfold_create_checkpoint` captures bounded Git facts and semantic state.
7. `agentfold_finish_task` archives completed work and clears active state.
8. `agentfold_get_resume_packet` prepares a deterministic handoff when needed.
9. `agentfold_close_session` can report, checkpoint, and close unfinished work.

Do not include secrets, private reasoning, full conversations, or terminal
transcripts in task titles or progress reports. AgentFold never commits, pushes,
resets, stashes, or changes branches through these MCP tools.

### Initialize AgentFold

```bash
npx @rootfold/agentfold init
```

`init` should:

1. Confirm that the current directory is a Git repository.
2. Inspect safe project metadata.
3. Detect package managers, languages, frameworks, and common commands.
4. Create `.agentfold/config.yaml`.
5. Create modular context files.
6. Ask which agent adapters should be enabled.
7. Ask whether active state should be local-only or committed.
8. Generate an initial instruction preview.
9. Never overwrite an existing agent file without confirmation.

### Generate agent instructions

```bash
npx @rootfold/agentfold sync
```

Example output:

```text
AgentFold sync

✓ Loaded .agentfold/config.yaml
✓ Rendered AGENTS.md
✓ Rendered CLAUDE.md
✓ Rendered GEMINI.md
✓ Rendered .github/copilot-instructions.md
✓ Rendered .cursor/rules/agentfold.mdc

5 files synchronized
0 conflicts
Estimated shared context: 1,142 tokens
```

### Start a task

```bash
npx @rootfold/agentfold start "Implement GitHub OAuth"
```

This creates or resets:

```text
.agentfold/state/current.md
```

### Save progress before switching agents

```bash
npx @rootfold/agentfold checkpoint --agent antigravity
```

`checkpoint` gathers safe Git metadata and requests a concise work summary. It records:

- Current branch
- Current commit
- Changed file paths
- Diff statistics
- Completed work
- Decisions
- Tests
- Blockers
- Next actions

It must not store the full diff by default.

### Continue with another agent

```bash
npx @rootfold/agentfold resume --for codex
```

Example output:

```text
Resume task: Implement GitHub OAuth

Current branch: feature/github-oauth
Previous agent: antigravity

Completed:
- Added GitHub provider configuration
- Added callback route
- Added environment validation

Current issue:
- Callback succeeds, but the session cookie is not persisted

Changed files:
- src/auth/github.ts
- src/routes/auth.ts
- src/config/env.ts
- tests/auth/github.test.ts

Validation:
- pnpm lint: passed
- pnpm test auth: 1 failing test

Next actions:
1. Inspect SameSite and secure cookie options.
2. Fix the failing callback test.
3. Run the complete auth test suite.

Read AGENTS.md before changing code.
```

The packet can be printed, copied to the clipboard, written as Markdown, or returned as JSON.

---

## Planned CLI

```text
agentfold init
agentfold import
agentfold sync
agentfold doctor
agentfold status

agentfold start <task>
agentfold checkpoint
agentfold resume
agentfold handoff
agentfold finish
```

### `agentfold init`

Create the canonical AgentFold structure.

```bash
agentfold init
agentfold init --yes
agentfold init --from-existing
```

### `agentfold import`

Import existing instruction files into a draft canonical configuration.

```bash
agentfold import
agentfold import AGENTS.md CLAUDE.md
```

Import must not assume duplicated statements are automatically correct. Conflicts should be reported for review.

### `agentfold sync`

Render enabled target files.

```bash
agentfold sync
agentfold sync --target codex
agentfold sync --target claude
agentfold sync --check
agentfold sync --dry-run
```

`--check` exits with a non-zero status when generated files are stale, making it suitable for CI.

### `agentfold doctor`

Analyze configuration and generated context.

```bash
agentfold doctor
agentfold doctor --json
agentfold doctor --fix
```

Initial checks:

- Missing setup, lint, test, or build commands
- Referenced paths that do not exist
- Duplicate rules
- Direct rule contradictions
- Oversized generated context
- Stale generated files
- Generated files modified outside managed regions
- Missing safety exclusions
- Suspicious secret-like content
- Active-state branch or commit mismatch
- Stale active task
- Unknown adapter options
- Invalid configuration schema

### `agentfold status`

Show current AgentFold health and task state.

```bash
agentfold status
```

### `agentfold start`

Start a new task.

```bash
agentfold start "Add GitHub OAuth"
agentfold start "Fix issue #42" --agent codex
```

Starting a new task while another is active requires confirmation or `--force`.

### `agentfold checkpoint`

Record a safe progress snapshot.

```bash
agentfold checkpoint
agentfold checkpoint --agent antigravity
agentfold checkpoint --summary-file checkpoint.md
agentfold checkpoint --stdin
```

Machine-friendly input will allow an agent to submit a structured checkpoint without an interactive prompt.

### `agentfold resume`

Create a compact continuation packet.

```bash
agentfold resume
agentfold resume --for codex
agentfold resume --for claude
agentfold resume --format markdown
agentfold resume --format json
agentfold resume --copy
```

### `agentfold handoff`

Create a transition packet and optionally update target instructions.

```bash
agentfold handoff --from antigravity --to codex
agentfold handoff --to claude --copy
```

For the MVP, `handoff` may internally combine `checkpoint` and `resume`.

### `agentfold finish`

Preview or atomically archive a completed active task. Remaining in-progress work or blockers prevent completion; structured resolution entries must match exactly.

```bash
agentfold finish
agentfold finish --dry-run
agentfold finish --agent codex --yes
Get-Content completion.json -Raw | agentfold finish --stdin --yes
```

---

## Repository structure created by AgentFold

```text
.agentfold/
├── config.yaml
├── context/
│   ├── project.md
│   ├── architecture.md
│   ├── commands.md
│   ├── conventions.md
│   └── safety.md
├── state/
│   ├── current.md
│   └── history/
├── templates/
└── manifest.json
```

### Canonical files

- **`.agentfold/config.yaml`** — machine-readable settings, adapter selection, paths, and behavior.
- **`.agentfold/context/project.md`** — project purpose, scope, users, and domain terms.
- **`.agentfold/context/architecture.md`** — system boundaries, packages, data flow, and directory ownership.
- **`.agentfold/context/commands.md`** — setup, development, lint, test, build, and validation commands.
- **`.agentfold/context/conventions.md`** — coding rules, naming, testing, and contribution standards.
- **`.agentfold/context/safety.md`** — sensitive paths, prohibited actions, generated files, and confirmation rules.
- **`.agentfold/state/current.md`** — current task and latest checkpoint.
- **`.agentfold/state/history/`** — immutable progress and final checkpoints.
- **`.agentfold/state/completed/`** — completed-task archives; completed tasks cannot yet be reopened or deleted.
- **`.agentfold/manifest.json`** — hashes, adapter versions, schema version, and synchronization metadata.

---

## Example configuration

```yaml
version: 1

project:
  name: AgentFold
  summary: >
    A local-first CLI that synchronizes coding-agent instructions
    and preserves task progress across agent switches.
  repository: rootfold/agentfold

runtime:
  node: ">=20"

package_manager: pnpm

commands:
  install: pnpm install
  dev: pnpm dev
  build: pnpm build
  test: pnpm test
  lint: pnpm lint
  typecheck: pnpm typecheck

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

reliability:
  enabled: true
  maximum_events_per_repository: 1000
  retain_closed_sessions: 100
  interrupted_recovery_enabled: true

context:
  max_generated_tokens: 1800
  include_git_summary: true
  include_recent_decisions: 5

state:
  visibility: local
  history_limit: 30
  include_changed_paths: true
  include_diff_stat: true
  include_full_diff: false

safety:
  respect_gitignore: true
  excluded_paths:
    - .env
    - .env.*
    - "**/secrets/**"
    - "**/*.pem"
    - "**/*.key"
    - "**/credentials.json"
  require_confirmation_for:
    - dependency-install
    - migration
    - destructive-command

adapters:
  codex:
    enabled: true
    output: AGENTS.md

  claude:
    enabled: true
    output: CLAUDE.md

  antigravity:
    enabled: true
    mode: agents
    output: AGENTS.md

  gemini:
    enabled: true
    output: GEMINI.md

  copilot:
    enabled: true
    output: .github/copilot-instructions.md

  cursor:
    enabled: true
    output: .cursor/rules/agentfold.mdc

  generic:
    enabled: false
    output: AGENT_CONTEXT.md
```

The schema may evolve before `1.0.0`, but migrations must be explicit and tested.

---

## Active state format

`.agentfold/state/current.md` should remain readable without AgentFold.

```md
---
schema: 1
task_id: AF-20260720-001
title: Implement GitHub OAuth
status: active
branch: feature/github-oauth
base_branch: main
started_at: 2026-07-20T15:10:00+05:30
updated_at: 2026-07-20T17:42:00+05:30
last_agent: antigravity
head_commit: abc1234
---

# Objective

Add GitHub OAuth while preserving the existing email login flow.

# Completed

- Added GitHub provider configuration.
- Added callback route.
- Added environment validation.

# In progress

The OAuth callback succeeds, but the session cookie is not persisted.

# Decisions

- Reuse the existing session table.
- Keep account linking outside the current task.
- Do not modify the email login API contract.

# Changed files

- `src/auth/github.ts`
- `src/routes/auth.ts`
- `src/config/env.ts`
- `tests/auth/github.test.ts`

# Validation

- `pnpm lint` — passed
- `pnpm test auth` — one failing test

# Blockers

The callback test does not retain the cookie after redirect.

# Next actions

1. Inspect `SameSite` and `secure` cookie options.
2. Fix the callback integration test.
3. Run the complete authentication test suite.

# Unverified assumptions

- Production uses HTTPS at the reverse proxy.
```

The state records conclusions, not private chain-of-thought or complete chat transcripts.

---

## Adapter targets

| Adapter | Generated target | Priority |
|---|---|---:|
| Codex | `AGENTS.md` | P0 |
| Google Antigravity | `AGENTS.md` or `GEMINI.md` | P0 |
| Claude Code | `CLAUDE.md` | P0 |
| Generic Markdown | `AGENT_CONTEXT.md` | P0 |
| Gemini-compatible tools | `GEMINI.md` | P1 |
| GitHub Copilot | `.github/copilot-instructions.md` | P1 |
| Cursor | `.cursor/rules/agentfold.mdc` | P1 |
| Windsurf | Adapter to be validated | P2 |
| Cline / Roo Code | Adapter to be validated | P2 |
| OpenCode | Adapter to be validated | P2 |

Adapter mappings must be verified against official tool documentation before release. A tool-specific adapter is not considered supported until it has fixtures and integration tests.

---

## Adapter contract

Every adapter implements a small interface.

```ts
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly defaultOutputPath: string;

  detect(context: AdapterDetectContext): Promise<AdapterDetection>;
  validate(config: AgentFoldConfig): Promise<Diagnostic[]>;
  render(input: RenderInput): Promise<RenderedArtifact>;
}
```

A rendered artifact contains:

```ts
export interface RenderedArtifact {
  path: string;
  content: string;
  managedMode: "whole-file" | "managed-region";
  warnings: Diagnostic[];
}
```

Adapters must not directly write files. The core writer handles:

- Conflict detection
- Backups
- Dry runs
- Atomic writes
- Managed regions
- Hash updates
- Formatting
- User confirmation

---

## Safe file generation

AgentFold supports two generation strategies.

### Whole-file ownership

Used when AgentFold created the file and owns all content.

```md
<!-- Generated by AgentFold. Edit .agentfold/context instead. -->
```

### Managed-region ownership

Used when a user already has an instruction file.

```md
# Existing user content

This section remains untouched.

<!-- agentfold:start -->
Generated content appears here.
<!-- agentfold:end -->

# More existing user content
```

Rules:

1. Never modify content outside the managed region.
2. Refuse malformed or duplicated region markers.
3. Write through a temporary file and rename atomically.
4. Store the generated hash in `.agentfold/manifest.json`.
5. Show a diff before a destructive change.
6. Require `--force` for replacing an unmanaged file.
7. Offer a backup before takeover.

---

## Context composition

Generated instructions are composed from reusable sections:

```text
Project summary
Essential architecture
Commands
Critical conventions
Safety constraints
Active task summary, when enabled
Agent-specific guidance
```

Adapters may change formatting but must not change the meaning of canonical rules.

### Context priority

When output exceeds the configured budget, preserve content in this order:

1. Safety restrictions
2. Correct setup and validation commands
3. Current task objective and next actions
4. Architecture boundaries
5. Non-negotiable conventions
6. Relevant decisions
7. Secondary documentation
8. Examples and explanatory prose

AgentFold should report what was omitted.

---

## Conflict detection

The first doctor implementation can use deterministic heuristics.

Examples:

```text
Rule A: Always use pnpm.
Rule B: Install dependencies with npm.
```

```text
Rule A: Never edit generated migrations.
Rule B: Update files under migrations/ when schema changes.
```

Potential categories:

- Command mismatch
- Package-manager mismatch
- Path-ownership mismatch
- Always/never contradiction
- Generated-file contradiction
- Testing-requirement mismatch
- Security-rule contradiction

Potential conflicts are warnings unless the contradiction is unambiguous.

---

## Security and privacy

Security is part of the core product, not a later feature.

### Requirements

- No telemetry by default.
- No source upload.
- No model API calls in the core.
- Respect `.gitignore` by default.
- Never read common secret files during automatic scanning.
- Never include environment values in generated context.
- Store file paths, not secret contents.
- Do not store complete diffs in checkpoints by default.
- Redact likely tokens, API keys, private keys, and passwords from checkpoint text.
- Display which files will be read during deep scans.
- Require consent before reading outside the repository root.
- Avoid running project commands during `init` unless approved.
- Treat repository documentation and scripts as untrusted input.
- Never automatically install dependencies found during scanning.

### Secret detection

The initial implementation should include conservative patterns for:

- Private-key blocks
- Common API-key prefixes
- Assignment forms such as `TOKEN=...`
- Connection strings containing credentials
- Authorization bearer tokens
- Cloud credential files

A finding should stop generation when the content would be copied into an output file.

---

## Git behavior

AgentFold uses Git metadata but does not mutate history.

Allowed by default:

- Read repository root
- Read current branch
- Read current commit
- Read status
- Read changed paths
- Read diff statistics
- Read recent commit subjects

Require confirmation or an explicit command:

- Create a branch
- Commit files
- Stage files
- Change remotes
- Reset files
- Stash changes
- Modify hooks

AgentFold must never run destructive Git commands automatically.

---

## Local and tracked state

The user chooses how active state is stored.

### Local mode

```yaml
state:
  visibility: local
```

`.agentfold/state/` is added to `.gitignore`.

Best for one developer on one machine and for avoiding personal task notes in the repository.

### Tracked mode

```yaml
state:
  visibility: tracked
```

State is committed with the branch.

Best for moving between machines, cloud agents, team handoffs, and long-running pull requests.

The CLI must warn before tracked state contains suspicious sensitive information.

---

## Internal architecture

AgentFold begins as one TypeScript package with internal modules, not a premature monorepo.

```text
src/
├── cli/
│   ├── index.ts
│   ├── commands/
│   └── output/
├── core/
│   ├── config/
│   ├── context/
│   ├── state/
│   ├── sync/
│   ├── diagnostics/
│   └── filesystem/
├── adapters/
│   ├── codex/
│   ├── claude/
│   ├── antigravity/
│   ├── gemini/
│   ├── copilot/
│   ├── cursor/
│   └── generic/
├── scanners/
│   ├── git.ts
│   ├── node.ts
│   ├── python.ts
│   ├── repository.ts
│   └── secrets.ts
├── schemas/
├── templates/
└── utils/

tests/
├── unit/
├── integration/
├── fixtures/
└── snapshots/

docs/
├── concepts/
├── adapters/
├── configuration/
├── decisions/
└── security/
```

### Dependency direction

```text
CLI -> application/core -> domain utilities
                       -> adapter interfaces
Adapters -> adapter interfaces and render models
Scanners -> safe filesystem and process abstractions
```

Adapters must not import CLI code. Core logic must be testable without spawning the actual CLI.

---

## Proposed technology stack

- **Language:** TypeScript
- **Runtime:** Node.js 20 or newer
- **Package manager:** pnpm
- **CLI framework:** Commander
- **Schema validation:** Zod
- **YAML:** yaml
- **File discovery:** fast-glob
- **Process execution:** execa
- **Interactive prompts:** `@inquirer/prompts`
- **Terminal output:** picocolors
- **Build:** tsup
- **Testing:** Vitest
- **Linting:** ESLint
- **Formatting:** Prettier
- **Release:** Changesets
- **CI:** GitHub Actions

Keep production dependencies small. Adding a production dependency requires a clear reason.

---

## Engineering rules

### TypeScript

- Enable strict mode.
- Avoid `any`; use `unknown` and narrow it.
- Validate all file-based input at the boundary.
- Use discriminated unions for diagnostics and adapter results.
- Keep filesystem and process access behind injectable interfaces.
- Prefer pure functions for parsing, merging, and rendering.
- Avoid hidden global state.

### Error handling

- Expected user errors produce concise messages and non-zero exit codes.
- Unexpected errors include a stack trace only in debug mode.
- Never expose secret values in errors.
- Every interactive command supports cancellation.
- Partial writes are prevented through atomic writes.

### Output

- Human-readable output is the default.
- Automation commands support `--json`.
- Colors are disabled when unsupported or `NO_COLOR` is set.
- `--quiet` suppresses non-essential messages.
- `--debug` adds diagnostic detail without secret contents.

### Cross-platform support

The project must work on Windows PowerShell, macOS, and Linux. Use Node path utilities and avoid hardcoded shell-specific behavior in core logic.

---

## Testing strategy

### Unit tests

Required for:

- Configuration parsing
- Schema migration
- Context merging
- Priority trimming
- Managed-region replacement
- Conflict detection
- Secret redaction
- State parsing
- Adapter rendering
- Path normalization

### Integration tests

Required for:

- `init` in an empty fixture repository
- `init` with existing agent files
- `sync` generation
- `sync --check`
- `checkpoint` with clean and dirty Git states
- `resume` packet generation
- Local versus tracked state
- Windows-style paths
- Atomic-write failure behavior

### Fixtures

Fixtures should cover:

- Node project
- Python project
- Mixed monorepo
- Existing `AGENTS.md`
- Existing `CLAUDE.md`
- Conflicting instruction files
- Secret-like test content
- Repository without Git
- Detached HEAD
- Filenames with spaces
- Nested packages

---

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Success |
| `1` | General or unexpected failure |
| `2` | Invalid configuration |
| `3` | Synchronization drift |
| `4` | Unsafe content detected |
| `5` | File conflict requiring user action |
| `6` | Git state conflict |
| `130` | User cancellation |

---

## MVP scope

The first public usable release must prove both halves of AgentFold.

### Instruction synchronization

- [ ] `agentfold init`
- [ ] Canonical configuration
- [ ] Modular context files
- [ ] Codex adapter
- [ ] Claude Code adapter
- [ ] Antigravity adapter
- [ ] Generic Markdown adapter
- [ ] Safe managed regions
- [ ] `agentfold sync`
- [ ] `agentfold sync --check`

### Cross-agent continuity

- [ ] `agentfold start`
- [ ] Current task state
- [ ] Git metadata capture
- [ ] `agentfold checkpoint`
- [ ] Checkpoint history
- [ ] `agentfold resume`
- [ ] Target-specific handoff packet
- [ ] `agentfold finish`

### Quality and safety

- [ ] `agentfold doctor`
- [ ] Basic conflict detection
- [ ] Stale-output detection
- [ ] Context-budget reporting
- [ ] Secret scanning and redaction
- [ ] Windows, macOS, and Linux CI
- [ ] Useful error messages
- [ ] Example repository
- [ ] Terminal demo GIF
- [ ] Complete installation and usage docs

---

## Definition of done for `v0.1.0`

`v0.1.0` is ready when a developer can:

1. Execute AgentFold through `npx`.
2. Run `agentfold init` in an existing repository.
3. Review and edit the canonical context.
4. Generate instructions for Codex, Claude Code, Antigravity, and generic Markdown.
5. Start a task.
6. Save a checkpoint with Git metadata and a concise summary.
7. Switch agents and receive a useful resume packet.
8. Detect stale generated files in CI.
9. Run the workflow on Windows, macOS, and Linux.
10. Complete the workflow without an API key or cloud account.
11. Preserve existing unmanaged instruction content.
12. Prevent likely secrets from being copied into generated files.

---

## Implementation milestones

### Milestone 0 — Foundation

- Scaffold the TypeScript CLI.
- Configure linting, formatting, testing, build, and CI.
- Add the command registry and output abstraction.
- Add filesystem and Git abstractions.
- Add the configuration schema and fixtures.

### Milestone 1 — Canonical context

- Implement `init`.
- Add safe repository detection.
- Add Node and Python metadata scanners.
- Create canonical context templates.
- Add configuration validation.

### Milestone 2 — Synchronization

- Define the adapter interface.
- Implement Generic, Codex, Claude, and Antigravity adapters.
- Add the managed-region writer.
- Add the manifest and hashes.
- Implement `sync`, `--dry-run`, and `--check`.

### Milestone 3 — Continuity

- Implement the task-state schema.
- Add `start`, `checkpoint`, `resume`, and `finish`.
- Add Git metadata collection.
- Add history snapshots.
- Add Markdown and JSON handoff output.

### Milestone 4 — Diagnostics

- Implement the doctor framework.
- Add drift, missing-command, path, conflict, and context-size checks.
- Add secret scanning and redaction.
- Add machine-readable diagnostics.

### Milestone 5 — Public launch

- Add Copilot, Gemini, and Cursor adapters.
- Build an example repository.
- Record a terminal demonstration.
- Publish the npm package.
- Create the first tagged release.
- Open Discussions and contribution issues.

---

## Future roadmap

### `v0.2`

- More adapters
- Import existing instruction files
- Context profiles such as frontend, backend, review, and testing
- Better contradiction analysis
- Task templates
- Shell completion
- GitHub Action

### `v0.3`

- MCP server
- Editor integration
- Agent-written structured checkpoints
- Pull-request handoff summaries
- Optional encrypted local state
- Workspace and monorepo scopes

### Later

- Plugin SDK for community adapters
- Optional local-model assistance
- Team policy layers
- Signed organizational templates
- Context-effectiveness benchmarks
- Web documentation and interactive playground

---

## Why not only use `AGENTS.md`?

`AGENTS.md` is an excellent shared convention for durable repository guidance, and AgentFold should support it first.

AgentFold adds three missing capabilities:

1. **Generation:** produce other tool-specific formats from the same source.
2. **Drift detection:** show when files disagree or are outdated.
3. **Live continuity:** preserve the current task, decisions, validation, and next actions across sessions.

AgentFold complements open instruction formats rather than replacing them.

---

## Why not store everything in the README?

README files are primarily for people discovering and using a project. Agent instructions need concise operational rules, while active task state changes frequently.

```text
README.md                    -> product and human documentation
.agentfold/context/*         -> canonical project knowledge
Generated instruction files -> agent-specific operational context
.agentfold/state/*           -> active task continuity
```

---

## Why not use an AI model to summarize every session?

That would introduce cost, provider dependence, privacy concerns, non-determinism, API-key setup, and another source of failure.

The MVP uses structured checkpoints and Git metadata. Optional AI summarization may be introduced later as a plugin, not a core requirement.

---

## Example daily workflow

```bash
# Begin work with Antigravity
agentfold start "Build repository import"
agentfold resume --for antigravity --copy

# Work normally...

# Save progress before the free limit is reached
agentfold checkpoint --agent antigravity

# Continue with Codex
agentfold resume --for codex --copy

# Work normally...

# Save progress again
agentfold checkpoint --agent codex

# Verify project context
agentfold doctor
agentfold sync --check

# Finish the task
agentfold finish
```

---

## Instructions for coding agents working on AgentFold

When an AI coding agent is asked to build this repository, it must:

1. Read this README before proposing architecture or implementation.
2. Treat the MVP scope and milestone order as the source of truth.
3. Avoid building a graphical interface before the CLI is reliable.
4. Avoid adding an LLM API dependency to the core.
5. Never implement proprietary chat-history scraping.
6. Keep the canonical format vendor-neutral.
7. Keep adapters isolated from filesystem writes.
8. Preserve existing user files by default.
9. Include tests with every parser, renderer, writer, and state change.
10. Maintain Windows compatibility.
11. Avoid production dependencies without justification.
12. Never read or print secret values in tests or logs.
13. Complete one milestone in reviewable steps rather than scaffolding every feature.
14. Update this README when a deliberate product-level decision changes.
15. Record important implementation decisions in `docs/decisions/`.

### First implementation task

The first coding agent should:

1. Scaffold the Node.js and TypeScript CLI.
2. Configure pnpm, strict TypeScript, ESLint, Prettier, Vitest, tsup, and GitHub Actions.
3. Implement only:
   - CLI entry point
   - `--help`
   - `--version`
   - `doctor` placeholder
   - Configuration schema skeleton
   - Filesystem abstraction
4. Add tests for command startup and configuration parsing.
5. Avoid implementing adapters until the core boundaries are reviewed.

---

## Contributing

Before opening a pull request:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

A pull request should:

- Solve one focused problem
- Include tests
- Avoid unrelated formatting changes
- Document user-visible behavior
- Preserve backward compatibility where practical
- Explain new production dependencies
- Update adapter fixtures when generated output changes

---

## Commit convention

Use Conventional Commits:

```text
feat: add codex adapter
fix: preserve content outside managed region
docs: explain tracked state mode
test: add Windows path fixtures
refactor: isolate atomic file writer
chore: configure release workflow
```

---

## Versioning

AgentFold uses semantic versioning.

Before `1.0.0`, configuration and CLI behavior may change. Breaking changes must include:

- A clear changelog entry
- A migration path where practical
- A schema version update when stored files change
- Tests for old and new formats

---

## License

AgentFold is released under the **MIT License**. See [LICENSE](LICENSE).

---

## Project identity

**Organization:** RootFold  
**Project:** AgentFold  
**Repository:** `rootfold/agentfold`

### Primary tagline

> One project context. Every coding agent. Every session.

### Alternate tagline

> Switch agents, not context.

### One-sentence description

> AgentFold synchronizes project instructions and preserves live development progress across Codex, Claude Code, Antigravity, Copilot, Gemini, Cursor, and other coding agents.

---

## Final product promise

A developer should be able to stop working in one coding agent, open another, and continue without re-explaining the project or rediscovering the current task.

That is the standard every AgentFold feature should serve.
