# Migrating from AgentFold to BriefOnce

AgentFold was renamed BriefOnce. New releases install from
`@rootfold/brief-once`, use `b1` as the primary command, and initialize project
state under `.briefonce`.

## Command compatibility

`briefonce`, `brief-once`, and the legacy `agentfold` command remain aliases for
the same CLI entry. Task IDs still use `AF-`, checkpoint IDs still use `CP-`,
MCP tools remain in the `agentfold_*` compatibility namespace, and host MCP
configuration continues to use the `agentfold` server key. Those identifiers
are protocol and compatibility boundaries, not project-directory branding.

## Existing projects

BriefOnce continues to read and write a repository that only has `.agentfold`.
Commands report a warning and suggest migration; they do not rename anything
automatically. If both `.briefonce` and `.agentfold` exist, BriefOnce stops with
a conflict instead of guessing, merging, or overwriting content.

Preview the storage migration:

```sh
b1 migrate
b1 migrate --dry-run
```

Both commands write nothing. Apply it explicitly:

```sh
b1 migrate --yes
```

The migration:

- validates that it is running inside the Git repository;
- requires a complete legacy initialization and valid canonical context;
- rejects a symbolic-link project directory or any repository-boundary escape;
- refuses to overwrite an existing `.briefonce` path;
- atomically renames `.agentfold` to `.briefonce` on the same filesystem;
- normalizes `.agentfold/` keys in `manifest.json` to `.briefonce/`;
- preserves canonical context, active task state, immutable checkpoints, and
  completed-task archives;
- leaves unrelated instruction files and Git state unchanged.

If `.agentfold/state/` was in `.gitignore`, replace it with:

```gitignore
.briefonce/state/
```

BriefOnce deliberately does not edit `.gitignore`.

## Refresh connector instructions

After upgrading the package, preview managed instruction updates:

```sh
b1 connect codex
b1 connect antigravity
```

Untouched AgentFold-owned regions are recognized as older managed schemas.
Apply an update explicitly:

```sh
b1 connect codex --yes
b1 connect antigravity --yes
```

Only connector-owned content is updated. If a managed region was edited
manually, BriefOnce reports a conflict and leaves it unchanged. Restart the host
after applying, then run `b1 verify codex` or `b1 verify antigravity`.
