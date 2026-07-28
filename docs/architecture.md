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
explicit owner selection, it stores a bounded snapshot of visible Codex messages, app-server
reasoning summaries, command output and a filtered text-file catalog. IDE reads and writes travel
as bounded, expiring operations; the relay never mounts or directly accesses the owner's root.

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
logs. Legacy `sessionId`/`token` upgrades still exist for compatibility and are currently enabled
unless `CODEX_COLLAB_ALLOW_LEGACY_REALTIME_TOKENS=0` is set. This places a long-lived member token in
the WebSocket URL and is tracked security debt; the next compatibility release must make tickets the
default-only path and require an explicit, time-bounded opt-in for old Hosts.

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
6. a durable local outbox is written before submission, then the accepted `turnId` receipt is persisted
   before Relay acknowledgement; restart recovery requires one unique `clientUserMessageId`/metadata
   match and fails closed on zero or multiple matches, so this prevents automatic duplicate submission
   without claiming universal end-to-end exactly-once

The status reconciler treats app-server terminal values observed while the newest turn is still
active as provisional. This prevents a transient `interrupted` value from permanently overriding
the rollout's later successful completion.

Prompt submission is entirely background local IPC and is accepted only by the Desktop client that
currently owns the selected conversation. The pipe is not exposed over the network. Submission
supports text, file/image attachments, plan mode, model, reasoning strength, service tier and
permission profiles without opening or switching the Desktop window. Only the owner may remotely
change approval/access settings. The Host derives authorship from trusted Relay identity and forces
every non-owner submission to `workspace` plus `on-request`; owner-authored submissions preserve
their selected mode.

Bounded UTF-8 text attachments are included directly in the app-server input. Images use
`localImage`; other binary files are staged under the approved root's ignored `.codex-collab/`
directory and removed when the turn completes. The staging directory is excluded from file tools and
published workspace snapshots.

## Files and concurrent edits

The plugin resolves the owner-selected root with `realpath`. Reads and writes reject path traversal
and symlink escape. Writes are atomic and require the caller's expected SHA-256; a mismatched hash
produces a conflict instead of overwriting someone else's newer work.

The web IDE is deliberately narrower than the MCP file sandbox. It receives a bounded catalog of
allow-listed project text formats, then queues individual reads and authorized writes for the
currently paired Host. Owner approval intentionally grants an editor `workspace-write`; the owner
can later switch that member to read-only or revoke them.
Claims use a Host generation, a short lease and a second permission check immediately before disk
access. An optional `codexConfigRoot` is resolved as a second explicit sandbox and contributes
`.codex/`-prefixed non-credential configuration files, but that root is always read-only.

Both roots exclude environment files, credential filenames, authentication/session databases,
private-key material, high-confidence embedded tokens and symlinks. Project-private directories
such as `.aws`, `.azure`, `.ssh`, `.gnupg` and `node_modules` use the same protocol policy during
Host scans, direct operations and Relay admission. `.codex` still needs structured field-level
redaction instead of relying only on content heuristics.

Relay stores bounded history independently for each catalogued Codex task. Selecting a task loads
that task's cached history, while the Host backfills uncached tasks incrementally. The project file
catalog is scoped to the paired workspace root and can be reused across task switches; the dashboard
must still expose only the selected task's timeline and reject stale cross-task responses.

On Windows, an existing-file save holds native file and directory handles that deny concurrent
write/delete sharing, hashes the exact opened target, records and flushes a prepared journal, moves
the observed target into a bounded recovery area, then publishes the candidate with no-replace
semantics. If another writer creates the target in the brief publication window, the Host reports a
conflict and preserves the target, recovery and candidate; it never rolls back over the concurrent
version. An interrupted partial transaction remains manually recoverable from the journal. New
files also use no-clobber publication. Unsupported Host platforms fail writes closed.

The current IDE phase does not yet permit two Codex writers to share one checkout. The planned
multi-writer phase assigns each writer a separate Git worktree; the relay coordinates messages and
intent while Git remains the merge and audit mechanism.

## Source module boundaries

The authoritative file/function budgets and import rules are in
[CODE_ORGANIZATION.md](./CODE_ORGANIZATION.md); this document does not duplicate different numeric
limits. The current repository is organized as a modular monolith:

```text
apps/dashboard/src/
├── App.tsx                 app composition and cross-feature coordination
├── app/                    shell and orchestration views
├── features/               collaboration, composer, dialogs, session, timeline, workspace
├── ide/                    explorer, Monaco models/tabs, saves and conflicts
├── layout/                 resizable panes and persisted geometry
└── shared/                 low-level browser/API utilities

apps/relay/src/
├── server.ts              process bootstrap and shared HTTP/WS boundary
├── routes/                authenticated HTTP resource handlers
├── accounts/              account, Passkey and room-recovery persistence
├── collaboration/         rooms, members, invites and messages
├── workspace/             task history, catalogs and file-operation queue
└── storage/               SQLite context, migrations, rows and shared invariants

plugins/codex-collab/src/
├── mcp-server.ts          MCP tool facade
├── app-server/            JSON-RPC transport, parsing and submission mapping
├── workspace-sync-*       Host lifecycle, task/history and command synchronization
├── workspace-file-*       leased Relay operation execution
└── file-sandbox/CAS files sandbox and Windows native publication boundary
```

The earlier dashboard extraction, Relay route split and plugin parser/transport split are already
implemented. Current structural debt is different: task-scoped browser state is not consistently
owned, Dashboard feature imports do not yet match the intended dependency graph, and Relay storage
modules are connected by a 14-level inheritance chain. These are addressed incrementally; security
checks and transactions stay at their real boundary throughout the change.

The architecture is intentionally single-Relay/single-SQLite-writer today. Running a second writer
against the same database is unsupported. PostgreSQL, Redis or service extraction is considered only
after a measured need for multiple Relay replicas, multi-node HA or a violated latency/backup SLO.

The evidence, priorities, target shapes and acceptance checks are recorded in
[ARCHITECTURE_AUDIT_2026-07-28.md](./ARCHITECTURE_AUDIT_2026-07-28.md).

## Next milestones

- owner-visible notification and approval queue for peer-authored prompts;
- encrypted offline event history and reconnect replay;
- Git worktree reservation and merge queue;
- a packaged Codex widget instead of the standalone web dashboard;
- per-root permissions for read, write, execute, and Codex configuration;
- end-to-end device-key signing and owner-visible revocation;
- finer-grained quotas, automated backups, monitoring, and audit export.
