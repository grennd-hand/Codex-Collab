# Codex Collab

Codex Collab is a local-first control room for a small trusted team working with one owner-controlled
Codex installation.

The first working slice includes:

- identity-labelled shared chat;
- one-time invitation tokens and explicit owner approval;
- real-time WebSocket updates;
- a Codex plugin exposed through MCP tools;
- binding a collaboration room to an existing Codex thread;
- forwarding a relay-backed peer prompt through Codex `app-server`;
- explicit project-root file access with symlink escape protection;
- optimistic SHA-256 conflict detection for concurrent writes.

## Repository

```text
apps/relay/                 HTTP/WebSocket relay and collaboration dashboard
packages/protocol/          Shared protocol types and request validation
plugins/codex-collab/       Codex plugin, MCP server and collaboration skill
.agents/plugins/            Repo-local Codex marketplace
docs/                       Architecture and security notes
```

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

An invite created from `127.0.0.1` or `localhost` works only on the same computer. For another
device on a trusted LAN, listen on all interfaces and open the dashboard through the owner's LAN
address before creating the invite:

```powershell
$env:HOST = "0.0.0.0"
npm run dev
```

Then open `http://<owner-lan-ip>:4177` and create the invite from that page. Do not expose this
plain-HTTP development listener directly to the public internet.

## Install the repo-local plugin

The marketplace lives in this repository, so register it once:

```powershell
codex plugin marketplace add E:\Codex-Collab
codex plugin add codex-collab@codex-collab-local
```

Start a new Codex thread after installation so the new skill and MCP tools are loaded.

## Security boundary

An invited member cannot send messages or access files until the owner approves them. The plugin
stores member bearer tokens only in the local profile file and the relay stores only token hashes.

The owner chooses one absolute shared root. Project access does not imply access to `~/.codex`;
sharing Codex configuration requires the owner to explicitly bind that directory as a separate root.
Peer prompts preserve the owner task's existing approval policy.

## Server deployment

The relay is prepared for Docker deployment:

```bash
docker compose up -d --build
```

Put it behind an HTTPS reverse proxy before using it across the public internet. Configure
`CODEX_COLLAB_RELAY_URL` in the plugin to the resulting HTTPS origin. Set
`CODEX_COLLAB_PUBLIC_URL` to that same origin so invites created through MCP contain a usable web
link. If the reverse proxy supplies `X-Forwarded-Proto`, set `CODEX_COLLAB_TRUST_PROXY=1`.
