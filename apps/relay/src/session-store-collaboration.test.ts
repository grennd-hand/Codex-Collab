import { describe, expect, it } from "vitest";
import { createStore } from "./session-store-test-support.js";

describe("SessionStore collaboration and messages", () => {
  it("configures SQLite to wait briefly for concurrent writers", () => {
    const store = createStore();
    const pragma = store.db.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };

    expect(pragma.timeout).toBe(5_000);
  });

  it("issues a reusable owner recovery key while storing only its hash", () => {
    const store = createStore();
    const created = store.createSession("Reusable room", "Owner", "First browser");
    const stored = store.db
      .prepare("SELECT owner_recovery_hash FROM sessions WHERE id = ?")
      .get(created.session.id) as { owner_recovery_hash: string };

    expect(created.recoveryKey).toMatch(/^ccr_[A-Za-z0-9_-]+$/);
    expect(stored.owner_recovery_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.owner_recovery_hash).not.toContain(created.recoveryKey);

    const first = store.recoverSession(
      created.session.id,
      created.recoveryKey,
      "Second browser",
    );
    const second = store.recoverSession(
      created.session.id,
      created.recoveryKey,
      "Third browser",
    );

    expect(first.session).toEqual(created.session);
    expect(first.owner).toEqual(created.owner);
    expect(first.memberToken).not.toBe(created.memberToken);
    expect(second.memberToken).not.toBe(first.memberToken);
    expect(store.getCurrentMember(created.session.id, first.memberToken).role).toBe("owner");
    expect(store.getCurrentMember(created.session.id, second.memberToken).role).toBe("owner");
  });

  it("uses the same recovery failure for an unknown room and a wrong key", () => {
    const store = createStore();
    const created = store.createSession("Protected room", "Owner");

    expect(() => store.recoverSession(created.session.id, "ccr_wrong")).toThrowError(
      /room id or owner recovery key is invalid/i,
    );
    expect(() => store.recoverSession("missing-room", created.recoveryKey)).toThrowError(
      /room id or owner recovery key is invalid/i,
    );
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
    expect(approved.workspaceFileAccess).toBe("workspace-write");
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

});
