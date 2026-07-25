import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "./session-store.js";

const stores: SessionStore[] = [];

function createStore(): SessionStore {
  const store = new SessionStore();
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

describe("SessionStore", () => {
  it("requires owner approval before an invited member can collaborate", () => {
    const store = createStore();
    const created = store.createSession("Launch room", "Owner");
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
          accessMode: "full-access",
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
      INSERT INTO sessions VALUES ('session-1', 'Room', 'owner-1', '2026-07-25T00:00:00.000Z');
      INSERT INTO members VALUES (
        'owner-1', 'session-1', 'Owner', NULL, 'owner', 'approved',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z'
      );
      INSERT INTO messages VALUES (
        'message-1', 'session-1', 'owner-1', 'codex_prompt', 'Run',
        NULL, 'submitted', '2026-07-25T00:00:00.000Z'
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
          "SELECT delivery_status, codex_turn_id, completed_at FROM messages WHERE id = ?",
        )
        .get("message-1") as
        | {
            delivery_status: string;
            codex_turn_id: string | null;
            completed_at: string | null;
          }
        | undefined;
      const attachment = migrated.db
        .prepare("SELECT content FROM message_attachments WHERE id = ?")
        .get("attachment-1") as { content: Uint8Array } | undefined;

      expect(message).toEqual({
        delivery_status: "submitted",
        codex_turn_id: null,
        completed_at: null,
      });
      expect(new TextDecoder().decode(attachment?.content)).toBe("body");
      expect(
        (
          migrated.db
            .prepare("SELECT room_status FROM sessions WHERE id = ?")
            .get("session-1") as { room_status: string }
        ).room_status,
      ).toBe("open");
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
          sha256: "a".repeat(64),
        },
      ],
    });

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
});
