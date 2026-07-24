# Codex Collab engineering guide

## Scope

This repository builds a local-first collaboration layer for Codex. It must preserve the owner's
approval boundary even when an invited member can submit prompts or edit an explicitly shared root.

## Required checks

Run these before handing off a change:

```powershell
npm run typecheck
npm test
npm run build
npm run validate:plugin
```

For MCP changes, also perform a real JSON-RPC `initialize` followed by `tools/list`. A running
process or an HTTP response alone is not sufficient validation.

## Security invariants

- Never copy chat passwords, API keys, SSH private keys, or member tokens into source control.
- Store only hashes of relay bearer tokens.
- Keep owner approvals enabled when forwarding a peer prompt into Codex.
- Restrict file access to owner-approved absolute roots and reject path traversal and symlink escape.
- Do not expose a non-loopback Codex app-server without capability-token or signed-bearer auth.
- Treat `.codex` access as a separate explicit root, never as an implicit consequence of project access.

## Concurrency

- Use optimistic file hashes for writes.
- Use a separate Git worktree per active Codex writer.
- Never silently overwrite a file after its expected hash has changed.
