# Codex connector

AgentFold can register its local MCP server for Codex CLI, the Codex IDE extension, and the ChatGPT desktop app, then install a repository-root lifecycle region for Codex.

The implementation follows official OpenAI documentation inspected on 2026-07-21. See [ADR 0009](../decisions/0009-codex-connector.md) for source URLs and decisions.

## Supported surfaces

- `cli`
- `ide`
- `app`
- `auto`
- `all`

All three concrete surfaces use the same user-level Codex configuration, normally `~/.codex/config.toml` or `CODEX_HOME/config.toml`. Discovery uses that shared file plus bounded executable, app, and IDE-extension evidence. An explicit surface remains available when automatic evidence is absent. The Antigravity-only `desktop` name is rejected for Codex.

## Preview and installation

```bash
agentfold connect codex
agentfold connect codex --dry-run
agentfold connect codex --surface cli
agentfold connect codex --surface all --yes
```

Default and `--dry-run` behavior is read-only. Preview validates AgentFold initialization, Codex discovery, worktree identity, a production launch descriptor, TOML syntax, managed-region ownership, `AGENTS.md`, repository boundaries, symlinks, and connector state. It prints safe labels and action descriptions, never config content or absolute repository paths.

`--yes` revalidates previewed bytes, backs up an existing config, atomically writes the TOML region and `AGENTS.md` region, atomically updates ownership, and verifies the live MCP boundary. There is no `--force`.

## Codex TOML behavior

The global `mcp_servers.agentfold` entry launches:

```text
agentfold mcp --service required --ensure-service --workspace-mode auto
```

The stored form uses a verified absolute executable plus argument array. It has no shell string, `npx`, download, `@latest`, repository path, token, or forwarded environment value.

AgentFold parses TOML but edits only between:

```text
# agentfold:codex:start schema=1
# agentfold:codex:end
```

Comments, profiles, providers, environment settings, unrelated MCP servers, fake or real secret-bearing values, UTF-8 BOM, LF/CRLF, and final-newline behavior are preserved outside the region. Missing config is created minimally. Identical content is idempotent. A recognized old region can be upgraded. Malformed TOML, duplicate markers, user-owned `agentfold`, or modified owned content is rejected without writes.

Exact config backups live in restrictive AgentFold user state outside the repository. Backup contents are never printed or placed in project files.

## `AGENTS.md` lifecycle

AgentFold owns only this region in repository-root `AGENTS.md`:

```text
<!-- agentfold:codex:start schema=2 -->
...
<!-- agentfold:codex:end -->
```

The instructions tell Codex to open a session before substantive edits, continue a relevant task, begin only when necessary, and report meaningful milestones. Fully complete work uses `agentfold_finish_task`; paused, incomplete, blocked, uncertain, or handed-off work uses `agentfold_close_session` with checkpointing. After finish, a new substantive request begins a new task in the same open session. They forbid private chain of thought, complete conversations, secrets, environment values, automatic commits or pushes, discarded work, task-per-message behavior, and replacing unrelated work without confirmation.

User content outside the region is preserved byte-for-byte where practical. Missing files are created; existing files are appended; identical regions are unchanged; modified or duplicate regions are conflicts. AgentFold does not install a Codex skill, plugin, hook, `notify` handler, or IDE extension.

## Worktrees

AgentFold distinguishes the main checkout from linked worktrees using read-only `git rev-parse` commands. Every worktree is a separate mutable workspace and gets independent `AGENTS.md` ownership. Only a hash of the common Git directory is retained as a repository-family identifier.

The connector never copies, applies, merges, cherry-picks, commits, pushes, or discards work between checkouts. A linked-worktree warning reminds you that an application opened elsewhere cannot see this worktree's uncommitted changes.

## Verification

```bash
agentfold verify codex
```

Verification is read-only. It checks:

- complete AgentFold initialization;
- hashed ownership and current worktree identity;
- one owned TOML region and its executable descriptor;
- the owned `AGENTS.md` region;
- service auto-start and authenticated local IPC;
- official SDK MCP initialization and workspace roots;
- all nine AgentFold tools and `agentfold_get_status`;
- read-only `codex mcp list --json` when a Codex CLI executable is available.

CLI, IDE, and app results are reported separately. Static verification cannot prove a running UI has reloaded config. After installation or an update:

1. Restart Codex desktop, or restart the Codex IDE extension.
2. Open MCP servers (or use `/mcp` in the CLI/TUI).
3. Confirm `agentfold` is present and enabled.
4. Inspect the nine lifecycle tools.

## Disconnect

```bash
agentfold disconnect codex
agentfold disconnect codex --dry-run
agentfold disconnect codex --surface cli
agentfold disconnect codex --yes
```

Disconnect is preview-only without `--yes`. It rechecks fingerprints and removes only proven AgentFold regions. Modified content is preserved as a conflict. Removing one repository or surface keeps the shared global MCP region while another ownership dependency remains. The historical backup is not restored wholesale, the shared service is left running, and Antigravity state is unchanged.

## MCP tools and continuity

Codex consumes the nine tools: status, bounded canonical context, open session, begin task, progress report, checkpoint, finish, resume packet, and close session. Finish archives completed work and keeps the host session open; close with checkpoint enabled preserves unfinished work for a later Antigravity or other connected client. The connector does not duplicate this logic.

Use `agentfold reliability --host codex` to inspect only Codex sessions that
actually contacted AgentFold. A missing session cannot be treated as proof that
Codex ignored the connector. Shared-service restart recovery may preserve the
latest work as a recovery checkpoint without inventing a report or finishing the
task.

## Privacy and current limits

- Local stdio MCP and authenticated local IPC only; no remote MCP or HTTP listener.
- No source upload, telemetry, cloud sync, network request, model API, or chat scraping.
- No automatic commits, pushes, Git hooks, worktree copying, or merging.
- No desktop/IDE loaded-state claim without an official non-interactive API.
- Instructions guide Codex but cannot guarantee model compliance.
- A disabled MCP server or stale host process requires manual restart or refresh.
