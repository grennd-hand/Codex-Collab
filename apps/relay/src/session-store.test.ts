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
});
