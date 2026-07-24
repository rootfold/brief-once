# ADR 0011: Reliability monitoring and restart recovery

> AgentFold was renamed BriefOnce. Compatibility identifiers described in this
> decision remain unchanged.

- Status: Accepted
- Date: 2026-07-24

## Context

AgentFold already preserves task reports and immutable checkpoints, but the
shared service previously kept session leases only in memory. A process restart
could therefore erase the fact that an observed host session disappeared before
normal close. Users also had no deterministic answer for whether an observed
session opened, continued the expected task, reported progress, checkpointed,
finished, or required recovery.

Reliability metadata is machine-specific. Placing it in `.agentfold`, generated
instructions, or Git history would expose host activity and make local service
state appear portable when it is not.

## Decision

AgentFold records strict version-1 lifecycle events in a private user-scoped
state directory. Events contain only bounded identities, timestamps, outcome
codes, semantic freshness, and counts. They never contain prompts, report text,
resume packets, source content, changed paths, diffs, command output,
environment values, secrets, tokens, or host configuration.

Each canonical repository root is represented by a truncated SHA-256 identity.
Event stores are bounded atomic JSON documents with monotonic sequences. The
default retention is 1,000 events per repository.

The service also atomically persists an active-session journal. The journal is
the only private structure allowed to retain canonical repository roots because
restart recovery must relocate a repository. Roots are realpath-validated
against the stored repository identity before use and are never returned by
CLI, MCP, service status, logs, or public API types.

A new service instance marks prior open, detached, or recovery-pending records
as interrupted. Evaluation runs through the existing per-repository queue and
checkpoint core, either when the next session opens or during the bounded
background lease scan. Recovery never invents semantic conclusions, finishes a
task, clears active state, or mutates Git. Failures retain the pending record
and use at most three automatic attempts with delays of at least one minute.

Core lifecycle success is authoritative. Reliability persistence occurs after
the existing operation result and can add a warning, but it cannot turn a
successful task, report, checkpoint, finish, resume, or close into a failure.

## Consequences

- `agentfold reliability` can analyze only AgentFold-observed sessions. It never
  claims a denominator covering host sessions that did not contact AgentFold.
- Embedded MCP records basic lifecycle events but cannot recover across its own
  process restart.
- Service restart recovery can preserve current, reused, or absent semantic
  freshness honestly, depending on the last persisted report.
- Corrupt or symlinked private state is rejected without repair or repository
  mutation.
- Reliability remains local and is never synchronized or added to `.gitignore`.
