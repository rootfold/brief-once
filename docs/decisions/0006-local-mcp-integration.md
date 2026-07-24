# 0006: Local MCP integration over stdio

> AgentFold was renamed BriefOnce. Compatibility identifiers described in this
> decision remain unchanged.

- Status: accepted
- Date: 2026-07-21

## Context

AgentFold already has deterministic application services for canonical context, active tasks, structured reports, immutable checkpoints, and resume packets. MCP-capable applications need a universal way to invoke those services without parsing terminal output or independently reading AgentFold files. Reimplementing continuity inside an MCP server would create a second core with divergent validation, safety, and persistence behavior.

A first integration also needs a deliberately narrow trust boundary. A daemon or network transport would introduce authentication, discovery, multi-repository routing, and long-lived process concerns before host workflows are proven. Standard output cannot carry ordinary diagnostics because stdio MCP clients interpret it as JSON-RPC protocol traffic.

## Decision

- `agentfold mcp` is a transport and orchestration layer over existing TypeScript operations. It never invokes AgentFold CLI commands as subprocesses and does not parse CLI output.
- The server uses the official `@modelcontextprotocol/sdk` v1 package. Version 1 is the stable production generation; the split v2 packages are still pre-release and are intentionally deferred.
- The first transport is stdio. It creates no HTTP, SSE, WebSocket, or other network listener. Standard output is exclusively MCP protocol traffic; safe lifecycle diagnostics use standard error.
- One process resolves one requested workspace to its real Git repository root at startup. Tool schemas accept no workspace or repository switch, and normal results never expose the absolute root.
- Session metadata is minimal and in memory: client and agent labels, timestamps, task attachment, and close state. It contains no prompts, conversations, source contents, or tool transcripts. Repository AgentFold state remains the durable continuity source.
- Eight tools expose status, bounded context, session opening, task start, semantic reporting, checkpointing, resume packets, and session close. They call the existing canonical loaders and prepare/commit services directly.
- `close_session` validates its complete input before mutation, then applies report, checkpoint, and optional resume operations in order. These remain separate durable actions. A report that persists before checkpoint failure is reported as partial success and the session remains open.
- Graceful process shutdown closes the MCP connection but does not invent a report or create a checkpoint. The latest explicitly persisted checkpoint is the only crash-safe continuation boundary in this milestone.

## Consequences

Any compatible local host can use the same AgentFold lifecycle without an application-specific connector, while validation and atomic persistence remain centralized. Hosts must cooperate by opening, reporting, and closing sessions; an unexpected host or process failure can leave progress newer than the latest checkpoint. Persistent sessions, passive recovery, crash monitoring, automatic idle detection, host configuration installers, and network transports remain future work.
