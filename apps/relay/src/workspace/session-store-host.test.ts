import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../application/session-store.js";
import { createStore, publishIdeFile, selectIdeThread } from "../testing/session-store-test-support.js";

describe("SessionStore migration and host boundaries", () => {
  it("migrates delivery tracking without losing existing attachments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-migration-"));
    const filename = join(directory, "relay.sqlite");
    const browserToken = "ccm_legacy-browser-token";
    const oldHostToken = "cch_legacy-host-token";
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_member_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        device_label TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        approved_at TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sender_member_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'codex_prompt', 'codex_stop', 'system')),
        body TEXT NOT NULL,
        codex_options_json TEXT,
        delivery_status TEXT CHECK (delivery_status IN ('queued', 'submitted', 'failed')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        content BLOB NOT NULL
      );
      CREATE TABLE member_tokens (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        device_label TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE workspace_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        host_device_label TEXT NOT NULL,
        root_label TEXT NOT NULL,
        host_token_id TEXT,
        host_generation TEXT,
        catalog_json TEXT NOT NULL DEFAULT '[]',
        selected_thread_id TEXT,
        history_json TEXT NOT NULL DEFAULT '[]',
        synced_at TEXT
      );
      INSERT INTO sessions VALUES ('session-1', 'Room', 'owner-1', '2026-07-25T00:00:00.000Z');
      INSERT INTO sessions VALUES ('session-2', 'No task room', 'owner-2', '2026-07-25T00:00:00.000Z');
      INSERT INTO members VALUES (
        'owner-1', 'session-1', 'Owner', NULL, 'owner', 'approved',
        '${createHash("sha256").update(browserToken).digest("hex")}',
        '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
      );
      INSERT INTO members VALUES (
        'owner-2', 'session-2', 'Owner 2', NULL, 'owner', 'approved',
        '${createHash("sha256").update("ccm_second-browser-token").digest("hex")}',
        '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
      );
      INSERT INTO member_tokens VALUES (
        'legacy-host-token-id', 'session-1', 'owner-1',
        '${createHash("sha256").update(oldHostToken).digest("hex")}',
        'Old host', '2026-07-25T00:00:00.000Z'
      );
      INSERT INTO messages VALUES (
        'message-1', 'session-1', 'owner-1', 'codex_prompt', 'Run',
        NULL, 'submitted', '2026-07-25T00:00:00.000Z'
      );
      INSERT INTO messages VALUES (
        'message-2', 'session-1', 'owner-1', 'codex_prompt', 'Already failed',
        NULL, 'failed', '2026-07-25T00:00:01.000Z'
      );
      INSERT INTO messages VALUES (
        'message-3', 'session-2', 'owner-2', 'codex_prompt', 'No task',
        NULL, 'queued', '2026-07-25T00:00:02.000Z'
      );
      INSERT INTO workspace_state VALUES (
        'session-1', 'Legacy host', 'Project', 'legacy-host-token-id',
        'legacy-generation', '[]', 'thread-legacy', '[]', NULL
      );
    `);
    legacy
      .prepare(
        "INSERT INTO message_attachments VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "attachment-1",
        "message-1",
        "notes.txt",
        "text/plain",
        4,
        new TextEncoder().encode("body"),
      );
    legacy.close();

    const migrated = new SessionStore(filename);
    try {
      const message = migrated.db
        .prepare(
          "SELECT delivery_status, codex_turn_id, selected_thread_id, completed_at FROM messages WHERE id = ?",
        )
        .get("message-1") as
        | {
            delivery_status: string;
            codex_turn_id: string | null;
            selected_thread_id: string | null;
            completed_at: string | null;
          }
        | undefined;
      const attachment = migrated.db
        .prepare("SELECT content FROM message_attachments WHERE id = ?")
        .get("attachment-1") as { content: Uint8Array } | undefined;
      const terminal = migrated.db
        .prepare("SELECT selected_thread_id FROM messages WHERE id = 'message-2'")
        .get() as { selected_thread_id: string | null };
      const unbound = migrated.db
        .prepare(
          "SELECT delivery_status, codex_turn_id, selected_thread_id, completed_at FROM messages WHERE id = 'message-3'",
        )
        .get() as {
        delivery_status: string;
        codex_turn_id: string | null;
        selected_thread_id: string | null;
        completed_at: string | null;
      };

      expect(message).toEqual({
        delivery_status: "failed",
        codex_turn_id: "migration:no-selected-workspace-task",
        selected_thread_id: null,
        completed_at: expect.any(String),
      });
      expect(terminal.selected_thread_id).toBeNull();
      expect(unbound).toMatchObject({
        delivery_status: "failed",
        codex_turn_id: "migration:no-selected-workspace-task",
        selected_thread_id: null,
        completed_at: expect.any(String),
      });
      expect(migrated.getWorkspace("session-1", browserToken).hostConnected).toBe(false);
      expect(
        migrated.db
          .prepare("SELECT host_token_id, host_generation FROM workspace_state WHERE session_id = ?")
          .get("session-1"),
      ).toEqual({ host_token_id: null, host_generation: null });
      expect(() => migrated.getWorkspace("session-1", oldHostToken)).toThrowError(/invalid/i);
      expect(() =>
        migrated.publishWorkspaceCatalog("session-1", browserToken, {
          deviceLabel: "Browser",
          rootLabel: "Project",
          threads: [],
        }),
      ).toThrowError(/host token/i);
      expect(() =>
        migrated.createHostPairing("session-1", oldHostToken, 10),
      ).toThrowError(/browser session/i);
      expect(() => migrated.createInvite("session-1", oldHostToken, 10, 1)).toThrowError(
        /browser session/i,
      );
      expect(() =>
        migrated.approveMember("session-1", oldHostToken, "missing-member"),
      ).toThrowError(/browser session/i);
      expect(() =>
        migrated.claimNextWorkspaceFileOperation("session-1", oldHostToken),
      ).toThrowError(/invalid/i);
      expect(() =>
        migrated.publishWorkspaceCatalog("session-1", oldHostToken, {
          deviceLabel: "Old host",
          rootLabel: "Old project",
          threads: [],
        }),
      ).toThrowError(/invalid/i);
      const repairedPairing = migrated.createHostPairing("session-1", browserToken, 10);
      const repairedHost = migrated.claimHostPairing(
        repairedPairing.pairingToken,
        "New host",
        "Project",
      );
      expect(
        migrated.publishWorkspaceCatalog("session-1", repairedHost.memberToken, {
          deviceLabel: "New host",
          rootLabel: "Project",
          threads: [],
        }).hostConnected,
      ).toBe(true);
      expect(new TextDecoder().decode(attachment?.content)).toBe("body");
      expect(
        (
          migrated.db
            .prepare("SELECT room_status, owner_recovery_hash FROM sessions WHERE id = ?")
            .get("session-1") as {
            room_status: string;
            owner_recovery_hash: string | null;
          }
        ),
      ).toEqual({ room_status: "open", owner_recovery_hash: null });
      const accountTables = migrated.db
        .prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN (
            'accounts', 'account_credentials', 'account_challenges',
            'account_sessions', 'account_memberships'
          )
        `)
        .all() as unknown as Array<{ name: string }>;
      expect(accountTables.map((row) => row.name).sort()).toEqual([
        "account_challenges",
        "account_credentials",
        "account_memberships",
        "account_sessions",
        "accounts",
      ]);
      const memberTokenColumns = migrated.db
        .prepare("PRAGMA table_info(member_tokens)")
        .all() as unknown as Array<{ name: string }>;
      expect(memberTokenColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["account_session_id", "expires_at", "revoked_at"]),
      );
      const migratedOwner = migrated.db
        .prepare("SELECT workspace_file_access FROM members WHERE id = 'owner-1'")
        .get() as { workspace_file_access: string };
      expect(migratedOwner.workspace_file_access).toBe("workspace-write");
      expect(
        migrated.db
          .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workspace_file_operations'",
          )
          .get(),
      ).toBeTruthy();
    } finally {
      migrated.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pairs one local host once and stores only hashed pairing and host tokens", () => {
    const store = createStore();
    const created = store.createSession("Workspace room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const claimed = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Codex-Collab");

    expect(claimed.owner.id).toBe(created.owner.id);
    expect(claimed.memberToken).not.toBe(created.memberToken);
    expect(() =>
      store.claimHostPairing(pairing.pairingToken, "Second PC", "Other"),
    ).toThrowError(/already been used/i);

    const pairingRows = store.db
      .prepare("SELECT token_hash FROM host_pairings")
      .all() as unknown as Array<{ token_hash: string }>;
    const hostRows = store.db
      .prepare("SELECT token_hash FROM member_tokens")
      .all() as unknown as Array<{ token_hash: string }>;
    expect(pairingRows[0]?.token_hash).not.toContain(pairing.pairingToken);
    expect(hostRows[0]?.token_hash).not.toContain(claimed.memberToken);
    expect(pairingRows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hostRows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      store.createInvite(created.session.id, claimed.memberToken, 10, 1),
    ).toThrowError(/browser session/i);
  });

  it("keeps browser-owner actions separate from current-host worker actions", () => {
    const store = createStore();
    const created = store.createSession("Host actions", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [{ id: "thread-host", name: "Host", preview: "", updatedAt: null }],
    });

    expect(() =>
      store.selectWorkspaceThread(created.session.id, host.memberToken, "thread-host"),
    ).toThrowError(/browser session/i);
    expect(() =>
      store.selectWorkspaceThreadFromHost(
        created.session.id,
        created.memberToken,
        "thread-host",
      ),
    ).toThrowError(/host token/i);
    expect(
      store.selectWorkspaceThreadFromHost(
        created.session.id,
        host.memberToken,
        "thread-host",
      ).selectedThreadId,
    ).toBe("thread-host");

    const command = store.addMessage(
      created.session.id,
      created.memberToken,
      "codex_prompt",
      "Run",
      { expectedWorkspaceThreadId: "thread-host" },
    );
    expect(() =>
      store.updateMessageDeliveryStatus(
        created.session.id,
        host.memberToken,
        command.id,
        "submitted",
      ),
    ).toThrowError(/browser session/i);
    expect(
      store.updateMessageDeliveryStatusFromHost(
        created.session.id,
        host.memberToken,
        command.id,
        "submitted",
        "turn-host",
      ),
    ).toMatchObject({ deliveryStatus: "submitted", codexTurnId: "turn-host" });
  });

  it("withholds write capability until confirmation and rejects removed snapshot files", () => {
    const store = createStore();
    const created = store.createSession("Two phase", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const expectedSha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "src/existing.ts",
      "before",
    );
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: "src/guessed.ts",
        content: "created",
        expectedSha256,
      }),
    ).toThrowError(/no longer present/i);
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      {
        kind: "write",
        path: "src/existing.ts",
        content: "after",
        expectedSha256,
      },
    );
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    expect(claim).not.toHaveProperty("requestContent");
    expect(claim.expectedSha256).toBeNull();
    expect(() =>
      store.getWorkspaceFileOperation(created.session.id, host.memberToken, queued.id),
    ).toThrowError(/browser member/i);
    expect(() =>
      store.completeWorkspaceFileOperation(created.session.id, host.memberToken, queued.id, {
        status: "failed",
        leaseId: claim.leaseId,
        errorCode: "bypass",
        errorMessage: "bypass",
      }),
    ).toThrowError(/currently claimed/i);

    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "thread-ide",
      history: [],
      files: [],
    });
    expect(() =>
      store.confirmWorkspaceFileOperationLease(
        created.session.id,
        host.memberToken,
        queued.id,
        claim.leaseId,
      ),
    ).toThrowError(/no longer present/i);
    expect(
      store.db
        .prepare("SELECT status, request_content FROM workspace_file_operations WHERE id = ?")
        .get(queued.id),
    ).toEqual({ status: "failed", request_content: null });
  });

  it("rejects forged secret-bearing workspace snapshots at the Relay boundary", () => {
    const store = createStore();
    const created = store.createSession("Snapshot policy", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);

    for (const [path, content] of [
      [".env", "SAFE=value"],
      [".codex/auth.json", "{}"],
      [".aws/settings.json", "{}"],
      [".SSH/public.txt", "not-public-through-collab"],
      ["node_modules/package/index.ts", "export {};"],
      ["src/config.ts", "ACCESS_TOKEN=custom-super-secret-token-123456"],
    ] as const) {
      expect(() =>
        store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
          threadId: "thread-ide",
          history: [],
          files: [
            {
              path,
              content,
              size: Buffer.byteLength(content),
              modifiedAt: "2026-07-27T00:00:00.000Z",
              sha256: createHash("sha256").update(content).digest("hex"),
            },
          ],
        }),
      ).toThrow();
    }
    expect(store.getWorkspace(created.session.id, created.memberToken).files).toEqual([]);
  });

  it("requires a selected task and queues only safe read-only Codex config paths", () => {
    const store = createStore();
    const created = store.createSession("Config IDE room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");

    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "read",
        path: ".codex/config.toml",
      }),
    ).toThrowError(/select a Codex task/i);
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const read = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: ".codex/config.toml" },
    );
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    expect(claim).toMatchObject({
      id: read.id,
      path: ".codex/config.toml",
      hostGeneration: expect.any(String),
      leaseId: expect.any(String),
      leaseExpiresAt: expect.any(String),
    });
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: ".codex/config.toml",
        content: "model = 'changed'",
        expectedSha256: "a".repeat(64),
      }),
    ).toThrowError(/read-only/i);
    for (const path of [
      ".codex/auth.json",
      ".codex/sessions/thread.json",
      ".codex/memories/MEMORY.md",
    ]) {
      expect(() =>
        store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
          kind: "read",
          path,
        }),
      ).toThrowError(/not available/i);
    }
  });

});
