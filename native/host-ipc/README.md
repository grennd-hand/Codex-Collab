# Codex Collab Host IPC broker

This Windows x64 helper is the native security boundary for the owner Host. It creates a byte-mode
Named Pipe with:

- a protected DACL granting access only to the current user SID and `SYSTEM`;
- `PIPE_REJECT_REMOTE_CLIENTS`;
- an explicit post-connect client SID comparison under `ImpersonateNamedPipeClient`;
- a two-second, replay-protected, mutual HMAC-SHA256 handshake;
- 8 KiB unauthenticated and 16 MiB authenticated little-endian length-prefixed JSON frames;
- separate, freshly generated MCP and Desktop capabilities on every broker start;
- eight active connections and bounded parent/client queues.
- a fixed `Local\\CodexCollabHost-<current-user-SID-hash>` mutex acquired before bootstrap.

The mutex is the authoritative concurrent-launch gate. A second broker for the same Windows user
does not emit `broker.ready`; it writes the stable `host_already_running` marker to stderr and exits
with code `23`. The mutex handle is held for the broker lifetime and Windows releases it after a
normal exit or process crash.

The executable never accepts a secret through command-line arguments or environment variables. The
trusted TypeScript Host starts it with redirected stdio and sends this first frame:

```json
{"v":1,"type":"broker.bootstrap"}
```

The broker creates the pipe, generates capabilities, and answers on stdout with a
`broker.ready` frame containing `instanceId`, `pipePath`, `pid`, and the two capabilities. That frame
is sensitive control-plane data: the Host must consume it without logging it, DPAPI-protect the
client-specific capability at rest, and zero temporary buffers.

Named-Pipe clients use the canonical schema in
`plugins/codex-collab/src/host/ipc/protocol.ts`: `auth.hello`, `auth.challenge`, `auth.proof`,
`auth.ready`, then `request`/`response`. HMAC input is exactly:

```text
codex-collab-host-ipc-v1\0<server|client>\0<JSON.stringify(challenge-without-proof)>
```

The transcript field order is `v`, `type`, `clientKind`, `keyId`, `clientNonce`, `serverNonce`,
`expiresAt`. MCP may use the 18 allowlisted Host tools plus `host.status`; Desktop may use only
`host.status` and `host.gracefulStop`.

After authentication, the broker wraps client requests for the TypeScript parent:

```json
{
  "v": 1,
  "type": "broker.request",
  "connectionId": 1,
  "peer": {
    "clientKind": "mcp",
    "keyId": "...",
    "sessionId": "...",
    "authenticatedAt": 0
  },
  "request": { "v": 1, "type": "request", "id": "...", "method": "...", "params": {}, "sentAt": 0, "timeoutMs": 30000 }
}
```

The parent returns a `broker.response` with the same `connectionId` and a canonical Host IPC
`response`. The broker removes routing metadata before writing to the client.

This crate is independently functional but is not activated by the existing Node Host until the
TypeScript launcher and dispatcher wire this stdio control protocol. It intentionally has no legacy
or in-process fallback, because such a fallback could create a second Host writer.

Build and test on Windows:

```powershell
cargo fmt --manifest-path native/host-ipc/Cargo.toml --check
cargo check --manifest-path native/host-ipc/Cargo.toml
cargo test --manifest-path native/host-ipc/Cargo.toml
```
