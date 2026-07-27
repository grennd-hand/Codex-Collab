import { describe, expect, it } from "vitest";
import { createStore } from "./session-store-test-support.js";

describe("SessionStore account sessions", () => {
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
