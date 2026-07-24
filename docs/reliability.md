# Reliability monitoring

`b1 reliability` is a read-only view of lifecycle activity that
BriefOnce actually observed for the current repository.

```bash
b1 reliability
b1 reliability --host codex
b1 reliability --host antigravity
b1 reliability --task AF-20260724-001
b1 reliability --session svc-example
b1 reliability --limit 50
b1 reliability --include-events
b1 reliability --json
```

The command does not start the service, create a checkpoint, rewrite
`.agentfold`, or mutate Git. It works while the service is stopped by reading
persisted private history. `--include-events` adds only safe event summaries;
the default output does not dump event history.

## What BriefOnce measures

BriefOnce can report whether an observed session:

- opened and began or continued a task;
- submitted semantic progress;
- created, skipped, or duplicated a checkpoint;
- requested a continuation packet;
- finished a task or closed normally;
- detached, timed out, was superseded, or was interrupted by service restart;
- required a recovery checkpoint and whether recovery succeeded.

BriefOnce cannot observe host sessions that never call a BriefOnce lifecycle
operation. Percentages therefore use the label **Observed lifecycle
completion** and include only sessions opened through BriefOnce. They are not a
claim about all Codex or Antigravity usage.

## Private storage and retention

Reliability state is outside every Git repository:

- Windows: `%LOCALAPPDATA%\AgentFold\state`
- macOS: `~/Library/Application Support/AgentFold/state`
- Linux: `$XDG_STATE_HOME/agentfold` or `~/.local/state/agentfold`

`AGENTFOLD_STATE_DIR` is an advanced/test override. Directories and files use
restrictive POSIX permissions where supported. Unsafe symlinks are rejected.
Writes use a sibling temporary file, flush, and atomic rename.

Events are stored under
`reliability/<repository-id>/events.json`. The active recovery journal is
`session-journal.json`. The journal may privately retain a canonical repository
root so a restarted service can find the repository; that root is realpath and
identity checked before use and is never rendered or publicly exported.

Defaults are applied in memory:

```yaml
reliability:
  enabled: true
  maximum_events_per_repository: 1000
  retain_closed_sessions: 100
  interrupted_recovery_enabled: true
```

Existing configuration without this section remains valid and is not rewritten.
Event retention accepts 100–10,000; closed-summary retention accepts 10–1,000.
Oldest events are compacted deterministically while sequence numbers remain
monotonic.

When `enabled` is false, core lifecycle operations continue and existing event
files remain untouched. The separately configured restart journal may continue
when `interrupted_recovery_enabled` is true.

The legacy directory names are compatibility namespaces retained by BriefOnce.
To clear history manually, stop the service first, verify the target is the
user-scoped AgentFold compatibility state directory, then remove only the intended
`reliability/<repository-id>` directory. Removing the active session journal can
discard pending restart recovery, so do not remove it while work may be active.
BriefOnce does not provide an automatic repair or clear command in this release.

## Privacy model

Reliability event files may contain bounded IDs, normalized host labels,
timestamps, event types, result codes, semantic revisions/freshness, and
numeric counts. Raw client and agent labels are not persisted in events. The
private recovery journal uses normalized host labels rather than arbitrary
client text. Reliability state never contains:

- prompts, responses, conversations, or private reasoning;
- report text or resume-packet content;
- source content, changed paths, full diffs, or Git patches;
- validation logs, terminal output, or command output;
- environment values, secrets, API keys, access tokens, passwords, capability
  tokens, service endpoints, or host configuration.

## Semantic freshness

- **Current**: the durable checkpoint used the latest semantic report revision.
- **Reused**: Git facts changed but the latest available report came from an
  earlier semantic revision.
- **Absent**: the checkpoint contains bounded Git facts without a semantic
  report.
- **Unknown**: no observed event establishes freshness.

BriefOnce never infers decisions, blockers, validation, or next actions during
recovery.

## Deterministic quality ratings

- **Excellent**: an observed session completed or closed normally, a usable
  checkpoint exists, the latest semantics are current, a report was submitted,
  and no recovery failure is unresolved.
- **Good**: continuity and a usable checkpoint or normal completion exist with
  no unresolved recovery failure.
- **Degraded**: a session timed out or was interrupted, recovery was used,
  semantic state was reused/absent, or lifecycle continuity is incomplete.
- **Poor**: recovery failed or remains pending, no usable checkpoint exists for
  changed work, or an error-level continuity issue remains.
- **Unknown**: BriefOnce has observed no lifecycle activity.

The JSON report includes stable reason codes supporting the rating.

Warnings distinguish task activity without a report, disappearance without
normal close, restart/timeout recovery, reused or absent semantics, finish
without a successful validation entry, and exhausted recovery attempts.

## Restart and timeout recovery

The service persists meaningful session transitions immediately. Heartbeat
timestamps are debounced and written at most once per bounded interval instead
of every 20 seconds.

After restart, prior open, detached, and recovery-pending sessions become
interrupted. Recovery is serialized through the repository operation queue and
uses the existing checkpoint fingerprint:

1. Validate the stored canonical root and repository identity.
2. Load the active task and latest immutable checkpoint.
3. Resolve no-active-task or different-task records without changing the
   current task.
4. Skip an unchanged fingerprint.
5. Create a recovery checkpoint only when meaningful state changed.
6. Preserve semantic freshness honestly.

Recovery never calls finish and never stages, commits, resets, stashes, pushes,
merges, changes branches, remotes, or hooks. A failure leaves the session
recovery-pending, preserves the latest valid checkpoint, and schedules no more
than three automatic retries at intervals of at least one minute. A new session
may still open and receives a warning.

Embedded MCP uses the same event recorder for basic lifecycle activity, but its
in-memory sessions cannot receive service-restart recovery. Use shared-service
mode for cross-process recovery.
