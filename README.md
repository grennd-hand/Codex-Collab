# Codex Collab

Codex Collab is a local-first control room for a small trusted team working with one owner-controlled
Codex installation.

The first working slice includes:

- identity-labelled shared chat;
- one-time invitation tokens and explicit owner approval;
- an owner-controlled room switch that pauses new invites, joins, messages, prompts and uploads
  while preserving history and stop control;
- real-time WebSocket updates;
- a Codex plugin exposed through MCP tools;
- one-time web-to-local host pairing and existing Codex task selection;
- importing visible Codex conversation records into the room;
- approved-member read-only browsing of a filtered project-file snapshot;
- forwarding approved members' queued prompts into the selected live Codex Desktop conversation
  through the same-user local IPC router without opening, focusing or switching the window;
- remote composer support for file/image attachments, model/reasoning/speed, plan mode and stop;
- explicit project-root file access with symlink escape protection;
- optimistic SHA-256 conflict detection for concurrent writes.

The public test deployment is available at
<https://codex-collab.217.194.133.194.sslip.io/>. Version `0.1.0` is ready for invited MVP
testing; production-hardening work is tracked separately and is not represented as complete.

## Repository

```text
apps/relay/                 HTTP/WebSocket relay and collaboration dashboard
packages/protocol/          Shared protocol types and request validation
plugins/codex-collab/       Codex plugin, MCP server and collaboration skill
.agents/plugins/            Repo-local Codex marketplace
docs/                       Architecture and security notes
```

## Documentation

- [Complete project guide](docs/PROJECT.md)
- [Architecture and trust model](docs/architecture.md)
- [Deployment and operations](docs/DEPLOYMENT.md)
- [Testing guide](docs/TESTING.md)
- [Task plan and roadmap](docs/TASK_PLAN.md)
- [Full v1 implementation plan](docs/V1_IMPLEMENTATION_PLAN.md)

## Local development

Requirements: Node.js 24+, npm 11+, Codex CLI 0.144.4 or newer.

```powershell
cd E:\Codex-Collab
npm install
npm run build
npm test
npm run dev
```

Open `http://127.0.0.1:4177`.

## Invite a tester

1. Create a collaboration session in the dashboard.
2. Select **创建邀请** and copy the one-time web link.
3. Send the complete link to the tester. Opening it pre-fills the invite token.
4. After the tester submits a display name, approve the pending member in the dashboard.

The owner can close the room from the top bar. Closing it keeps the existing conversation and
member list readable, but rejects new invitations, joins, chat messages, Codex prompts and
attachments until the owner reopens it.

## Import Codex records and project files

1. Create a room in the dashboard and open **Codex 与文件**.
2. As the owner, generate the ten-minute, one-time host pairing code.
3. In the owner's local Codex, ask it to run `collab_pair_host` with that code, the public Relay
   URL, and the explicitly approved absolute project root.
4. Return to **Codex 与文件** and select one of the Codex tasks discovered under that root.
5. The local background sync worker imports visible user/assistant messages, app-server reasoning
   summaries, command output and a view-only text snapshot. Relay WebSocket events wake it
   immediately for new web prompts, which it forwards through Codex Desktop's same-user local IPC
   router so the currently open task receives the native message and continues in place. It
   republishes when the selected task changes and never opens or focuses the Desktop window.
6. Approved members can inspect the selected task record and shared files; pending members cannot.

To share non-credential Codex configuration, pass `codexConfigRoot` as a second explicit absolute
root when calling `collab_pair_host` or `collab_refresh_workspace`. It includes text configuration,
rules and documentation under `.codex/`, while excluding `auth.json`, session/history databases,
environment files, private keys and likely embedded credentials. Project permission never implies
`.codex` permission. Use `collab_refresh_workspace` to refresh the task catalog or force an
immediate snapshot; selected-task record changes otherwise sync automatically.

If the browser blocks automatic clipboard access, the dashboard falls back to synchronous copy.
When both browser copy mechanisms are unavailable, it selects the complete link and prompts the
owner to press `Ctrl+C`.

An invite created from `127.0.0.1` or `localhost` works only on the same computer. For another
device on a trusted LAN, listen on all interfaces and open the dashboard through the owner's LAN
address before creating the invite:

```powershell
$env:HOST = "0.0.0.0"
npm run dev
```

Then open `http://<owner-lan-ip>:4177` and create the invite from that page. Do not expose this
plain-HTTP development listener directly to the public internet.

## Install the plugin

Requirements: Git, Node.js 24+, npm 11+, and Codex CLI 0.144.4 or newer.

Clone and build the public repository, then register its repo-local marketplace:

```powershell
git clone https://github.com/grennd-hand/Codex-Collab.git
Set-Location Codex-Collab
npm ci
npm run build
codex plugin marketplace add (Get-Location).Path
codex plugin add codex-collab@codex-collab-local
```

Start a new Codex thread after installation so the new skill and MCP tools are loaded.

## Security boundary

An invited member cannot send messages or access files until the owner approves them. The plugin
stores member bearer tokens only in the local profile file and the relay stores only token hashes.

The owner chooses one absolute shared root. Project access does not imply access to `~/.codex`;
sharing Codex configuration requires the owner to explicitly bind that directory as a separate root.
Web prompts from approved members are consumed automatically by the local owner host. Only the
owner can change the access mode, and peer prompts preserve the selected task's existing approval
policy.

## Server deployment

The relay is prepared for Docker deployment:

```bash
docker compose up -d --build
```

Put it behind an HTTPS reverse proxy before using it across the public internet. Configure
`CODEX_COLLAB_RELAY_URL` in the plugin to the resulting HTTPS origin. Set
`CODEX_COLLAB_PUBLIC_URL` to that same origin so invites created through MCP contain a usable web
link. If the reverse proxy supplies `X-Forwarded-Proto`, set `CODEX_COLLAB_TRUST_PROXY=1`.

### VPS deployment

The `deploy` directory provides an isolated Docker Compose stack with a persistent Relay volume and
Caddy-managed HTTPS/WebSocket proxy. It only publishes port 443, so it can coexist with another
service already using port 80.

```bash
cd deploy
cp .env.example .env
# Set CODEX_COLLAB_DOMAIN to a hostname that resolves to the VPS.
docker compose up -d --build
```

The Relay is reachable only through Caddy. SQLite data, Caddy certificates, and Caddy configuration
are stored in named Docker volumes and survive container replacement.
