# Migrating from AgentFold to BriefOnce

AgentFold was renamed BriefOnce. The product, npm package, documentation, and
primary command changed; the persisted compatibility namespaces did not.

## What changed

- Install new releases from `@rootfold/brief-once`.
- Use `b1` as the primary command.
- `briefonce`, `brief-once`, and the legacy `agentfold` command are equivalent
  aliases for the same CLI entry.
- Current documentation and human-readable output use the BriefOnce name.

## What did not change

Existing initialized projects require no data migration:

- `.agentfold`, its configuration, task state, completed tasks, and checkpoints
  remain valid.
- Task IDs still use `AF-`; checkpoint IDs still use `CP-`.
- MCP tools remain in the `agentfold_*` compatibility namespace.
- Host MCP configuration continues to use the `agentfold` server key.
- Existing connector ownership records, service protocol, capability tokens,
  runtime directories, recovery journals, and reliability history are reused.

BriefOnce intentionally does not create `.briefonce` or duplicate user state.
A blind rename would strand existing tasks, invalidate connector ownership,
break host approvals, and risk splitting one project across two state stores.
A future internal namespace migration would require a separate versioned design.

## Refresh connector instructions

After upgrading the package, preview the managed instruction update:

```sh
b1 connect codex
b1 connect antigravity
```

Untouched AgentFold-owned regions are recognized as older managed schemas.
Apply the update explicitly:

```sh
b1 connect codex --yes
b1 connect antigravity --yes
```

Only connector-owned content is updated. If a managed region was edited
manually, BriefOnce reports a conflict and leaves it unchanged. Restart the host
after applying, then run `b1 verify codex` or `b1 verify antigravity`.

No immediate action is required when existing connector instructions do not
need to be refreshed.
