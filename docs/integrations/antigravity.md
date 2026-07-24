# Google Antigravity connector

AgentFold can safely register its local MCP server with Google Antigravity and install an always-active workspace continuity rule.

The connector follows Google's official documentation inspected on 2026-07-21. See [ADR 0008](../decisions/0008-antigravity-connector.md) for the URLs and path-transition rationale.

## Supported surfaces and discovery

- Antigravity desktop
- Antigravity IDE
- Antigravity CLI

Current general documentation uses `~/.gemini/config/mcp_config.json`. CLI transition documentation also identifies `~/.gemini/antigravity-cli/mcp_config.json`. Workspace `.agents/mcp_config.json` is detected as supporting evidence, while AgentFold prefers one global entry so repositories can share it.

Discovery examines only documented candidates, their immediate application directories, and a small platform-specific executable list. It never recursively scans the user profile. If central and CLI-transition files have equally strong evidence, `auto` refuses to choose; select a surface or inspect `--surface all`.

## Preview and installation

```bash
agentfold connect antigravity
agentfold connect antigravity --dry-run
agentfold connect antigravity --surface ide
agentfold connect antigravity --surface ide --yes
```

Preview validates the repository, host JSON, collisions, executable descriptor, workspace boundary, and ownership state without writing. Surfaces are `auto`, `desktop`, `ide`, `cli`, and `all`. There is no `--force`; user-owned entries and modified rules are preserved.

## Generated MCP entry and service startup

The generated `mcpServers.agentfold` entry uses an absolute executable and argument array. Conceptually it runs:

```text
agentfold mcp --service required --ensure-service --workspace-mode auto
```

It does not use a shell, `npx`, package downloads, capability tokens, runtime metadata, or repository path. Paths containing spaces and Unicode remain individual arguments.

`--ensure-service` reuses a compatible service or starts one through the existing bounded lifecycle operation and waits for readiness. It does not install an operating-system service or register login startup.

## Workspace resolution

- `fixed` preserves explicit `--workspace` and backward-compatible direct use.
- `auto` selects one initialized `file://` client root, then an initialized current working directory.
- `roots` requires exactly one initialized repository from roots.
- `cwd` requires an initialized repository containing the process working directory.

URIs, real paths, Git roots, initialization, and duplicates are validated. Several initialized repositories are an error. The selected canonical repository is locked for the process lifetime; roots changes cannot switch it. Absolute roots are not returned in normal tool output.

## Workspace lifecycle rule

The connector owns only `.agents/rules/agentfold-continuity.md`. The deterministic rule tells Antigravity to open a session before substantive changes, continue a relevant active task, begin work only when appropriate, and report meaningful milestones. It uses `agentfold_finish_task` for fully completed and validated scope, while paused, incomplete, blocked, uncertain, or handed-off work uses `agentfold_close_session` with checkpointing.

Rule ownership fingerprints treat LF, CRLF, and legacy CR line endings equivalently. This keeps reconnect and verification deterministic when Git checks out text files with platform-native line endings, while any content change remains a collision that AgentFold will not overwrite.

A fresh checkout can also upgrade the exact schema-1 rule shipped by older AgentFold versions without relying on machine-local ownership state. Recognition requires the complete known legacy template; a changed marker, instruction, or surrounding byte remains user-owned and is never overwritten.

It distinguishes implementation, modifying debugging, refactoring, tests, documentation, and architecture from conceptual questions, explanations, read-only inspection, status requests, non-project chat, and trivial formatting help. It prohibits hidden reasoning, conversation capture, source contents, environment values, secrets, automatic commits, pushes, and discarding uncommitted work.

## Preservation, backups, and ownership

Antigravity JSON accepts UTF-8 with an optional BOM. AgentFold preserves LF or CRLF, final-newline behavior, indentation, unrelated top-level fields, unrelated MCP servers, and secret-bearing values without reserializing them. Malformed JSON and unsupported comments are rejected rather than stripped.

Before modifying an existing config, AgentFold stores an exact-byte backup in restrictive user-scoped connector state outside the repository. Backup contents are never printed. Ownership records contain fingerprints and safe identities—not configuration, repository roots, secrets, or service tokens.

## Verification

```bash
agentfold verify antigravity
```

Verification checks ownership, configuration and rule fingerprints, the executable descriptor, service auto-start, official MCP initialization, roots resolution, and all nine tools. It does not modify host or project configuration.

There is no documented non-interactive API proving UI ingestion. After installation:

1. Open Antigravity Settings or the IDE agent-panel menu.
2. Navigate to Customizations or MCP Servers.
3. Refresh Installed MCP Servers.
4. Confirm `agentfold` appears and inspect its tools.
5. Approve tools when Antigravity requests permission.

AgentFold never changes Antigravity permissions or bypasses approval.

Use `agentfold reliability --host antigravity` to inspect only Antigravity
sessions observed by AgentFold. The report distinguishes normal close, detach,
timeout, agent switch, and service-restart interruption without claiming
visibility into Antigravity sessions that never called AgentFold.

## Removal

```bash
agentfold disconnect antigravity
agentfold disconnect antigravity --dry-run
agentfold disconnect antigravity --yes
```

Disconnect rechecks fingerprints and removes only proven AgentFold content. A modified entry or rule is preserved. Removing one repository keeps a shared global entry while another repository depends on it. Historical backups are not blindly restored, and the shared service is not stopped.

## Troubleshooting

- If automatic discovery reports ambiguity, preview one explicit surface or use `--surface all` to inspect every independently evidenced target.
- If JSON parsing fails, repair malformed JSON or unsupported comments manually. AgentFold will not normalize an uncertain host file.
- If an ownership collision is reported, compare the current `agentfold` entry or rule with your intended configuration; there is deliberately no `--force`.
- If verification reports a stale executable, rebuild or reinstall AgentFold and preview `connect` again before accepting an owned update.
- If tools are absent in Antigravity, refresh Installed MCP Servers, inspect the local command, and approve the tools when prompted.
- If service auto-start fails, run `agentfold service status` and `agentfold verify antigravity`; required mode never silently falls back to embedded operation.

Preview output identifies targets with abbreviated safe labels and never prints configuration contents. Review the planned action kind, surface selection, MCP argument shape, and rule-relative path before adding `--yes`.

## Privacy and limits

- MCP is local stdio; the shared service is authenticated local IPC.
- No source upload, telemetry, network request, model call, or chat scraping occurs.
- Antigravity approval or host-level MCP disablement can prevent lifecycle calls.
- Rich checkpoints require semantic reports; timeout recovery may be Git-only.
- The rule strongly directs the model but cannot guarantee compliance.
- No GUI automation or host-ingestion claim is made.
- No OS service installation or startup registration is performed.
