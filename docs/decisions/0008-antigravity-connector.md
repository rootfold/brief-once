# ADR 0008: Safe Antigravity connector

> AgentFold was renamed BriefOnce. Compatibility identifiers described in this
> decision remain unchanged.

- Status: accepted
- Date: 2026-07-21
- Official documentation inspected: 2026-07-21

## Context

AgentFold's continuity core, stdio MCP server, and shared local service can coordinate separate agent processes, but a host still needs a local MCP launch entry and workspace guidance that invokes the lifecycle tools.

Antigravity is the first connector because Google documents local stdio MCP servers, global and workspace MCP configuration, workspace rules, and explicit tool approval across desktop, IDE, and CLI surfaces. The connector remains an installation, verification, and removal layer. It does not reimplement tasks, reports, checkpoints, Git inspection, session leases, service authentication, or resume rendering.

## Official evidence

The following Google documentation was inspected on 2026-07-21:

- [Model Context Protocol](https://antigravity.google/docs/mcp) — local `command` plus `args`, `mcpServers`, current central `~/.gemini/config/mcp_config.json`, workspace `.agents/mcp_config.json`, and Ask-mode tool approval.
- [Rules](https://antigravity.google/docs/ide-rules) — global `~/.gemini/GEMINI.md`, workspace `.agents/rules/`, Markdown rules, and Always On activation.
- [Gemini CLI migration](https://antigravity.google/docs/gcli-migration) — the CLI transition and dedicated `~/.gemini/antigravity-cli/mcp_config.json` path.
- [Getting Started with Antigravity IDE](https://codelabs.developers.google.com/getting-started-agy-ide) — IDE raw MCP configuration and refresh workflow.
- [Accelerating Development with Antigravity CLI](https://codelabs.developers.google.com/genai-for-dev-antigravity-cli) — CLI `/mcp`, global and workspace configuration, and local stdio examples.

The general MCP documentation identifies the central configuration for desktop, IDE, and CLI, while CLI-specific material still identifies a dedicated transition path. Configuration locations are therefore evidence-ranked discovery candidates, not permanent constants. When both files exist, automatic installation refuses to guess. `--surface all` explicitly targets every independently detected configuration.

## Decision

### One global server entry

The connector installs one `agentfold` server key using an absolute Node.js executable, a verified AgentFold CLI entry, and argument arrays:

```text
mcp --service required --ensure-service --workspace-mode auto
```

No repository path is stored globally, so one entry supports multiple repositories.

### Dynamic, locked workspace selection

The MCP process resolves one repository from an explicit workspace, one valid client root, or its current directory according to the selected mode. Roots are discovery hints, not security boundaries: AgentFold still resolves real paths, locates Git, and validates initialization. The selected repository is locked for the process lifetime; roots changes never silently switch it.

### Always-active workspace rule

The connector owns `.agents/rules/agentfold-continuity.md`. A workspace rule is used because lifecycle guidance should be active for substantive work without requiring a user-triggered skill. It distinguishes coding work from lightweight questions, directs complete work to finish and unfinished work to checkpoint-and-close, and forbids private reasoning, secrets, automatic commits, and pushes.

The rule cannot guarantee model compliance. First-use approval, a disabled MCP server, or ignored instructions can prevent semantic reports. Heartbeat-timeout recovery remains the fallback and may be Git-only when no semantic report exists. AgentFold never scrapes conversations or infers private reasoning.

### Safe editing, ownership, and removal

Discovery, planning, editing, and CLI presentation remain separate. Preview is the default. Installation uses exact-byte backups outside the repository, format-preserving JSON edits, atomic writes, and a restrictive user-scoped ownership record containing only fingerprints and safe identities. Host configuration is never logged.

Disconnect removes only content whose current fingerprint matches recorded ownership. It does not restore the full backup because that could erase later host changes. A shared global entry remains while another connected workspace depends on it.

### Service auto-start without OS installation

The MCP bridge performs an authenticated availability check and uses the existing bounded service-start operation for `--ensure-service`. This avoids a Windows Service, scheduled task, login item, launchd agent, or systemd unit. Embedded MCP remains available for direct users.

### Host approval remains host-controlled

The connector does not change Antigravity permission settings, enable wildcard approval, or bypass prompts. Users inspect and approve AgentFold tools when Antigravity asks.

## Consequences

- Multiple Antigravity configuration generations are supported without guessing between conflicting evidence.
- Credentials and unrelated configuration remain byte-preserved and are never printed.
- Ambiguous or unresolved workspaces fail safely.
- Host ingestion cannot be proven without a documented non-interactive API, so verification returns manual refresh steps.
- Future connectors may reuse stable action-plan, launch-descriptor, ownership-summary, and workspace-mode types without importing Antigravity internals.
