# 0012: BriefOnce public rebrand with compatibility namespaces

- Status: accepted
- Date: 2026-07-24

## Context

The AgentFold name described an internal mechanism, but not the user outcome:
brief the project once, preserve validated continuity, and continue with any
supported coding agent. Public adoption also benefits from a short,
shell-friendly command.

The existing product already has persisted `.agentfold` projects, `AF-*` tasks,
`CP-*` checkpoints, `agentfold_*` MCP tools, host registrations, ownership
fingerprints, service runtime state, and public TypeScript names. Renaming those
identifiers in place would risk data loss, duplicate state, broken approvals,
and incompatible clients.

## Decision

Use **BriefOnce** as the public product name and “Brief once. Continue with any
agent.” as its tagline. Publish under `@rootfold/brief-once` and document `b1`
as the primary command. Keep `briefonce` and `brief-once` as readable aliases
and `agentfold` as a silent backward-compatible alias.

Rebrand human-readable CLI output, active documentation, package metadata, and
new connector instructions. Increment the Codex and Antigravity managed
instruction schemas so untouched AgentFold-owned content can be safely upgraded.

Retain `.agentfold`, `AF-*`, `CP-*`, `agentfold_*`, the `agentfold` MCP server
key, service protocol and runtime directories, connector ownership identifiers,
diagnostic codes, and existing exported API names as compatibility namespaces.
The stable MCP machine server identifier also remains `agentfold`.

## Consequences

Existing projects, tasks, checkpoints, connectors, host approvals, service
tokens, and recovery data work without migration. Users get a concise `b1`
workflow while automation using `agentfold` continues silently.

Some internal names remain visibly historical. Documentation must distinguish
public branding from compatibility identifiers and must not imply that
`.briefonce` exists.

Any future internal namespace migration requires its own versioned,
rollback-capable design. It is not part of this rebrand.
