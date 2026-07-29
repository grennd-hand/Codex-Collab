import { randomUUID } from "node:crypto";
import { type Account, ProtocolError } from "@codex-collab/protocol";
import { hashToken, issueToken } from "../security/token.js";
import { SqliteSessionStore } from "../storage/sqlite-session-store.js";
import {
  type AccountChallenge,
  type AccountChallengeRow,
  type AccountCredentialRow,
  type AccountRow,
  type AccountSessionIdentity,
  type StoredAccountCredential,
  now,
  toAccount,
} from "../storage/session-store-types.js";

export class AccountAuthStore extends SqliteSessionStore {
  createAccountChallenge(input: {
    kind: "registration" | "authentication";
    challenge: string;
    expectedOrigin: string;
    rpId: string;
    accountId?: string;
    displayName?: string;
  }): string {
    const ceremonyToken = issueToken("cca");
    const createdAt = now();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.db
      .prepare("DELETE FROM account_challenges WHERE expires_at <= ?")
      .run(createdAt);
    this.db
      .prepare(`
        INSERT INTO account_challenges
          (token_hash, kind, challenge, account_id, display_name,
           expected_origin, rp_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        hashToken(ceremonyToken),
        input.kind,
        input.challenge,
        input.accountId ?? null,
        input.displayName ?? null,
        input.expectedOrigin,
        input.rpId,
        createdAt,
        expiresAt,
      );
    return ceremonyToken;
  }

  consumeAccountChallenge(
    ceremonyToken: string,
    expectedKind: "registration" | "authentication",
  ): AccountChallenge {
    const tokenHash = hashToken(ceremonyToken);
    this.db.exec("BEGIN IMMEDIATE");
    let row: AccountChallengeRow | undefined;
    try {
      row = this.db
        .prepare(`
          SELECT kind, challenge, account_id, display_name, expected_origin, rp_id, expires_at
          FROM account_challenges WHERE token_hash = ?
        `)
        .get(tokenHash) as AccountChallengeRow | undefined;
      this.db
        .prepare("DELETE FROM account_challenges WHERE token_hash = ?")
        .run(tokenHash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (!row || row.kind !== expectedKind || Date.parse(row.expires_at) <= Date.now()) {
      throw new ProtocolError(
        400,
        "passkey_challenge_invalid",
        "The passkey request expired or was already used",
      );
    }
    return {
      kind: row.kind,
      challenge: row.challenge,
      accountId: row.account_id,
      displayName: row.display_name,
      expectedOrigin: row.expected_origin,
      rpId: row.rp_id,
    };
  }

  registerAccount(input: {
    accountId: string;
    displayName: string;
    credentialId: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
    deviceType: string;
    backedUp: boolean;
  }): { account: Account; accountSessionToken: string; csrfToken: string } {
    if (
      this.db
        .prepare("SELECT 1 AS present FROM account_credentials WHERE id = ?")
        .get(input.credentialId)
    ) {
      throw new ProtocolError(
        409,
        "passkey_already_registered",
        "This passkey is already registered",
      );
    }
    const createdAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO accounts (id, display_name, created_at) VALUES (?, ?, ?)")
        .run(input.accountId, input.displayName, createdAt);
      this.db
        .prepare(`
          INSERT INTO account_credentials
            (id, account_id, public_key, counter, transports_json, device_type,
             backed_up, created_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.credentialId,
          input.accountId,
          Buffer.from(input.publicKey),
          input.counter,
          JSON.stringify(input.transports),
          input.deviceType,
          input.backedUp ? 1 : 0,
          createdAt,
          createdAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const accountSession = this.createAccountSession(input.accountId);
    return {
      account: {
        id: input.accountId,
        displayName: input.displayName,
        createdAt,
      },
      ...accountSession,
    };
  }

  getAccountCredential(credentialId: string): StoredAccountCredential {
    const row = this.db
      .prepare(`
        SELECT id, account_id, public_key, counter, transports_json
        FROM account_credentials WHERE id = ?
      `)
      .get(credentialId) as AccountCredentialRow | undefined;
    if (!row) {
      throw new ProtocolError(401, "passkey_unknown", "Passkey was not recognized");
    }
    return {
      id: row.id,
      accountId: row.account_id,
      publicKey: new Uint8Array(row.public_key),
      counter: row.counter,
      transports: JSON.parse(row.transports_json) as string[],
    };
  }

  authenticateAccountCredential(
    credentialId: string,
    expectedCounter: number,
    newCounter: number,
    deviceType: string,
    backedUp: boolean,
  ): { account: Account; accountSessionToken: string; csrfToken: string } {
    const credential = this.getAccountCredential(credentialId);
    const usedAt = now();
    const updated = this.db
      .prepare(`
        UPDATE account_credentials
        SET counter = ?, device_type = ?, backed_up = ?, last_used_at = ?
        WHERE id = ? AND counter = ?
      `)
      .run(
        newCounter,
        deviceType,
        backedUp ? 1 : 0,
        usedAt,
        credentialId,
        expectedCounter,
      );
    if (updated.changes !== 1) {
      throw new ProtocolError(
        409,
        "passkey_state_changed",
        "Passkey state changed; please try signing in again",
      );
    }
    return {
      account: this.accountById(credential.accountId),
      ...this.createAccountSession(credential.accountId),
    };
  }

  accountFromSessionToken(accountSessionToken: string): Account {
    return this.accountSessionIdentity(accountSessionToken).account;
  }

  protected accountSessionIdentity(
    accountSessionToken: string,
  ): AccountSessionIdentity {
    const usedAt = now();
    const idleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const row = this.db
      .prepare(`
        SELECT a.id, a.display_name, a.created_at,
               s.id AS account_session_id, s.expires_at
        FROM account_sessions s
        JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = ?
          AND s.revoked_at IS NULL AND s.last_used_at > ? AND s.expires_at > ?
      `)
      .get(
        hashToken(accountSessionToken),
        idleCutoff,
        usedAt,
      ) as
      | (AccountRow & { account_session_id: string; expires_at: string })
      | undefined;
    if (!row) {
      throw new ProtocolError(401, "account_required", "Account sign-in is required");
    }
    this.db
      .prepare("UPDATE account_sessions SET last_used_at = ? WHERE token_hash = ?")
      .run(usedAt, hashToken(accountSessionToken));
    return {
      account: toAccount(row),
      accountSessionId: row.account_session_id,
      expiresAt: row.expires_at,
    };
  }

  refreshAccountSession(accountSessionToken: string): {
    account: Account;
    csrfToken: string;
  } {
    const identity = this.accountSessionIdentity(accountSessionToken);
    const csrfToken = issueToken("ccs");
    const createdAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM account_csrf_tokens WHERE expires_at <= ?")
        .run(createdAt);
      this.db
        .prepare(`
          INSERT INTO account_csrf_tokens
            (token_hash, account_session_id, created_at, expires_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          hashToken(csrfToken),
          identity.accountSessionId,
          createdAt,
          identity.expiresAt,
        );
      this.db
        .prepare(`
          DELETE FROM account_csrf_tokens
          WHERE account_session_id = ?
            AND rowid NOT IN (
              SELECT rowid FROM account_csrf_tokens
              WHERE account_session_id = ?
              ORDER BY created_at DESC, rowid DESC
              LIMIT 32
            )
        `)
        .run(identity.accountSessionId, identity.accountSessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { account: identity.account, csrfToken };
  }

  validateAccountWriteSession(
    accountSessionToken: string,
    csrfToken: string,
  ): AccountSessionIdentity {
    try {
      const identity = this.accountSessionIdentity(accountSessionToken);
      const csrfHash = hashToken(csrfToken);
      const csrf = this.db
        .prepare(`
          SELECT 1 AS present
          FROM account_csrf_tokens
          WHERE account_session_id = ? AND token_hash = ? AND expires_at > ?
          UNION ALL
          SELECT 1 AS present
          FROM account_sessions
          WHERE id = ? AND csrf_token_hash = ?
          LIMIT 1
        `)
        .get(
          identity.accountSessionId,
          csrfHash,
          now(),
          identity.accountSessionId,
          csrfHash,
        );
      if (!csrf) {
        throw new ProtocolError(
          403,
          "account_csrf_invalid",
          "Account request could not be verified",
        );
      }
      return identity;
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw new ProtocolError(
          403,
          "account_csrf_invalid",
          "Account request could not be verified",
        );
      }
      throw error;
    }
  }

  logoutAccount(accountSessionToken: string): void {
    const revokedAt = now();
    const tokenHash = hashToken(accountSessionToken);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT id FROM account_sessions WHERE token_hash = ?")
        .get(tokenHash) as { id: string } | undefined;
      this.db
        .prepare("UPDATE account_sessions SET revoked_at = ? WHERE token_hash = ?")
        .run(revokedAt, tokenHash);
      if (row) {
        this.db
          .prepare(`
            UPDATE member_tokens SET revoked_at = ?
            WHERE account_session_id = ? AND revoked_at IS NULL
          `)
          .run(revokedAt, row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }


  protected accountById(accountId: string): Account {
    const row = this.db
      .prepare("SELECT id, display_name, created_at FROM accounts WHERE id = ?")
      .get(accountId) as AccountRow | undefined;
    if (!row) {
      throw new ProtocolError(401, "account_required", "Account sign-in is required");
    }
    return toAccount(row);
  }

  protected createAccountSession(accountId: string): {
    accountSessionToken: string;
    csrfToken: string;
  } {
    const accountSessionToken = issueToken("ccs");
    const csrfToken = issueToken("ccs");
    const accountSessionId = randomUUID();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO account_sessions
            (id, account_id, token_hash, csrf_token_hash, created_at,
             expires_at, last_used_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `)
        .run(
          accountSessionId,
          accountId,
          hashToken(accountSessionToken),
          hashToken(csrfToken),
          createdAt,
          expiresAt,
          createdAt,
        );
      this.db
        .prepare(`
          INSERT INTO account_csrf_tokens
            (token_hash, account_session_id, created_at, expires_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(hashToken(csrfToken), accountSessionId, createdAt, expiresAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { accountSessionToken, csrfToken };
  }

}

