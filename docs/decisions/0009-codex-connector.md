# ADR 0009: Safe Codex connector

> AgentFold was renamed BriefOnce. Compatibility identifiers described in this
> decision remain unchanged.

- Status: accepted
- Date: 2026-07-21
- Official documentation inspected: 2026-07-21

## Context

AgentFold exposes nine continuity tools through a local stdio MCP server and coordinates clients through an authenticated local service. Codex needs only a stable global MCP registration and repository instructions; it must not gain a separate implementation of tasks, reports, checkpoints, completion archives, resume packets, heartbeats, or recovery.

Codex CLI, the IDE extension, and the ChatGPT desktop app share Codex configuration for the same host. Codex also reads repository-root `AGENTS.md`, while Git worktrees are independent working directories with shared Git metadata. These facts permit one global MCP entry with one instruction region per worktree.

## Official evidence

The following OpenAI sources were inspected on 2026-07-21:

- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp) — shared desktop/CLI/IDE MCP configuration, local stdio servers, `~/.codex/config.toml`, `[mcp_servers.<name>]`, restart steps, and `codex mcp list`.
- [Configuration basics](https://learn.chatgpt.com/docs/config-file/config-basic) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) — user and trusted project layers, precedence, `command`, `args`, `required`, and other MCP fields.
- [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) — stable `codex mcp` list/add/get/remove/authentication commands. The installed Codex CLI 0.144.6 was also inspected with read-only `--version` and help commands; `codex mcp list --json` is available.
- [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) — global then project-root-to-working-directory discovery, override precedence, and restart/new-session behavior.
- [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) — separate mutable checkouts sharing Git metadata and desktop handoff behavior.
- [Build skills](https://learn.chatgpt.com/docs/build-skills), [Build plugins](https://learn.chatgpt.com/docs/build-plugins), and [Hooks](https://learn.chatgpt.com/docs/hooks) — distinct extensibility and lifecycle mechanisms deliberately excluded from this connector.
- The official [`openai/codex` configuration documentation](https://github.com/openai/codex/blob/main/docs/config.md), [Rust CLI README MCP section](https://github.com/openai/codex/blob/main/codex-rs/README.md#model-context-protocol-support), and [configuration implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs) — repository confirmation of config layering, MCP client support, `CODEX_HOME`, and `mcp_servers`.

## Decision

### One global, shared MCP entry

AgentFold owns one marked region in `CODEX_HOME/config.toml` (normally `~/.codex/config.toml`):

```toml
# agentfold:codex:start schema=1
[mcp_servers.agentfold]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/agentfold/dist/cli.js", "mcp", "--service", "required", "--ensure-service", "--workspace-mode", "auto"]
required = true
# agentfold:codex:end
```

The entry contains no repository path, token, forwarded environment value, shell command, package-manager shim, download, or `npx`. CLI, IDE, and app surface records deduplicate to this one file. Multiple repositories are dependencies of the same entry.

### Targeted TOML and Markdown editing

TOML is parsed for syntax and collision detection but never reserialized wholesale. AgentFold inserts or replaces only its marked region and preserves all bytes outside it, including comments, profiles, provider settings, environment settings, unrelated MCP servers, secret-bearing values, BOM, line endings, and final-newline behavior. Duplicate markers, malformed TOML, user-owned `mcp_servers.agentfold`, and unproven modifications are conflicts.

The repository-root `AGENTS.md` uses a separate marked region. It directs Codex to use the existing AgentFold MCP lifecycle for substantive changes, preserves lightweight and read-only interactions, and forbids private reasoning, conversations, secrets, automatic Git publication, discarded work, and unrelated task replacement. No skill, plugin, hook, `notify` command, or IDE extension is installed.

### Worktree identity

The connector runs only read-only Git inspection:

```text
git rev-parse --show-toplevel
git rev-parse --git-common-dir
git rev-parse --git-dir
```

The real worktree root is hashed as the mutable workspace identity. The common Git directory is hashed only as a repository-family identity. Different worktrees therefore receive independent `AGENTS.md` ownership and AgentFold workspace/session selection; they never trigger implicit copying, merging, cherry-picking, or branch operations. Linked-worktree output warns that another checkout cannot see current uncommitted changes.

### Ownership, backup, rollback, and removal

Before changing an existing Codex config, AgentFold stores an exact restrictive backup outside the repository. `codex-ownership.json` stores only connector version, selected surfaces, hashed config/worktree/family identities, managed-region fingerprints, backup identity, executable fingerprint, worktree kind, and timestamp. It stores no config content, paths, tokens, secrets, or service credentials.

Apply revalidates previewed bytes immediately before atomic writes. A later failure rolls back config, `AGENTS.md`, and ownership; rollback failure produces a severe diagnostic. Disconnect removes only fingerprint-proven regions, never restores an entire historical backup, leaves the shared service running, and retains the global region while any repository still depends on it. Antigravity ownership is a separate file and is untouched.

### Verification boundaries

Verification checks initialization, ownership, exact managed fingerprints, the executable descriptor, worktree identity, direct MCP initialization through the official SDK, all nine tools, `agentfold_get_status`, workspace auto-resolution, and service auto-start. When a Codex executable is safely discovered, it also runs read-only `codex mcp list --json` with the selected `CODEX_HOME`.

Static config verification does not prove that an already-running desktop app or IDE extension has reloaded the file. AgentFold reports each selected surface separately and asks the user to restart or refresh Codex before confirming `agentfold` is enabled.

## Consequences

- One local registration works across repositories and supported Codex surfaces.
- Existing user TOML and repository instructions remain outside connector ownership.
- Each worktree is isolated for mutable state while retaining a safe family relationship.
- User-owned or modified content is never overwritten by `--force`; no such option exists.
- Codex host ingestion and model compliance still require manual confirmation.
- No plugin, skill, hook, IDE extension, OS service, network MCP transport, telemetry, model API, chat scraping, or automatic Git operation is introduced.
