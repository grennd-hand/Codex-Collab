import { afterEach, describe, expect, it } from "vitest";
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

  it("does not store bearer tokens in plaintext", () => {
    const store = createStore();
    const created = store.createSession("Secure room", "Owner");
    const rows = store.db.prepare("SELECT token_hash FROM members").all() as unknown as Array<{
      token_hash: string;
    }>;

    expect(rows[0]?.token_hash).not.toContain(created.memberToken);
    expect(rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
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
