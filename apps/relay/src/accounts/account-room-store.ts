import { randomUUID } from "node:crypto";
import {
  type AccountProfileResponse,
  type RestoreAccountRoomResponse,
  ProtocolError,
} from "@codex-collab/protocol";
import { hashToken, issueToken } from "../security/token.js";
import { AccountAuthStore } from "./account-auth-store.js";
import {
  type AccountRoomRow,
  type AccountSessionIdentity,
  type MemberRow,
  now,
  toMember,
} from "../storage/session-store-types.js";

export class AccountRoomStore extends AccountAuthStore {
  getAccountProfile(accountId: string): Omit<AccountProfileResponse, "csrfToken"> {
    const account = this.accountById(accountId);
    const rows = this.db
      .prepare(`
        SELECT s.id AS session_id, s.name AS session_name,
               s.owner_member_id, s.room_status, s.created_at AS session_created_at,
               m.id AS member_id, m.display_name AS member_display_name,
               m.device_label AS member_device_label, m.role AS member_role,
               m.status AS member_status,
               m.workspace_file_access AS member_workspace_file_access,
               m.created_at AS member_created_at,
               m.approved_at AS member_approved_at, am.last_used_at
        FROM account_memberships am
        JOIN sessions s ON s.id = am.session_id
        JOIN members m ON m.id = am.member_id AND m.session_id = am.session_id
        WHERE am.account_id = ?
        ORDER BY COALESCE(am.last_used_at, am.created_at) DESC
      `)
      .all(accountId) as unknown as AccountRoomRow[];
    return {
      account,
      rooms: rows.map((row) => ({
        session: {
          id: row.session_id,
          name: row.session_name,
          ownerMemberId: row.owner_member_id,
          roomStatus: row.room_status,
          createdAt: row.session_created_at,
        },
        member: {
          id: row.member_id,
          sessionId: row.session_id,
          displayName: row.member_display_name,
          deviceLabel: row.member_device_label,
          role: row.member_role,
          status: row.member_status,
          workspaceFileAccess:
            row.member_role === "owner"
              ? "workspace-write"
              : row.member_workspace_file_access,
          createdAt: row.member_created_at,
          approvedAt: row.member_approved_at,
        },
        lastUsedAt: row.last_used_at,
      })),
    };
  }

  bindAccountMembership(
    accountId: string,
    sessionId: string,
    memberToken: string,
  ): Omit<AccountProfileResponse, "csrfToken"> {
    this.accountById(accountId);
    const member = this.requireMember(sessionId, memberToken, false);
    if (member.status === "rejected" || member.status === "revoked") {
      throw new ProtocolError(
        403,
        "membership_inactive",
        "This room membership is no longer active",
      );
    }
    const owner = this.db
      .prepare("SELECT account_id FROM account_memberships WHERE member_id = ?")
      .get(member.id) as { account_id: string } | undefined;
    if (owner && owner.account_id !== accountId) {
      throw new ProtocolError(
        409,
        "membership_already_linked",
        "This room identity belongs to another account",
      );
    }
    const linkedAt = now();
    const existing = this.db
      .prepare(`
        SELECT member_id FROM account_memberships WHERE account_id = ? AND session_id = ?
      `)
      .get(accountId, sessionId) as { member_id: string } | undefined;
    if (existing && existing.member_id !== member.id) {
      throw new ProtocolError(
        409,
        "account_room_exists",
        "This account is already linked to another member in the room",
      );
    }
    this.db
      .prepare(`
        INSERT INTO account_memberships
          (account_id, session_id, member_id, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, session_id) DO UPDATE SET last_used_at = excluded.last_used_at
      `)
      .run(accountId, sessionId, member.id, linkedAt, linkedAt);
    return this.getAccountProfile(accountId);
  }

  restoreAccountRoom(
    accountId: string,
    sessionId: string,
    deviceLabel: string,
    accountSessionId: string,
    accountSessionExpiresAt: string,
  ): RestoreAccountRoomResponse {
    const row = this.db
      .prepare(`
        SELECT m.id, m.session_id, m.display_name, m.device_label, m.role,
               m.status, m.workspace_file_access, m.created_at, m.approved_at
        FROM account_memberships am
        JOIN members m ON m.id = am.member_id AND m.session_id = am.session_id
        WHERE am.account_id = ? AND am.session_id = ?
      `)
      .get(accountId, sessionId) as MemberRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "membership_not_found", "Room membership was not found");
    }
    if (row.status === "rejected" || row.status === "revoked") {
      throw new ProtocolError(
        403,
        "membership_inactive",
        "This room membership is no longer active",
      );
    }
    const memberToken = issueToken("ccm");
    const restoredAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO member_tokens
            (id, session_id, member_id, token_hash, device_label, created_at,
             account_session_id, expires_at, revoked_at, token_purpose)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'account')
        `)
        .run(
          randomUUID(),
          sessionId,
          row.id,
          hashToken(memberToken),
          deviceLabel,
          restoredAt,
          accountSessionId,
          accountSessionExpiresAt,
        );
      this.db
        .prepare(`
          UPDATE account_memberships SET last_used_at = ?
          WHERE account_id = ? AND session_id = ?
        `)
        .run(restoredAt, accountId, sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      session: this.getSession(sessionId),
      member: toMember(row),
      memberToken,
    };
  }


  protected insertAccountMemberToken(
    sessionId: string,
    memberId: string,
    memberToken: string,
    deviceLabel: string | undefined,
    createdAt: string,
    accountIdentity: AccountSessionIdentity,
  ): void {
    this.db
      .prepare(`
        INSERT INTO member_tokens
          (id, session_id, member_id, token_hash, device_label, created_at,
           account_session_id, expires_at, revoked_at, token_purpose)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'account')
      `)
      .run(
        randomUUID(),
        sessionId,
        memberId,
        hashToken(memberToken),
        deviceLabel?.trim() || "Account device",
        createdAt,
        accountIdentity.accountSessionId,
        accountIdentity.expiresAt,
      );
  }

}

