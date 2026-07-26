# Architecture

## Trust model

Codex Collab separates three responsibilities:

```text
invited device ──HTTPS/WebSocket── relay ──HTTPS/WebSocket── owner host
                                                        │
                                                        ├── explicit file root
                                                        ├── Codex app-server (read/status)
                                                        └── Codex Desktop IPC (prompt/control)
                                                                    │
                                                                    └── bound thread
```

The public relay authenticates members and distributes messages. It never receives SSH access,
Codex account credentials, raw hidden reasoning, private keys or authentication files. After
explicit owner selection, it stores a bounded read-only snapshot of visible Codex messages,
app-server reasoning summaries, command output and filtered text files so approved members can
view them.

The owner host is the only component allowed to touch local files or submit a turn to Codex. It
accepts only messages whose identity and approval state were verified by the relay.

## Session lifecycle

1. Owner creates a session and receives a member capability token.
2. Owner creates a short-lived, limited-use invitation capability.
3. Invitee exchanges it for a pending member identity and a new member token.
4. Owner explicitly approves the pending member.
5. Approved members can chat and create `codex_prompt` messages.
6. The owner host consumes approved members' Codex commands in relay order.
7. A command is marked submitted only after the Codex Desktop window that owns the selected task
   accepts the local `thread-follower-start-turn` request. While that task is active, later commands
   stay queued and are promoted one at a time after completion. Desktop focus and its local draft
   are never touched.
8. The owner may close the session room. The relay continues to serve authenticated history,
   membership and Stop requests, but rejects invite creation/join, chat, new Codex prompts and
   attachment writes until the room is reopened. `session.updated` distributes the state change.

Raw member tokens are never stored by the relay. SHA-256 hashes are stored in SQLite.

Before opening a WebSocket, an authenticated browser or owner host requests a 30-second realtime
ticket. The relay stores only the ticket hash in memory and deletes it before the upgrade is
accepted, so it cannot be reused and the durable member bearer token is not placed in proxy access
logs. Legacy `sessionId`/`token` upgrades remain available only during a rolling client upgrade and
can be disabled with `CODEX_COLLAB_ALLOW_LEGACY_REALTIME_TOKENS=0` after every owner host has been
updated.

The dashboard-to-host handoff uses a separate ten-minute, one-time pairing capability. The relay
stores only its hash and exchanges it for a separate owner-host token, so the browser owner's token
is neither copied nor rotated.

## Codex integration

The plugin uses two same-user local Codex channels. The app-server JSONL protocol provides task
discovery, visible history and runtime status; Codex Desktop's named-pipe IPC router provides native
message delivery and runtime control:

1. `initialize`
2. `initialized`
3. `thread/list` to publish tasks matching the explicit root
4. the selected task's app-server-provided rollout path to import visible messages, reasoning
   summaries and command output; `thread/turns/list` is the bounded fallback when no rollout is
   available or the rollout exceeds the 20 MB direct-read limit
5. `thread-follower-start-turn` for the next queued command when the Desktop task is idle, and
   `thread-follower-interrupt-turn` for Stop; active tasks hold later commands in Relay order
6. persistent forwarded-message IDs and relay delivery state so a restarted host does not replay
   completed prompts

The status reconciler treats app-server terminal values observed while the newest turn is still
active as provisional. This prevents a transient `interrupted` value from permanently overriding
the rollout's later successful completion.

Prompt submission is entirely background local IPC and is accepted only by the Desktop client that
currently owns the selected conversation. The pipe is not exposed over the network. Submission
supports text, file/image attachments, plan mode, model, reasoning strength, service tier and
permission profiles without opening or switching the Desktop window. Only the owner may remotely
change approval/access settings; invited members inherit the selected task's current mode.

Bounded UTF-8 text attachments are included directly in the app-server input. Images use
`localImage`; other binary files are staged under the approved root's ignored `.codex-collab/`
directory and removed when the turn completes. The staging directory is excluded from file tools and
published workspace snapshots.

## Files and concurrent edits

The plugin resolves the owner-selected root with `realpath`. Reads and writes reject path traversal
and symlink escape. Writes are atomic and require the caller's expected SHA-256; a mismatched hash
produces a conflict instead of overwriting someone else's newer work.

The web file browser is deliberately narrower than the MCP file sandbox. It receives a bounded,
read-only snapshot of allow-listed project text formats. An optional `codexConfigRoot` is resolved
as a second explicit sandbox and contributes `.codex/`-prefixed non-credential configuration files.
Both roots exclude environment files, credential filenames, authentication/session databases,
private-key material, high-confidence embedded tokens and symlinks. Switching the selected Codex
task clears the previous history and file snapshot before the new import.

For two active Codex writers, each writer gets a separate Git worktree. The relay coordinates
messages and intent; Git remains the merge and audit mechanism.

## Next milestones

- owner-visible notification and approval queue for peer-authored prompts;
- encrypted offline event history and reconnect replay;
- Git worktree reservation and merge queue;
- a packaged Codex widget instead of the standalone web dashboard;
- per-root permissions for read, write, execute, and Codex configuration;
- end-to-end device-key signing and owner-visible revocation;
- finer-grained quotas, automated backups, monitoring, and audit export.
