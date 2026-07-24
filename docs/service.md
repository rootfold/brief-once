# Shared local service

`agentfold service` is a user-scoped local coordinator for multiple AgentFold MCP processes and repositories. It delegates continuity work to the same validated core used by direct CLI and embedded MCP operation.

```text
Codex MCP -----------+
Antigravity MCP -----+--> authenticated local IPC --> AgentFold core --> .agentfold/state
future IDE ----------+
```

The service keeps live coordination in memory and persists only a bounded
private session-recovery journal plus safe lifecycle events in AgentFold's
user-scoped state directory. Project context, report text, source files, diffs,
and checkpoints are not copied there. See
[reliability monitoring](reliability.md).

## Commands

Start a detached service and wait until its authenticated ping succeeds:

```bash
agentfold service start
```

Inspect it without trusting a PID file alone:

```bash
agentfold service status
```

Run it in the foreground for development or diagnostics:

```bash
agentfold service run --debug
```

Request graceful shutdown and wait for runtime cleanup:

```bash
agentfold service stop
```

Starting an already-running compatible service and stopping an already-stopped service both succeed. Shutdown does not create checkpoints merely because the service is stopping.

## Runtime directories and local IPC

- Windows uses `%LOCALAPPDATA%\AgentFold\runtime` and a named pipe derived from a hash of the runtime path.
- macOS uses `~/Library/Application Support/AgentFold` and a Unix-domain socket.
- Linux prefers `$XDG_RUNTIME_DIR/agentfold`; otherwise it uses `$XDG_STATE_HOME/agentfold` or `~/.local/state/agentfold`.
- `AGENTFOLD_RUNTIME_DIR` provides an advanced/test override.

Persistent reliability state is separate from the transient IPC runtime:
`%LOCALAPPDATA%\AgentFold\state` on Windows,
`~/Library/Application Support/AgentFold/state` on macOS, and
`$XDG_STATE_HOME/agentfold` or `~/.local/state/agentfold` on Linux.
`AGENTFOLD_STATE_DIR` is an advanced/test override.

Runtime directories may not resolve through an unsafe symbolic link. Fixed macOS system aliases such as `/var` to `/private/var` are canonicalized, while symlinks beneath them remain unsafe. Directories use mode `0700`, and metadata and Unix sockets use `0600`, where supported. No runtime file is placed in a project repository.

The private IPC protocol uses one validated JSON request and one response per connection. Messages are limited to 1 MiB, read and operation timeouts are bounded, and malformed JSON, unknown methods, invalid parameters, oversized messages, authentication failures, and protocol mismatches receive safe errors without stack traces. The service never opens localhost or any other TCP port.

## Authentication and compatibility

Startup creates at least 256 bits of random capability-token material in atomically written runtime metadata. The token is timing-safely compared and never appears in logs, `service status`, MCP results, or public API status. Clients verify an authenticated ping, protocol version, endpoint kind, and compatible package major version before a repository operation.

Absolute repository roots remain internal. Repositories are identified externally by a stable truncated SHA-256 identity of their canonical real path.

## Sessions, leases, and heartbeats

A service session records client and agent labels, repository ID, target, timestamps, lease, active task ID, and lifecycle state. It does not record prompts, conversations, source content, private reasoning, or call transcripts.

Defaults are:

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

Existing configuration without `automation` remains valid and receives these
defaults in memory. Heartbeats refresh lifecycle timestamps only. Journal
persistence is debounced, so a normal 20-second heartbeat does not rewrite
private state every time. MCP starts heartbeats after a successful session open,
stops them after a successful close, and sends a best-effort detach when stdio
disconnects. Detach does not invent a report or immediately checkpoint.

## Agent switches and stale recovery

When a different agent opens a fresh session for the same repository, the service serializes the transition with other repository writes. If an active task exists, it calls the existing checkpoint core with current persisted semantic state and bounded Git facts. Success or duplicate suppression supersedes the previous session, and the new session receives the latest immutable resume packet. Failure leaves the previous metadata intact, opens the new session with a partial-success warning, and can return only a previously valid checkpoint.

When an open or detached lease expires, the service marks it recovery-pending and applies the same checkpoint boundary. No active task means no checkpoint. Success, duplicate suppression, or minimum-interval suppression closes the stale session; a failure is deferred for a bounded retry rather than looped tightly.

Automatic checkpoints never infer semantic conclusions. Freshness remains `new`, `reused`, or `none` according to the persisted structured report revision. They do not mutate Git.

## Recovery across service restarts

Each service startup creates a collision-resistant instance identity. Sessions
left open, detached, or recovery-pending by a prior instance are marked
interrupted. The service becomes ready without recursively blocking on every
repository; the next session open or bounded background lease scan evaluates
one repository at a time through the existing operation queue.

Stored repository roots are private, realpath-validated, and required to match
the original hashed repository identity. No active task, a different active
task, or an unchanged checkpoint fingerprint creates no new checkpoint.
Meaningful changes use the existing checkpoint core and persisted semantic
state. Recovery never finishes or clears a task and never mutates Git.

Failures remain recovery-pending. Automatic retries are delayed by at least one
minute, stop after three attempts, and never prevent a new session from opening.
The latest previously valid immutable checkpoint remains the only resume source.

## Finished tasks

`agentfold_finish_task` runs through the same per-repository operation queue as reports and checkpoints. It creates a lifecycle-distinct final checkpoint and `.agentfold/state/completed/<task-id>.md`, then removes active state. The service clears the session's active task but keeps the session open, allowing the next substantive request to begin a fresh task. `agentfold_close_session` then closes without inventing another report or checkpoint. Incomplete, blocked, paused, or handed-off work should use the existing close-and-checkpoint path instead.

Set `automation.enabled: false` to retain shared sessions and explicit lifecycle tools while disabling switch and timeout checkpoints. Explicit user-requested checkpoints ignore the automatic minimum interval.

## MCP modes

```bash
agentfold mcp --workspace . --service auto
agentfold mcp --workspace . --service required
agentfold mcp --workspace . --service disabled
```

- `auto` is the default. It delegates all nine tools when a compatible service is ready; otherwise it warns on stderr and starts embedded mode.
- `required` fails startup if the shared service is unavailable or incompatible. Future connectors should use this mode.
- `disabled` always uses the existing in-process session registry and core handlers.

Fallback occurs only during startup. A service failure during a tool call returns a focused error and never silently changes to embedded mode. MCP stdout remains protocol-only.

Future supported connectors will register:

```bash
agentfold mcp --service required --workspace <project>
```

This milestone does not modify any host application's configuration.

## Troubleshooting

- If `service status` reports stopped, run `agentfold service start`.
- If required MCP reports incompatibility, stop the old service and start it with the current AgentFold package.
- If startup times out, run `agentfold service run --debug` and inspect stderr.
- Confirm `AGENTFOLD_RUNTIME_DIR` is not a symlink and is writable by the current user.
- Confirm `.agentfold/config.yaml` and all five canonical context files are valid; session operations still use canonical validation.

Current limitations: the service is not installed as an operating-system
service or login item, embedded MCP sessions cannot be recovered after their
process exits, and there are no filesystem watchers or IDE extensions. The
connectors start this service only through the existing bounded user process
lifecycle.
