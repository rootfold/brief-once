# 0007: Shared user-level local service

> AgentFold was renamed BriefOnce. Compatibility identifiers described in this
> decision remain unchanged.

- Status: accepted
- Date: 2026-07-21

## Context

One stdio MCP process belongs to one host process. Separate Codex, Antigravity, and future IDE processes cannot share that process's in-memory sessions, leases, or operation ordering. Repository state and immutable checkpoint history already provide durable continuity, but they cannot by themselves detect a live agent change or an abandoned client.

Duplicating report, checkpoint, resume, redaction, Git inspection, or persistence logic in a daemon would create a second continuity engine. A public network protocol would also add unnecessary exposure, port management, and remote authentication to a local-first tool.

## Decision

- A user-level `agentfold service` coordinates multiple repositories and MCP processes through authenticated local IPC: Windows named pipes or Unix-domain sockets on macOS and Linux. It never opens a TCP, HTTP, SSE, or WebSocket listener.
- Runtime metadata is outside repositories and contains a cryptographically random capability token. Metadata and Unix sockets use restrictive current-user permissions where supported. Tokens are timing-safely compared and are never logged or returned by status.
- One service keeps minimal repository registrations and session leases in memory. It stores no prompts, conversations, source content, private reasoning, or MCP transcripts. A restart may lose live sessions; `.agentfold/state` and immutable checkpoint history remain the durable source of continuity.
- MCP and service RPC use the same host-neutral integration operations, which call the existing validated core prepare/commit services. The service does not invoke CLI commands or parse terminal output.
- State-changing operations are serialized per canonical real repository path. Unrelated repositories remain concurrent.
- A different fresh agent session may trigger a checkpoint for the previous session. An expired open or detached lease may trigger a recovery checkpoint. Both reuse persisted semantic reports and current bounded Git facts; neither infers decisions, blockers, failures, validation, or next actions.
- Task intent is still explicit through `agentfold_begin_task`. Git activity, filenames, editor activity, host process names, and commit messages never create a task.
- A configurable minimum interval reduces noisy automatic attempts, while existing fingerprint duplicate suppression remains authoritative. Explicit checkpoints are never interval-limited.
- Embedded stdio MCP remains available for recovery, compatibility, and environments where the service is not running.
- Passive filesystem watching and operating-system service installation are deferred. The first lifecycle is explicit foreground or detached-process start/status/stop.

## Consequences

Separate local applications can share lifecycle state and receive deterministic handoffs without a cloud account or public listener. Unexpected disconnects become recoverable after a lease rather than producing fabricated final reports. The service must maintain careful runtime cleanup, authenticated protocol validation, and cross-platform socket behavior. Connectors and startup installers remain independent future milestones.
