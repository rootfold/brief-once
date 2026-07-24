# ADR 0010: Finished-task lifecycle

> AgentFold was renamed BriefOnce. Compatibility identifiers described in this
> decision remain unchanged.

## Status

Accepted.

## Context

Progress checkpoints preserve resumable work, but they do not distinguish a paused task from one whose requested scope is complete. Reusing `current.md` as a completed record would weaken active-state validation, allow accidental resume, and make task-ID reuse and cross-host coordination ambiguous.

## Decision

AgentFold uses three separate durable concepts:

- `.agentfold/state/current.md` is the single active task.
- `.agentfold/state/history/` contains immutable progress and final checkpoints.
- `.agentfold/state/completed/<task-id>.md` contains one strict human-readable completed-task archive.

Finish prepares the final semantic state, exact resolutions, Git observation, final checkpoint, and completed archive before mutation. It atomically creates the final checkpoint, atomically creates the archive, and removes active state only after both exist. A failure rolls back only newly created finish artifacts when their content still proves ownership; prior checkpoint history is never removed. A rollback failure is severe and never reported as success.

Final checkpoints use `kind: final` and `task_status: completed`. Existing checkpoints without `kind` load as `progress`. Lifecycle information changes the final fingerprint even when Git and semantic facts are otherwise unchanged.

MCP finish clears the session's active task but keeps the session open. A new substantive request begins a new task; session close remains a separate host-lifecycle operation. Paused, incomplete, blocked, uncertain, or handed-off work continues to use progress checkpoints and session close.

## Consequences

Adapters and hosts can distinguish completion from handoff without reading repository files independently. Status can expose only the latest completed identity, and resume never reactivates an archive. Task allocation must inspect active, checkpoint, and completed identities. Reopen, cancel, delete, and multiple-active-task workflows remain intentionally unsupported.
