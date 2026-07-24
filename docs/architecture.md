# Architecture

## Trust model

Codex Collab separates three responsibilities:

```text
invited device ──HTTPS/WebSocket── relay ──HTTPS/WebSocket── owner host
                                                        │
                                                        ├── explicit file root
                                                        └── Codex app-server
                                                               │
                                                               └── bound thread
```

The public relay authenticates members and distributes messages. It never receives SSH access,
Codex account credentials, the owner's `.codex` directory, reasoning traces or command output.
After explicit owner selection, it stores a bounded read-only snapshot of visible Codex messages
and filtered safe-text project files so approved members can view them.

The owner host is the only component allowed to touch local files or submit a turn to Codex. It
accepts only messages whose identity and approval state were verified by the relay.

## Session lifecycle

1. Owner creates a session and receives a member capability token.
2. Owner creates a short-lived, limited-use invitation capability.
3. Invitee exchanges it for a pending member identity and a new member token.
4. Owner explicitly approves the pending member.
5. Approved members can chat and create `codex_prompt` messages.
6. The owner host forwards a stored prompt by message ID into the bound Codex thread.

Raw member tokens are never stored by the relay. SHA-256 hashes are stored in SQLite.

The dashboard-to-host handoff uses a separate ten-minute, one-time pairing capability. The relay
stores only its hash and exchanges it for a separate owner-host token, so the browser owner's token
is neither copied nor rotated.

## Codex integration

The plugin uses the local Codex `app-server` JSONL protocol:

1. `initialize`
2. `initialized`
3. `thread/list` to publish tasks matching the explicit root
4. `thread/read` to import only visible user and assistant messages
5. `thread/resume` to rejoin the task
6. `turn/start` with identity metadata

The bridge does not set `approvalPolicy` or bypass sandbox settings, so the existing owner policy
remains authoritative.

## Files and concurrent edits

The plugin resolves the owner-selected root with `realpath`. Reads and writes reject path traversal
and symlink escape. Writes are atomic and require the caller's expected SHA-256; a mismatched hash
produces a conflict instead of overwriting someone else's newer work.

The web file browser is deliberately narrower than the MCP file sandbox. It receives a bounded,
read-only snapshot of allow-listed text formats and excludes `.env`, `.codex`, credential filenames,
private-key material, high-confidence embedded tokens, symlinks, dependency folders and build
output. Switching the selected Codex task clears the previous history and file snapshot before the
new import.

For two active Codex writers, each writer gets a separate Git worktree. The relay coordinates
messages and intent; Git remains the merge and audit mechanism.

## Next milestones

- background owner host that consumes relay prompts automatically;
- encrypted offline event history and reconnect replay;
- Git worktree reservation and merge queue;
- a packaged Codex widget instead of the standalone web dashboard;
- per-root permissions for read, write, execute, and Codex configuration;
- end-to-end device-key signing and owner-visible revocation;
- rate limits, automated backups, monitoring, and audit export.
