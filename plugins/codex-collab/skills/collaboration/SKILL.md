---
name: collaboration
description: Create, join, inspect, and safely operate a Codex Collab shared task.
---

# Codex Collab workflow

Use the `collab_*` MCP tools for shared sessions. Keep the owner as the security boundary.

## Start or join

1. Check `collab_health`.
2. If the owner already created the room in the web dashboard, call `collab_pair_host` with the
   dashboard's short-lived pairing code and one explicit absolute project root.
3. If there is no web room, call `collab_create_session` with one explicit absolute project root.
4. After web pairing, tell the owner to select a task in **Codex 与文件**. Keep the MCP host running
   while the selected visible history and safe read-only file snapshot are imported.
5. Use `collab_refresh_workspace` when the owner asks to refresh the task catalog or snapshot.
6. Use `collab_create_invite` to create a short-lived, low-use invite.
7. For an invited device, call `collab_join_session`.
8. Never call `collab_approve_member` until the owner explicitly accepts the displayed member.

## Bind Codex

1. Call `collab_list_codex_threads`, preferably filtered by the project cwd.
2. Show the owner the candidate thread ID and title.
3. Call `collab_bind_thread` only after the intended task and root are unambiguous.
4. Use `collab_forward_prompt` only for a relay-backed `codex_prompt` message. Do not recreate the
   text with a claimed identity.
5. Preserve the current Codex approval policy. Never downgrade approvals on behalf of a peer.

## Files

- The bound project root is the entire accessible boundary.
- Web viewers receive only a bounded, read-only safe-text snapshot. Do not imply that the web file
  browser exposes a live filesystem or permits edits.
- Access to the owner's `.codex` directory requires a separate, explicit binding by the owner.
- Read a file before editing it and pass the returned SHA-256 to `collab_write_file`.
- If the hash is stale, report the conflict and merge intentionally. Never retry as a blind overwrite.
- Skip secrets, private keys, tokens, credential stores, and environment files unless the owner
  explicitly places a specific file in scope.

## Concurrent Codex writers

- Use one Git worktree per active Codex writer.
- Share messages and decisions through the session, then merge through Git.
- Do not let two agents edit the same working tree concurrently.
