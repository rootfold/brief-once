# Local MCP integration

`agentfold mcp` exposes the existing AgentFold continuity engine to MCP-capable desktop applications, IDEs, and coding agents. MCP itself runs locally over stdio: there is no public network listener, telemetry, source upload, remote service, or AI model call. It can delegate to the authenticated [shared local service](../service.md) over a named pipe or Unix-domain socket.

## Available tools

- `agentfold_get_status` reads initialization, active-task, and checkpoint status.
- `agentfold_get_context` returns bounded canonical project context.
- `agentfold_open_session` creates minimal in-memory lifecycle metadata and returns project or continuation status.
- `agentfold_begin_task` creates validated active-task state.
- `agentfold_report_progress` validates, redacts, and merges structured semantic progress.
- `agentfold_create_checkpoint` captures bounded Git facts and immutable semantic state.
- `agentfold_finish_task` validates readiness, creates a final checkpoint and completed archive, then clears active state.
- `agentfold_get_resume_packet` reads a deterministic JSON or Markdown continuation packet.
- `agentfold_close_session` optionally reports, checkpoints, returns a resume packet, and marks the in-memory session closed.

The recommended lifecycle is open session, continue a matching active task or explicitly begin a requested new task, and report meaningful progress. Use `agentfold_finish_task` only when the requested scope is complete, blockers and in-progress entries are resolved, and required validation is honestly reported. The session remains open, so a later substantive request can begin a new task. Use `agentfold_close_session` with checkpointing when work is paused, incomplete, blocked, uncertain, or handed off. Closing after a successful finish creates no extra checkpoint. Reports contain concise engineering conclusions—not private chain of thought, secrets, full conversations, or terminal transcripts.

Successful lifecycle outcomes record only bounded reliability metadata. Shared
service mode persists interruption recovery across service restarts. Embedded
mode records basic events through the same host-neutral recorder but cannot
recover its in-memory sessions after the MCP process exits. Inspect observed
activity with `agentfold reliability`; no reliability MCP tool is added.

One MCP process serves exactly one Git repository. The workspace is resolved and locked before the first workspace-dependent tool call, tools cannot switch it, and normal results contain only repository-relative paths. AgentFold never stages, commits, resets, stashes, pushes, creates branches, edits hooks, or changes remotes.

## Run locally

During development:

```bash
pnpm agentfold mcp --workspace .
```

Service selection defaults to `auto`:

```bash
pnpm agentfold mcp --workspace . --service auto
pnpm agentfold mcp --workspace . --service required
pnpm agentfold mcp --workspace . --service disabled
```

`auto` chooses the service only at startup and warns on stderr before embedded fallback. `required` is intended for future installed connectors. `disabled` preserves the original per-process in-memory session behavior. A lost service connection never triggers a mid-session fallback.

Installed connectors can request a bounded service start before the MCP handshake:

```bash
agentfold mcp --service required --ensure-service --workspace-mode auto
```

`--ensure-service` is valid only with `auto` or `required`. It reuses a compatible service or invokes the existing local start operation and waits for readiness; it does not install an operating-system service or login startup item.

Workspace modes are:

- `fixed`: use an explicit `--workspace`, or the current directory for backward-compatible direct use.
- `auto`: prefer exactly one valid initialized repository from client roots, then fall back to the current directory.
- `roots`: require exactly one valid initialized repository from client `file://` roots.
- `cwd`: resolve the initialized repository containing the process current directory.

Client roots are treated only as discovery input. AgentFold decodes and validates file URIs, resolves real paths and Git roots, rejects ambiguity and paths outside the selected repository, and locks the first canonical repository for the process lifetime. A roots-change notification never silently switches the workspace.

From a production build:

```bash
node dist/cli.js mcp --workspace /absolute/path/to/project
```

An installed package uses the existing binary:

```bash
agentfold mcp --workspace /absolute/path/to/project
```

Add `--debug` for safe lifecycle messages on standard error. Standard output remains exclusively MCP JSON-RPC traffic. `NO_COLOR` is respected by the surrounding CLI, and MCP protocol results never include ANSI formatting.

## Generic host configuration

Host application configuration formats vary. This unverified generic example illustrates the command shape only:

```json
{
  "mcpServers": {
    "agentfold": {
      "command": "agentfold",
      "args": ["mcp", "--workspace", "/absolute/path/to/project"]
    }
  }
}
```

For an AgentFold development checkout after `pnpm build`:

```json
{
  "mcpServers": {
    "agentfold": {
      "command": "node",
      "args": [
        "/absolute/path/to/AgentFold/dist/cli.js",
        "mcp",
        "--workspace",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

Do not assume either snippet matches a particular application without checking that host's supported MCP configuration mechanism.

## Current limitations

Service session metadata remains intentionally in memory and is lost on service restart. Shutdown does not create a report or checkpoint solely because the process is stopping. Completed tasks cannot be reopened or deleted. There is no watcher, HTTP transport, operating-system service installer, or generic IDE connector. Embedded mode still has per-process sessions and no cross-application automation.
