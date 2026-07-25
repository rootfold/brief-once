# 0013: Use `.briefonce` as the canonical project-storage namespace

- Status: accepted
- Date: 2026-07-25
- Supersedes: the project-directory retention decision in
  `0012-briefonce-public-rebrand.md`

## Context

The public product and package are now BriefOnce, but newly initialized
repositories still exposed `.agentfold` as their primary configuration and
state directory. That made the rebrand incomplete in every repository and
forced documentation and user-facing diagnostics to keep teaching the old
product name.

Existing `.agentfold` repositories may contain active tasks, immutable
checkpoints, completed-task archives, and user-edited canonical context. A
blind automatic rename could split state, overwrite a user-created
`.briefonce`, or follow a symbolic link outside the repository.

## Decision

- `.briefonce` is the only project directory created by new initialization.
- Project-storage selection is centralized. A repository with only
  `.briefonce` uses it; a repository with only `.agentfold` remains fully
  operational and receives a migration warning.
- A repository containing both directories is an error. BriefOnce never
  silently prefers, merges, or overwrites either store.
- `b1 migrate` is a read-only preview. `b1 migrate --yes` requires a complete,
  valid legacy installation, rejects symbolic-link and boundary conflicts,
  atomically renames the directory, and normalizes manifest path keys.
- All task-state, checkpoint, resume, completion, doctor, MCP, reliability, and
  Git-ignore checks use the selected project-storage directory.
- Git checkpoint observation excludes both namespace state directories so an
  upgrade cannot accidentally capture BriefOnce's own continuity files.

The rename applies only to repository-local storage. Compatibility boundaries
such as `AF-*`, `CP-*`, `agentfold_*` MCP tools, the `agentfold` MCP server key,
legacy CLI alias, environment variables, and user-scoped runtime/service state
remain unchanged.

## Consequences

Fresh repositories present consistent BriefOnce branding. Existing work is not
stranded and migration remains an explicit user decision. Cross-platform
behavior relies on path APIs and a same-parent filesystem rename, with tests on
Windows, macOS, and Linux CI.

Users who ignore local state must replace `.agentfold/state/` with
`.briefonce/state/` after migration; BriefOnce continues not to edit
`.gitignore`.
