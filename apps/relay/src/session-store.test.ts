import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { SessionStore } from "./session-store.js";

const stores: SessionStore[] = [];

function createStore(): SessionStore {
  const store = new SessionStore();
  stores.push(store);
  return store;
}

function selectIdeThread(
  store: SessionStore,
  sessionId: string,
  ownerToken: string,
  hostToken: string,
): void {
  store.publishWorkspaceCatalog(sessionId, hostToken, {
    deviceLabel: "Owner PC",
    rootLabel: "Project",
    threads: [{ id: "thread-ide", name: "IDE task", preview: "", updatedAt: null }],
  });
  store.selectWorkspaceThread(sessionId, ownerToken, "thread-ide");
}

function publishIdeFile(
  store: SessionStore,
  sessionId: string,
  hostToken: string,
  path: string,
  content: string,
): string {
  const sha256 = createHash("sha256").update(content).digest("hex");
  store.publishWorkspaceSnapshot(sessionId, hostToken, {
    threadId: "thread-ide",
    history: [],
    files: [
      {
        path,
        content,
        size: Buffer.byteLength(content),
        modifiedAt: "2026-07-27T00:00:00.000Z",
        sha256,
      },
    ],
  });
  return sha256;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

describe("SessionStore", () => {
  it("configures SQLite to wait briefly for concurrent writers", () => {
    const store = createStore();
    const pragma = store.db.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };

    expect(pragma.timeout).toBe(5_000);
  });

  it("requires owner approval before an invited member can collaborate", () => {
    const store = createStore();
    const created = store.createSession("Launch room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [{ id: "thread-1", name: "Task", preview: "", updatedAt: null }],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
    const invite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const joined = store.joinInvite(invite.inviteToken, "Guest", "Laptop");

    expect(joined.member.status).toBe("pending");
    expect(() =>
      store.addMessage(created.session.id, joined.memberToken, "chat", "before approval"),
    ).toThrowError(/approval/i);

    const approved = store.approveMember(
      created.session.id,
      created.memberToken,
      joined.member.id,
    );
    expect(approved.status).toBe("approved");
    expect(() =>
      store.addMessage(
        created.session.id,
        joined.memberToken,
        "codex_prompt",
        "Bypass approvals",
        {
          codexOptions: {
            accessMode: "full-access",
            customPermissions: null,
            model: null,
            reasoningEffort: "follow-desktop",
            speed: "follow-desktop",
            planMode: false,
          },
        },
      ),
    ).toThrowError(/owner/i);
    expect(() =>
      store.addMessage(
        created.session.id,
        joined.memberToken,
        "codex_prompt",
        "Try custom permissions",
        {
          codexOptions: {
            accessMode: "custom",
            customPermissions: {
              fileAccess: "workspace-write",
              approvalPolicy: "on-request",
            },
            model: null,
            reasoningEffort: "follow-desktop",
            speed: "follow-desktop",
            planMode: false,
          },
        },
      ),
    ).toThrowError(/owner/i);

    const message = store.addMessage(
      created.session.id,
      joined.memberToken,
      "codex_prompt",
      "Run the tests",
    );
    expect(message.senderDisplayName).toBe("Guest");
    expect(store.listMessages(created.session.id, created.memberToken)).toEqual([message]);
  });

  it("enforces one-time invites", () => {
    const store = createStore();
    const created = store.createSession("Pairing", "Owner");
    const invite = store.createInvite(created.session.id, created.memberToken, 60, 1);

    store.joinInvite(invite.inviteToken, "First");
    expect(() => store.joinInvite(invite.inviteToken, "Second")).toThrowError(/already been used/i);
  });

  it("lets only the owner close and reopen a room while preserving reads and host sync", () => {
    const store = createStore();
    const created = store.createSession("Controlled room", "Owner");
    expect(created.session.roomStatus).toBe("open");

    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Codex-Collab");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Codex-Collab",
      threads: [{ id: "thread-1", name: "Current task", preview: "", updatedAt: null }],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
    const firstInvite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const secondInvite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const guest = store.joinInvite(firstInvite.inviteToken, "Guest");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);

    const content = new TextEncoder().encode("kept attachment");
    const existingPrompt = store.addMessage(
      created.session.id,
      guest.memberToken,
      "codex_prompt",
      "Keep this history",
      {
        attachments: [
          {
            name: "kept.txt",
            mediaType: "text/plain",
            size: content.length,
            content,
          },
        ],
      },
    );
    const attachmentId = existingPrompt.attachments[0]!.id;

    expect(() =>
      store.updateRoomStatus(created.session.id, guest.memberToken, "closed"),
    ).toThrowError(/owner/i);
    expect(
      store.updateRoomStatus(created.session.id, created.memberToken, "closed").roomStatus,
    ).toBe("closed");

    expect(() =>
      store.createInvite(created.session.id, created.memberToken, 60, 1),
    ).toThrowError(/closed/i);
    expect(() => store.joinInvite(secondInvite.inviteToken, "Late guest")).toThrowError(
      /closed/i,
    );
    expect(() =>
      store.addMessage(created.session.id, created.memberToken, "chat", "blocked chat"),
    ).toThrowError(/closed/i);
    expect(() =>
      store.addMessage(
        created.session.id,
        guest.memberToken,
        "codex_prompt",
        "blocked prompt",
        {
          attachments: [
            {
              name: "blocked.txt",
              mediaType: "text/plain",
              size: content.length,
              content,
            },
          ],
        },
      ),
    ).toThrowError(/closed/i);

    expect(store.listMessages(created.session.id, guest.memberToken)).toEqual([
      existingPrompt,
    ]);
    expect(
      new TextDecoder().decode(
        store.getMessageAttachment(
          created.session.id,
          guest.memberToken,
          existingPrompt.id,
          attachmentId,
        ).content,
      ),
    ).toBe("kept attachment");

    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Codex-Collab",
      threads: [{ id: "thread-1", name: "Current task", preview: "", updatedAt: null }],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "thread-1",
      history: [{ id: "entry-1", role: "assistant", text: "still synced", createdAt: null }],
      files: [],
    });
    expect(
      store.publishCodexRuntimeStatus(created.session.id, host.memberToken, "running")
        .workspace.history[0]?.text,
    ).toBe("still synced");
    expect(store.getWorkspace(created.session.id, guest.memberToken).history[0]?.text).toBe(
      "still synced",
    );

    const stop = store.addMessage(
      created.session.id,
      guest.memberToken,
      "codex_stop",
      "Stop current execution",
    );
    expect(stop.deliveryStatus).toBe("queued");

    expect(
      store.updateRoomStatus(created.session.id, created.memberToken, "open").roomStatus,
    ).toBe("open");
    expect(store.joinInvite(secondInvite.inviteToken, "Late guest").member.status).toBe(
      "pending",
    );
    expect(
      store.addMessage(created.session.id, created.memberToken, "chat", "room reopened").body,
    ).toBe("room reopened");
  });

  it("stores Codex composer options and attachments with auditable delivery state", () => {
    const store = createStore();
    const created = store.createSession("Composer room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [{ id: "thread-1", name: "Task", preview: "", updatedAt: null }],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
    const content = new TextEncoder().encode("attachment body");
    const message = store.addMessage(
      created.session.id,
      created.memberToken,
      "codex_prompt",
      "Review the attachment",
      {
        attachments: [
          {
            name: "notes.txt",
            mediaType: "text/plain",
            size: content.length,
            content,
          },
        ],
        codexOptions: {
          accessMode: "custom",
          customPermissions: {
            fileAccess: "workspace-write",
            approvalPolicy: "on-request",
          },
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          speed: "fast",
          planMode: true,
        },
      },
    );

    expect(message.deliveryStatus).toBe("queued");
    expect(message.attachments).toHaveLength(1);
    expect(message.codexOptions?.model).toBe("gpt-5.6-sol");
    expect(message.codexOptions?.customPermissions).toEqual({
      fileAccess: "workspace-write",
      approvalPolicy: "on-request",
    });
    const attachment = message.attachments[0]!;
    expect(
      Buffer.from(
        store.getMessageAttachment(
          created.session.id,
          created.memberToken,
          message.id,
          attachment.id,
        ).content,
      ).toString("utf8"),
    ).toBe("attachment body");

    const submitted = store.updateMessageDeliveryStatus(
      created.session.id,
      created.memberToken,
      message.id,
      "submitted",
      "turn-1",
    );
    expect(submitted.deliveryStatus).toBe("submitted");
    expect(submitted.codexTurnId).toBe("turn-1");
    expect(submitted.completedAt).toBeNull();

    const completed = store.updateMessageDeliveryStatus(
      created.session.id,
      created.memberToken,
      message.id,
      "completed",
      "turn-1",
    );
    expect(completed.deliveryStatus).toBe("completed");
    expect(completed.codexTurnId).toBe("turn-1");
    expect(completed.completedAt).not.toBeNull();
  });

  it("returns the most recent 500 messages in chronological order", () => {
    const store = createStore();
    const created = store.createSession("Long room", "Owner");
    const insert = store.db.prepare(`
      INSERT INTO messages
        (id, session_id, sender_member_id, kind, body, codex_options_json,
         delivery_status, codex_turn_id, completed_at, created_at)
      VALUES (?, ?, ?, 'chat', ?, NULL, NULL, NULL, NULL, ?)
    `);

    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 501; index += 1) {
        const suffix = index.toString().padStart(3, "0");
        insert.run(
          `message-${suffix}`,
          created.session.id,
          created.session.ownerMemberId,
          `body-${suffix}`,
          new Date(Date.UTC(2026, 6, 25, 0, 0, index)).toISOString(),
        );
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }

    const messages = store.listMessages(created.session.id, created.memberToken);
    expect(messages).toHaveLength(500);
    expect(messages[0]?.id).toBe("message-001");
    expect(messages.at(-1)?.id).toBe("message-500");
  });

  it("stores member chat files and rejects attachments on stop commands", () => {
    const store = createStore();
    const created = store.createSession("Chat files", "Owner");
    const content = new TextEncoder().encode("shared in chat");
    const message = store.addMessage(
      created.session.id,
      created.memberToken,
      "chat",
      "请看这个文件",
      {
        attachments: [
          {
            name: "chat-note.txt",
            mediaType: "text/plain",
            size: content.length,
            content,
          },
        ],
      },
    );

    expect(message.attachments).toHaveLength(1);
    expect(message.deliveryStatus).toBeNull();
    expect(
      new TextDecoder().decode(
        store.getMessageAttachment(
          created.session.id,
          created.memberToken,
          message.id,
          message.attachments[0]!.id,
        ).content,
      ),
    ).toBe("shared in chat");

    expect(() =>
      store.addMessage(
        created.session.id,
        created.memberToken,
        "codex_stop",
        "Stop",
        {
          attachments: [
            {
              name: "blocked.txt",
              mediaType: "text/plain",
              size: content.length,
              content,
            },
          ],
        },
      ),
    ).toThrowError(/attachments/i);
  });

  it("does not store bearer tokens in plaintext", () => {
    const store = createStore();
    const created = store.createSession("Secure room", "Owner");
    const rows = store.db.prepare("SELECT token_hash FROM members").all() as unknown as Array<{
      token_hash: string;
    }>;

    expect(rows[0]?.token_hash).not.toContain(created.memberToken);
    expect(rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

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
            .prepare("SELECT room_status FROM sessions WHERE id = ?")
            .get("session-1") as { room_status: string }
        ).room_status,
      ).toBe("open");
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
    ).toThrowError(/already present|existing shared/i);
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

  it("queues auditable host file operations behind explicit member write access", () => {
    const store = createStore();
    const created = store.createSession("IDE room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const readContent = "export const oldValue = true;";
    const originalSha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "src/index.ts",
      readContent,
    );
    const invite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const guest = store.joinInvite(invite.inviteToken, "Editor");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);

    expect(created.owner.workspaceFileAccess).toBe("workspace-write");
    expect(store.getCurrentMember(created.session.id, guest.memberToken).workspaceFileAccess).toBe(
      "read-only",
    );
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, guest.memberToken, {
        kind: "write",
        path: "src/index.ts",
        content: "export {};",
        expectedSha256: originalSha256,
      }),
    ).toThrowError(/not granted/i);

    const read = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      { kind: "read", path: "src/index.ts" },
    );
    expect(read.status).toBe("queued");
    expect(read.resultFile).toBeNull();

    const writable = store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );
    expect(writable.workspaceFileAccess).toBe("workspace-write");
    const write = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      {
        kind: "write",
        path: "src/index.ts",
        content: "export {};",
        expectedSha256: originalSha256,
      },
    );
    expect(write.status).toBe("queued");
    expect(write.completedAt).toBeNull();
    store.db
      .prepare("UPDATE workspace_file_operations SET requested_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", read.id);

    const firstClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    );
    expect(firstClaim.operation?.id).toBe(read.id);
    expect(firstClaim.operation).not.toHaveProperty("requestContent");
    expect(firstClaim.operation?.expectedSha256).toBeNull();
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      read.id,
      firstClaim.operation!.leaseId,
    );
    store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      read.id,
      {
        status: "completed",
        leaseId: firstClaim.operation!.leaseId,
        file: {
          path: "src/index.ts",
          content: readContent,
          size: Buffer.byteLength(readContent),
          modifiedAt: "2026-07-27T00:00:00.000Z",
          sha256: createHash("sha256").update(readContent).digest("hex"),
        },
      },
    );
    const secondClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    );
    expect(secondClaim.operation?.id).toBe(write.id);
    expect(secondClaim.operation).not.toHaveProperty("requestContent");
    expect(secondClaim.operation?.expectedSha256).toBeNull();
    const confirmedWrite = store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      write.id,
      secondClaim.operation!.leaseId,
    );
    expect(confirmedWrite.requestContent).toBe("export {};");
    expect(confirmedWrite.expectedSha256).toBe(originalSha256);
    const savedContent = "export {};";
    const completed = store.completeWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
      write.id,
      {
        status: "completed",
        leaseId: secondClaim.operation!.leaseId,
        file: {
          path: "src/index.ts",
          content: savedContent,
          size: Buffer.byteLength(savedContent),
          modifiedAt: "2026-07-27T00:00:01.000Z",
          sha256: createHash("sha256").update(savedContent).digest("hex"),
        },
      },
    );
    expect(completed.status).toBe("completed");
    expect(completed.resultFile?.content).toBe(savedContent);
    expect(
      store.getWorkspaceFile(created.session.id, guest.memberToken, "src/index.ts").content,
    ).toBe(savedContent);
    expect(
      store.listWorkspaceFileOperations(created.session.id, guest.memberToken),
    ).toHaveLength(2);
  });

  it("rechecks queued write permission and rejects private or unsafe editor paths", () => {
    const store = createStore();
    const created = store.createSession("Secure IDE room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const readmeSha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "README.md",
      "original",
    );
    const invite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const guest = store.joinInvite(invite.inviteToken, "Editor");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      {
        kind: "write",
        path: "README.md",
        content: "queued",
        expectedSha256: readmeSha256,
      },
    );
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "read-only",
    );
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    );
    expect(claim.operation).toBeNull();
    expect(claim.rejected.map((operation) => operation.id)).toContain(queued.id);
    expect(
      store.getWorkspaceFileOperation(created.session.id, guest.memberToken, queued.id),
    ).toMatchObject({ status: "failed", errorCode: "workspace_read_only" });

    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );
    const revokedRead = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      { kind: "read", path: "README.md" },
    );
    store.db
      .prepare("UPDATE members SET status = 'revoked' WHERE session_id = ? AND id = ?")
      .run(created.session.id, guest.member.id);
    const revokedClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    );
    expect(revokedClaim.operation).toBeNull();
    expect(
      store.getWorkspaceFileOperation(
        created.session.id,
        created.memberToken,
        revokedRead.id,
      ),
    ).toMatchObject({ status: "failed", errorCode: "member_not_approved" });

    for (const path of ["../outside.txt", "C:\\outside.txt", ".codex/auth.json", ".env"]) {
      expect(() =>
        store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
          kind: "read",
          path,
        }),
      ).toThrow();
    }
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: "src/config.ts",
        content: "ACCESS_TOKEN=custom-super-secret-token-123456",
        expectedSha256: "a".repeat(64),
      }),
    ).toThrowError(/not available/i);

    const secretRead = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "src/leak.txt" },
    );
    const secretClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      secretRead.id,
      secretClaim.leaseId,
    );
    const secretContent = "ACCESS_TOKEN=custom-super-secret-token-123456";
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        secretRead.id,
        {
          status: "completed",
          leaseId: secretClaim.leaseId,
          file: {
            path: secretRead.path,
            content: secretContent,
            size: Buffer.byteLength(secretContent),
            modifiedAt: "2026-07-27T00:00:00.000Z",
            sha256: createHash("sha256").update(secretContent).digest("hex"),
          },
        },
      ),
    ).toThrowError(/not available/i);
    expect(
      store.db
        .prepare("SELECT result_content FROM workspace_file_operations WHERE id = ?")
        .get(secretRead.id),
    ).toEqual({ result_content: null });
  });

  it("keeps queued file operations durable across relay restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-operation-db-"));
    const filename = join(directory, "relay.sqlite");
    const first = new SessionStore(filename);
    const created = first.createSession("Durable IDE room", "Owner");
    const pairing = first.createHostPairing(created.session.id, created.memberToken, 10);
    const host = first.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(first, created.session.id, created.memberToken, host.memberToken);
    const queued = first.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "README.md" },
    );
    first.close();

    const restarted = new SessionStore(filename);
    try {
      expect(
        restarted.getWorkspaceFileOperation(
          created.session.id,
          created.memberToken,
          queued.id,
        ).status,
      ).toBe("queued");
      expect(
        restarted.claimNextWorkspaceFileOperation(
          created.session.id,
          host.memberToken,
        ).operation?.id,
      ).toBe(queued.id);
    } finally {
      restarted.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("revokes the old host and fails prior-generation operations on re-pair", () => {
    const store = createStore();
    const created = store.createSession("Re-pair room", "Owner");
    const firstPairing = store.createHostPairing(
      created.session.id,
      created.memberToken,
      10,
    );
    const firstHost = store.claimHostPairing(
      firstPairing.pairingToken,
      "Old PC",
      "Old project",
    );
    store.publishWorkspaceCatalog(created.session.id, firstHost.memberToken, {
      deviceLabel: "Old PC",
      rootLabel: "Old project",
      threads: [{ id: "thread-old", name: "Old task", preview: "", updatedAt: null }],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-old");
    store.publishWorkspaceSnapshot(created.session.id, firstHost.memberToken, {
      threadId: "thread-old",
      history: [],
      files: [
        {
          path: "old.ts",
          content: "export const oldValue = true;",
          size: 29,
          modifiedAt: "2026-07-27T00:00:00.000Z",
          sha256: createHash("sha256").update("export const oldValue = true;").digest("hex"),
        },
      ],
    });
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      {
        kind: "write",
        path: "old.ts",
        content: "export const newValue = true;",
        expectedSha256: "a".repeat(64),
      },
    );

    const secondPairing = store.createHostPairing(
      created.session.id,
      created.memberToken,
      10,
    );
    const secondHost = store.claimHostPairing(
      secondPairing.pairingToken,
      "New PC",
      "New project",
    );

    expect(
      store.getWorkspaceFileOperation(created.session.id, created.memberToken, queued.id),
    ).toMatchObject({ status: "failed", errorCode: "host_repaired" });
    expect(
      store.db
        .prepare(
          "SELECT request_content, result_content FROM workspace_file_operations WHERE id = ?",
        )
        .get(queued.id),
    ).toEqual({ request_content: null, result_content: null });
    expect(store.getWorkspace(created.session.id, created.memberToken).files).toEqual([]);
    expect(() =>
      store.claimNextWorkspaceFileOperation(created.session.id, firstHost.memberToken),
    ).toThrow();
    expect(() =>
      store.publishWorkspaceCatalog(created.session.id, firstHost.memberToken, {
        deviceLabel: "Old PC",
        rootLabel: "Old project",
        threads: [],
      }),
    ).toThrow();
    expect(() =>
      store.claimNextWorkspaceFileOperation(created.session.id, created.memberToken),
    ).toThrowError(/host token/i);
    expect(
      store.publishWorkspaceCatalog(created.session.id, secondHost.memberToken, {
        deviceLabel: "New PC",
        rootLabel: "New project",
        threads: [],
      }).rootLabel,
    ).toBe("New project");
  });

  it("rotates stale claim leases and rejects completion from the old lease", () => {
    const store = createStore();
    const created = store.createSession("Lease room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "src/value.ts" },
    );
    const firstClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.db
      .prepare("UPDATE workspace_file_operations SET started_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", queued.id);
    const secondClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    expect(secondClaim.leaseId).not.toBe(firstClaim.leaseId);
    const content = "export const value = 1;";
    const completion = {
      status: "completed" as const,
      file: {
        path: "src/value.ts",
        content,
        size: Buffer.byteLength(content),
        modifiedAt: "2026-07-27T00:00:00.000Z",
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    };
    expect(() =>
      store.completeWorkspaceFileOperation(created.session.id, host.memberToken, queued.id, {
        ...completion,
        leaseId: firstClaim.leaseId,
      }),
    ).toThrowError(/currently claimed/i);
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      queued.id,
      secondClaim.leaseId,
    );
    expect(
      store.completeWorkspaceFileOperation(created.session.id, host.memberToken, queued.id, {
        ...completion,
        leaseId: secondClaim.leaseId,
      }).status,
    ).toBe("completed");
  });

  it("expires a stalled lease without waiting for a second claimant", () => {
    const store = createStore();
    const created = store.createSession("Expired lease room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "src/stalled.ts" },
    );
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.db
      .prepare("UPDATE workspace_file_operations SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", queued.id);

    expect(() =>
      store.confirmWorkspaceFileOperationLease(
        created.session.id,
        host.memberToken,
        queued.id,
        claim.leaseId,
      ),
    ).toThrowError(/lease expired/i);
    expect(() =>
      store.completeWorkspaceFileOperation(created.session.id, host.memberToken, queued.id, {
        status: "failed",
        leaseId: claim.leaseId,
        errorCode: "test",
        errorMessage: "test",
      }),
    ).toThrowError(/not currently claimed/i);
  });

  it("rechecks member write permission when confirming and completing a lease", () => {
    const store = createStore();
    const created = store.createSession("Revoked lease room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const invite = store.createInvite(created.session.id, created.memberToken, 10, 1);
    const guest = store.joinInvite(invite.inviteToken, "Editor");
    store.approveMember(created.session.id, created.memberToken, guest.member.id);
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );
    const revokedSha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "src/revoked.ts",
      "export const previous = true;",
    );
    const queued = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      {
        kind: "write",
        path: "src/revoked.ts",
        content: "export {};",
        expectedSha256: revokedSha256,
      },
    );
    const claim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "read-only",
    );

    expect(() =>
      store.confirmWorkspaceFileOperationLease(
        created.session.id,
        host.memberToken,
        queued.id,
        claim.leaseId,
      ),
    ).toThrowError(/removed before host execution/i);
    expect(
      store.getWorkspaceFileOperation(created.session.id, created.memberToken, queued.id),
    ).toMatchObject({ status: "failed", errorCode: "workspace_read_only" });
    expect(
      store.db
        .prepare("SELECT request_content, lease_id FROM workspace_file_operations WHERE id = ?")
        .get(queued.id),
    ).toEqual({ request_content: null, lease_id: null });

    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "workspace-write",
    );
    const lateRevokedSha256 = publishIdeFile(
      store,
      created.session.id,
      host.memberToken,
      "src/late-revoked.ts",
      "export const previous = true;",
    );
    const lateRevoked = store.createWorkspaceFileOperation(
      created.session.id,
      guest.memberToken,
      {
        kind: "write",
        path: "src/late-revoked.ts",
        content: "export const value = 1;",
        expectedSha256: lateRevokedSha256,
      },
    );
    const lateClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      lateRevoked.id,
      lateClaim.leaseId,
    );
    store.updateMemberWorkspaceFileAccess(
      created.session.id,
      created.memberToken,
      guest.member.id,
      "read-only",
    );
    const lateContent = "export const value = 1;";
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        lateRevoked.id,
        {
          status: "completed",
          leaseId: lateClaim.leaseId,
          file: {
            path: lateRevoked.path,
            content: lateContent,
            size: Buffer.byteLength(lateContent),
            modifiedAt: "2026-07-27T00:00:00.000Z",
            sha256: createHash("sha256").update(lateContent).digest("hex"),
          },
        },
      ),
    ).toThrowError(/removed before host execution/i);
  });

  it("caps active operations and retains bounded result bodies and audit rows", () => {
    const store = createStore();
    const created = store.createSession("Bounded IDE room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    for (let index = 0; index < 8; index += 1) {
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "read",
        path: `src/queued-${index}.ts`,
      });
    }
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "read",
        path: "src/queued-overflow.ts",
      }),
    ).toThrowError(/wait for existing/i);
    store.db
      .prepare(
        "UPDATE workspace_file_operations SET status = 'failed', completed_at = ?, error_code = 'test', error_message = 'test' WHERE status = 'queued'",
      )
      .run("2026-07-27T00:00:00.000Z");

    const completedIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const queued = store.createWorkspaceFileOperation(
        created.session.id,
        created.memberToken,
        { kind: "read", path: `src/result-${index}.ts` },
      );
      const claim = store.claimNextWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
      ).operation!;
      store.confirmWorkspaceFileOperationLease(
        created.session.id,
        host.memberToken,
        queued.id,
        claim.leaseId,
      );
      const content = `export const value${index} = ${index};`;
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        queued.id,
        {
          status: "completed",
          leaseId: claim.leaseId,
          file: {
            path: queued.path,
            content,
            size: Buffer.byteLength(content),
            modifiedAt: new Date(Date.UTC(2026, 6, 27, 0, 0, index)).toISOString(),
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        },
      );
      completedIds.push(queued.id);
    }
    expect(
      store.listWorkspaceFileOperations(created.session.id, created.memberToken, 100)
        .filter((operation) => completedIds.includes(operation.id))
        .every((operation) => operation.resultFile === null),
    ).toBe(true);
    const cleared = store.db
      .prepare(`
        SELECT id FROM workspace_file_operations
        WHERE id IN (${completedIds.map(() => "?").join(",")})
          AND result_content IS NULL AND result_sha256 IS NOT NULL
        LIMIT 1
      `)
      .get(...completedIds) as { id: string };
    expect(
      store.getWorkspaceFileOperation(created.session.id, created.memberToken, cleared.id),
    ).toMatchObject({ resultFile: null, resultFileMetadata: { path: expect.any(String) } });
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_file_operations WHERE result_content IS NOT NULL",
        )
        .get(),
    ).toEqual({ count: 20 });

    const generation = (
      store.db
        .prepare("SELECT host_generation FROM workspace_state WHERE session_id = ?")
        .get(created.session.id) as { host_generation: string }
    ).host_generation;
    const insertTerminal = store.db.prepare(`
      INSERT INTO workspace_file_operations
        (id, session_id, requested_by_member_id, requested_by_display_name,
         host_generation, kind, path, status, requested_at, completed_at)
      VALUES (?, ?, ?, 'Owner', ?, 'read', ?, 'failed', ?, ?)
    `);
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 480; index += 1) {
        const timestamp = new Date(Date.UTC(2026, 6, 26, 0, 0, index)).toISOString();
        insertTerminal.run(
          `seed-terminal-${index}`,
          created.session.id,
          created.session.ownerMemberId,
          generation,
          `src/seed-${index}.ts`,
          timestamp,
          timestamp,
        );
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    const trigger = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      { kind: "read", path: "src/trigger.ts" },
    );
    const triggerClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      trigger.id,
      triggerClaim.leaseId,
    );
    const triggerContent = "export const trigger = true;";
    store.completeWorkspaceFileOperation(created.session.id, host.memberToken, trigger.id, {
      status: "completed",
      leaseId: triggerClaim.leaseId,
      file: {
        path: trigger.path,
        content: triggerContent,
        size: Buffer.byteLength(triggerContent),
        modifiedAt: "2026-07-27T01:00:00.000Z",
        sha256: createHash("sha256").update(triggerContent).digest("hex"),
      },
    });
    expect(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_file_operations WHERE session_id = ? AND status IN ('completed', 'failed')",
        )
        .get(created.session.id),
    ).toEqual({ count: 500 });
  });

  it("enforces workspace file count and byte caps without double-counting updates", () => {
    const store = createStore();
    const created = store.createSession("Capacity room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    selectIdeThread(store, created.session.id, created.memberToken, host.memberToken);
    const insertFile = store.db.prepare(`
      INSERT INTO workspace_files (session_id, path, size, modified_at, sha256, content)
      VALUES (?, ?, ?, '2026-07-27T00:00:00.000Z', ?, ?)
    `);
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < 600; index += 1) {
        insertFile.run(
          created.session.id,
          `src/existing-${index}.ts`,
          0,
          "a".repeat(64),
          "",
        );
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: "src/new-file.ts",
        content: "x",
        expectedSha256: "a".repeat(64),
      }),
    ).toThrowError(/already present|existing shared/i);

    const update = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      {
        kind: "write",
        path: "src/existing-0.ts",
        content: "x",
        expectedSha256: "a".repeat(64),
      },
    );
    const updateClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      update.id,
      updateClaim.leaseId,
    );
    expect(
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        update.id,
        {
          status: "completed",
          leaseId: updateClaim.leaseId,
          file: {
            path: update.path,
            content: "x",
            size: 1,
            modifiedAt: "2026-07-27T00:00:01.000Z",
            sha256: createHash("sha256").update("x").digest("hex"),
          },
        },
      ).status,
    ).toBe("completed");
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM workspace_files WHERE session_id = ?")
        .get(created.session.id),
    ).toEqual({ count: 600 });

    store.db
      .prepare("DELETE FROM workspace_files WHERE session_id = ? AND path = ?")
      .run(created.session.id, "src/existing-599.ts");
    const raced = store.createWorkspaceFileOperation(
      created.session.id,
      created.memberToken,
      {
        kind: "write",
        path: "src/existing-598.ts",
        content: "raced",
        expectedSha256: "a".repeat(64),
      },
    );
    const racedClaim = store.claimNextWorkspaceFileOperation(
      created.session.id,
      host.memberToken,
    ).operation!;
    store.confirmWorkspaceFileOperationLease(
      created.session.id,
      host.memberToken,
      raced.id,
      racedClaim.leaseId,
    );
    insertFile.run(created.session.id, "src/race-a.ts", 0, "c".repeat(64), "");
    insertFile.run(created.session.id, "src/race-b.ts", 0, "d".repeat(64), "");
    expect(() =>
      store.completeWorkspaceFileOperation(
        created.session.id,
        host.memberToken,
        raced.id,
        {
          status: "completed",
          leaseId: racedClaim.leaseId,
          file: {
            path: raced.path,
            content: "raced",
            size: 5,
            modifiedAt: "2026-07-27T00:00:02.000Z",
            sha256: createHash("sha256").update("raced").digest("hex"),
          },
        },
      ),
    ).toThrowError(/storage limit/i);

    store.db.prepare("DELETE FROM workspace_files WHERE session_id = ?").run(created.session.id);
    store.db
      .prepare(
        "UPDATE workspace_file_operations SET status = 'failed', request_content = NULL, lease_id = NULL, lease_expires_at = NULL, completed_at = ? WHERE status IN ('queued', 'processing')",
      )
      .run("2026-07-27T00:00:03.000Z");
    insertFile.run(
      created.session.id,
      "src/large.ts",
      5_000_000,
      "b".repeat(64),
      "",
    );
    expect(() =>
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: "src/another.ts",
        content: "y",
        expectedSha256: "a".repeat(64),
      }),
    ).toThrowError(/already present|existing shared/i);
    expect(
      store.createWorkspaceFileOperation(created.session.id, created.memberToken, {
        kind: "write",
        path: "src/large.ts",
        content: "smaller",
        expectedSha256: "b".repeat(64),
      }).status,
    ).toBe("queued");
  });

  it("attributes every new Codex command to the selected workspace task", () => {
    const store = createStore();
    const created = store.createSession("Task room", "Owner");
    expect(() =>
      store.addMessage(created.session.id, created.memberToken, "codex_prompt", "No task"),
    ).toThrowError(/select/i);
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [
        { id: "thread-one", name: "One", preview: "", updatedAt: null },
        { id: "thread-two", name: "Two", preview: "", updatedAt: null },
      ],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-one");
    const first = store.addMessage(
      created.session.id,
      created.memberToken,
      "codex_prompt",
      "First task",
    );
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-two");
    const second = store.addMessage(
      created.session.id,
      created.memberToken,
      "codex_stop",
      "Stop second task",
    );
    expect(first.workspaceThreadId).toBe("thread-one");
    expect(second.workspaceThreadId).toBe("thread-two");
  });

  it("imports an owner-selected Codex task and exposes it only to approved members", () => {
    const store = createStore();
    const created = store.createSession("Import room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Codex-Collab");
    const invite = store.createInvite(created.session.id, created.memberToken, 60, 1);
    const guest = store.joinInvite(invite.inviteToken, "Reviewer");

    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Codex-Collab",
      threads: [
        {
          id: "thread-1",
          name: "Release task",
          preview: "Finish the collaboration loop",
          updatedAt: 123,
        },
      ],
    });
    expect(() =>
      store.getWorkspace(created.session.id, guest.memberToken),
    ).toThrowError(/approval/i);

    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
    expect(
      store.publishCodexRuntimeStatus(
        created.session.id,
        host.memberToken,
        "running",
      ).workspace.codexRuntimeStatus,
    ).toBe("running");
    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "thread-1",
      history: [
        {
          id: "entry-1",
          role: "user",
          text: "Run the full test suite",
          createdAt: "2026-07-25T00:00:00.000Z",
        },
      ],
      files: [
        {
          path: "README.md",
          content: "# Codex Collab",
          size: 14,
          modifiedAt: "2026-07-25T00:00:00.000Z",
          sha256: createHash("sha256").update("# Codex Collab").digest("hex"),
        },
      ],
    });

    const rowBefore = store.db
      .prepare(
        "SELECT rowid FROM workspace_files WHERE session_id = ? AND path = 'README.md'",
      )
      .get(created.session.id) as { rowid: number };
    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "thread-1",
      history: [
        {
          id: "entry-1",
          role: "user",
          text: "Run the full test suite",
          createdAt: "2026-07-25T00:00:00.000Z",
        },
      ],
      files: [
        {
          path: "README.md",
          content: "# Codex Collab",
          size: 14,
          modifiedAt: "2026-07-25T00:00:00.000Z",
          sha256: createHash("sha256").update("# Codex Collab").digest("hex"),
        },
      ],
    });
    const rowAfter = store.db
      .prepare(
        "SELECT rowid FROM workspace_files WHERE session_id = ? AND path = 'README.md'",
      )
      .get(created.session.id) as { rowid: number };
    expect(rowAfter.rowid).toBe(rowBefore.rowid);

    store.approveMember(created.session.id, created.memberToken, guest.member.id);
    const workspace = store.getWorkspace(created.session.id, guest.memberToken);
    expect(workspace.selectedThread?.name).toBe("Release task");
    expect(workspace.history[0]?.text).toBe("Run the full test suite");
    expect(workspace.files[0]?.path).toBe("README.md");
    expect(workspace.threads).toEqual([]);
    expect(
      store.getWorkspaceFile(created.session.id, guest.memberToken, "README.md").content,
    ).toBe("# Codex Collab");
    expect(() =>
      store.selectWorkspaceThread(created.session.id, guest.memberToken, "thread-1"),
    ).toThrowError(/owner/i);
  });

  it("updates live task history without replacing the shared file snapshot", () => {
    const store = createStore();
    const created = store.createSession("Live room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [{ id: "thread-1", name: "Live task", preview: "", updatedAt: 1 }],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "thread-1",
      history: [],
      files: [
        {
          path: "README.md",
          content: "keep me",
          size: 7,
          modifiedAt: "2026-07-25T00:00:00.000Z",
          sha256: createHash("sha256").update("keep me").digest("hex"),
        },
      ],
    });

    const workspace = store.publishWorkspaceHistory(
      created.session.id,
      host.memberToken,
      {
        threadId: "thread-1",
        history: [
          {
            id: "call-1",
            role: "command",
            text: "tool: exec_command\nstatus: running\ninput:\nnpm test",
            createdAt: "2026-07-25T00:00:01.000Z",
          },
        ],
      },
    );

    expect(workspace.history[0]?.text).toContain("status: running");
    expect(workspace.files).toHaveLength(1);
    expect(
      store.getWorkspaceFile(
        created.session.id,
        created.memberToken,
        "README.md",
      ).content,
    ).toBe("keep me");
    expect(() =>
      store.publishWorkspaceHistory(created.session.id, host.memberToken, {
        threadId: "another-thread",
        history: [],
      }),
    ).toThrowError(/select/i);
  });

  it("clears stale imports when the owner selects another Codex task", () => {
    const store = createStore();
    const created = store.createSession("Switch room", "Owner");
    const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
    const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
    store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
      deviceLabel: "Owner PC",
      rootLabel: "Project",
      threads: [
        { id: "one", name: "One", preview: "", updatedAt: null },
        { id: "two", name: "Two", preview: "", updatedAt: null },
      ],
    });
    store.selectWorkspaceThread(created.session.id, created.memberToken, "one");
    store.publishWorkspaceSnapshot(created.session.id, host.memberToken, {
      threadId: "one",
      history: [
        { id: "old", role: "assistant", text: "Old task", createdAt: null },
      ],
      files: [],
    });

    const switched = store.selectWorkspaceThread(
      created.session.id,
      created.memberToken,
      "two",
    );
    expect(switched.history).toEqual([]);
    expect(switched.files).toEqual([]);
    expect(switched.syncedAt).toBeNull();
  });

  it("consumes passkey challenges once and keeps ceremony types isolated", () => {
    const store = createStore();
    const token = store.createAccountChallenge({
      kind: "registration",
      challenge: "challenge-value",
      accountId: "account-1",
      displayName: "Owner",
      expectedOrigin: "https://collab.example.com",
      rpId: "collab.example.com",
    });

    expect(() => store.consumeAccountChallenge(token, "authentication")).toThrowError(
      /expired|already used/i,
    );
    expect(() => store.consumeAccountChallenge(token, "registration")).toThrowError(
      /expired|already used/i,
    );
  });

  it("restores linked rooms with a bounded token and revokes it on account logout", () => {
    const store = createStore();
    const registered = store.registerAccount({
      accountId: "account-owner",
      displayName: "Owner",
      credentialId: "credential-owner",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ["internal"],
      deviceType: "multiDevice",
      backedUp: true,
    });
    const sessionIdentity = store.validateAccountWriteSession(
      registered.accountSessionToken,
      registered.csrfToken,
    );
    const created = store.createSession(
      "Persistent room",
      "Owner",
      "First browser",
      sessionIdentity,
    );
    const restored = store.restoreAccountRoom(
      registered.account.id,
      created.session.id,
      "Second browser",
      sessionIdentity.accountSessionId,
      sessionIdentity.expiresAt,
    );

    expect(store.getAccountProfile(registered.account.id).rooms[0]?.session.id).toBe(
      created.session.id,
    );
    expect(
      store.getCurrentMember(created.session.id, restored.memberToken).id,
    ).toBe(created.owner.id);
    expect(
      store.accountSessionForMemberToken(created.session.id, created.memberToken),
    ).toBe(sessionIdentity.accountSessionId);

    store.logoutAccount(registered.accountSessionToken);
    expect(() =>
      store.getCurrentMember(created.session.id, created.memberToken),
    ).toThrowError(/invalid/i);
    expect(() =>
      store.getCurrentMember(created.session.id, restored.memberToken),
    ).toThrowError(/invalid/i);
    expect(
      store.accountSessionForMemberToken(created.session.id, created.memberToken),
    ).toBeNull();

    const storedSecrets = store.db
      .prepare(`
        SELECT token_hash FROM account_sessions
        UNION ALL SELECT token_hash FROM member_tokens
      `)
      .all() as unknown as Array<{ token_hash: string }>;
    expect(storedSecrets.some((row) => row.token_hash.includes("ccs_"))).toBe(false);
    expect(storedSecrets.some((row) => row.token_hash.includes("ccm_"))).toBe(false);
  });

  it("keeps an account-linked invited member pending until owner approval", () => {
    const store = createStore();
    const owner = store.createSession("Approval room", "Owner");
    const invite = store.createInvite(owner.session.id, owner.memberToken, 60, 1);
    const guestAccount = store.registerAccount({
      accountId: "account-guest",
      displayName: "Guest",
      credentialId: "credential-guest",
      publicKey: new Uint8Array([4, 5, 6]),
      counter: 0,
      transports: ["hybrid"],
      deviceType: "multiDevice",
      backedUp: true,
    });
    const identity = store.validateAccountWriteSession(
      guestAccount.accountSessionToken,
      guestAccount.csrfToken,
    );
    const joined = store.joinInvite(
      invite.inviteToken,
      "Guest",
      "Phone",
      identity,
    );
    const restored = store.restoreAccountRoom(
      guestAccount.account.id,
      owner.session.id,
      "Laptop",
      identity.accountSessionId,
      identity.expiresAt,
    );

    expect(restored.member.status).toBe("pending");
    expect(() =>
      store.listMessages(owner.session.id, restored.memberToken),
    ).toThrowError(/approval/i);
    expect(joined.member.id).toBe(restored.member.id);

    store.logoutAccount(guestAccount.accountSessionToken);
    expect(() =>
      store.getCurrentMember(owner.session.id, joined.memberToken),
    ).toThrowError(/invalid/i);
  });

  it("keeps CSRF tokens from separate tabs valid for the same account session", () => {
    const store = createStore();
    const registered = store.registerAccount({
      accountId: "account-tabs",
      displayName: "Owner",
      credentialId: "credential-tabs",
      publicKey: new Uint8Array([7, 8, 9]),
      counter: 0,
      transports: ["internal"],
      deviceType: "multiDevice",
      backedUp: true,
    });

    const firstTab = store.refreshAccountSession(registered.accountSessionToken);
    const secondTab = store.refreshAccountSession(registered.accountSessionToken);

    expect(
      store.validateAccountWriteSession(
        registered.accountSessionToken,
        firstTab.csrfToken,
      ).account.id,
    ).toBe(registered.account.id);
    expect(
      store.validateAccountWriteSession(
        registered.accountSessionToken,
        secondTab.csrfToken,
      ).account.id,
    ).toBe(registered.account.id);

    let newestToken = secondTab.csrfToken;
    for (let index = 0; index < 40; index += 1) {
      newestToken = store.refreshAccountSession(
        registered.accountSessionToken,
      ).csrfToken;
    }
    const csrfRows = store.db
      .prepare(`
        SELECT COUNT(*) AS count FROM account_csrf_tokens
        WHERE account_session_id = ?
      `)
      .get(
        store.validateAccountWriteSession(
          registered.accountSessionToken,
          newestToken,
        ).accountSessionId,
      ) as { count: number };
    expect(csrfRows.count).toBe(32);
  });

  it("expires account-linked member tokens when the account session is idle", () => {
    const store = createStore();
    const registered = store.registerAccount({
      accountId: "account-idle",
      displayName: "Owner",
      credentialId: "credential-idle",
      publicKey: new Uint8Array([10, 11, 12]),
      counter: 0,
      transports: ["internal"],
      deviceType: "multiDevice",
      backedUp: true,
    });
    const identity = store.validateAccountWriteSession(
      registered.accountSessionToken,
      registered.csrfToken,
    );
    const created = store.createSession(
      "Idle room",
      "Owner",
      "Browser",
      identity,
    );

    store.db
      .prepare("UPDATE account_sessions SET last_used_at = ? WHERE id = ?")
      .run(
        new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
        identity.accountSessionId,
      );

    expect(() =>
      store.getCurrentMember(created.session.id, created.memberToken),
    ).toThrowError(/invalid/i);
    expect(
      store.accountSessionForMemberToken(created.session.id, created.memberToken),
    ).toBeNull();
  });
});
