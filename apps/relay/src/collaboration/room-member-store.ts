import { randomUUID } from "node:crypto";
import {
  type CreateSessionResponse,
  type JoinInviteResponse,
  type Member,
  type RecoverSessionResponse,
  type RoomStatus,
  type Session,
  type WorkspaceFileAccess,
  ProtocolError,
} from "@codex-collab/protocol";
import { hashToken, issueToken } from "../token.js";
import { AccountRoomStore } from "../accounts/account-room-store.js";
import {
  type AccountSessionIdentity,
  type InviteRow,
  type MemberRow,
  now,
  toMember,
} from "../storage/session-store-types.js";

export class RoomMemberStore extends AccountRoomStore {
  createSession(
    name: string,
    ownerDisplayName: string,
    deviceLabel?: string,
    accountIdentity?: AccountSessionIdentity,
  ): CreateSessionResponse {
    const sessionId = randomUUID();
    const ownerId = randomUUID();
    const memberToken = issueToken("ccm");
    const recoveryKey = issueToken("ccr");
    const createdAt = now();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO sessions
            (id, name, owner_member_id, owner_recovery_hash, room_status, created_at)
           VALUES (?, ?, ?, ?, 'open', ?)`,
        )
        .run(sessionId, name, ownerId, hashToken(recoveryKey), createdAt);
      this.db
        .prepare(`
          INSERT INTO members
            (id, session_id, display_name, device_label, role, status,
             workspace_file_access, token_hash, created_at, approved_at)
          VALUES (?, ?, ?, ?, 'owner', 'approved', 'workspace-write', ?, ?, ?)
        `)
        .run(
          ownerId,
          sessionId,
          ownerDisplayName,
          deviceLabel ?? null,
          hashToken(accountIdentity ? issueToken("ccm") : memberToken),
          createdAt,
          createdAt,
        );
      if (accountIdentity) {
        this.insertAccountMemberToken(
          sessionId,
          ownerId,
          memberToken,
          deviceLabel,
          createdAt,
          accountIdentity,
        );
        this.db
          .prepare(`
            INSERT INTO account_memberships
              (account_id, session_id, member_id, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?)
          `)
          .run(
            accountIdentity.account.id,
            sessionId,
            ownerId,
            createdAt,
            createdAt,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      session: {
        id: sessionId,
        name,
        ownerMemberId: ownerId,
        roomStatus: "open",
        createdAt,
      },
      owner: {
        id: ownerId,
        sessionId,
        displayName: ownerDisplayName,
        deviceLabel: deviceLabel ?? null,
        role: "owner",
        status: "approved",
        workspaceFileAccess: "workspace-write",
        createdAt,
        approvedAt: createdAt,
      },
      memberToken,
      recoveryKey,
    };
  }

  recoverSession(
    sessionId: string,
    recoveryKey: string,
    deviceLabel = "Web device",
  ): RecoverSessionResponse {
    const row = this.db
      .prepare(`
        SELECT id, name, owner_member_id, room_status, created_at
        FROM sessions
        WHERE id = ? AND owner_recovery_hash = ?
      `)
      .get(sessionId, hashToken(recoveryKey)) as
      | {
          id: string;
          name: string;
          owner_member_id: string;
          room_status: RoomStatus;
          created_at: string;
        }
      | undefined;
    if (!row) {
      throw new ProtocolError(
        401,
        "recovery_failed",
        "Room ID or owner recovery key is invalid",
      );
    }

    const owner = this.memberById(row.id, row.owner_member_id);
    const memberToken = issueToken("ccm");
    this.db
      .prepare(`
        INSERT INTO member_tokens
          (id, session_id, member_id, token_hash, device_label, created_at,
           account_session_id, expires_at, revoked_at, token_purpose)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'recovery')
      `)
      .run(
        randomUUID(),
        row.id,
        owner.id,
        hashToken(memberToken),
        deviceLabel.trim() || "Web device",
        now(),
      );

    return {
      session: {
        id: row.id,
        name: row.name,
        ownerMemberId: row.owner_member_id,
        roomStatus: row.room_status,
        createdAt: row.created_at,
      },
      owner,
      memberToken,
    };
  }

  createInvite(
    sessionId: string,
    memberToken: string,
    expiresInMinutes: number,
    maxUses: number,
  ): { inviteToken: string; expiresAt: string } {
    const owner = this.requireOwner(sessionId, memberToken);
    this.requireRoomOpen(sessionId);

    const inviteToken = issueToken("cci");
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString();
    this.db
      .prepare(`
        INSERT INTO invites
          (id, session_id, token_hash, created_by_member_id, created_at, expires_at, max_uses, uses)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `)
      .run(
        randomUUID(),
        sessionId,
        hashToken(inviteToken),
        owner.id,
        now(),
        expiresAt,
        maxUses,
      );
    return { inviteToken, expiresAt };
  }

  joinInvite(
    inviteToken: string,
    displayName: string,
    deviceLabel?: string,
    accountIdentity?: AccountSessionIdentity,
  ): JoinInviteResponse {
    const invite = this.db
      .prepare(`
        SELECT i.id, i.session_id, i.expires_at, i.max_uses, i.uses,
               s.room_status
        FROM invites i
        JOIN sessions s ON s.id = i.session_id
        WHERE i.token_hash = ?
      `)
      .get(hashToken(inviteToken)) as InviteRow | undefined;

    if (!invite) {
      throw new ProtocolError(404, "invite_not_found", "Invitation is invalid");
    }
    if (invite.room_status === "closed") {
      throw new ProtocolError(409, "room_closed", "This room is closed");
    }
    if (Date.parse(invite.expires_at) <= Date.now()) {
      throw new ProtocolError(410, "invite_expired", "Invitation has expired");
    }
    if (invite.uses >= invite.max_uses) {
      throw new ProtocolError(410, "invite_exhausted", "Invitation has already been used");
    }
    if (
      accountIdentity &&
      this.db
        .prepare(
          "SELECT 1 AS present FROM account_memberships WHERE account_id = ? AND session_id = ?",
        )
        .get(accountIdentity.account.id, invite.session_id)
    ) {
      throw new ProtocolError(
        409,
        "account_room_exists",
        "This account already belongs to the room",
      );
    }

    const memberToken = issueToken("ccm");
    const memberId = randomUUID();
    const createdAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO members
            (id, session_id, display_name, device_label, role, status,
             workspace_file_access, token_hash, created_at, approved_at)
          VALUES (?, ?, ?, ?, 'editor', 'pending', 'read-only', ?, ?, NULL)
        `)
        .run(
          memberId,
          invite.session_id,
          displayName,
          deviceLabel ?? null,
          hashToken(accountIdentity ? issueToken("ccm") : memberToken),
          createdAt,
        );
      this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE id = ?").run(invite.id);
      if (accountIdentity) {
        this.insertAccountMemberToken(
          invite.session_id,
          memberId,
          memberToken,
          deviceLabel,
          createdAt,
          accountIdentity,
        );
        this.db
          .prepare(`
            INSERT INTO account_memberships
              (account_id, session_id, member_id, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?)
          `)
          .run(
            accountIdentity.account.id,
            invite.session_id,
            memberId,
            createdAt,
            createdAt,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const session = this.getSession(invite.session_id);
    return {
      session,
      member: {
        id: memberId,
        sessionId: invite.session_id,
        displayName,
        deviceLabel: deviceLabel ?? null,
        role: "editor",
        status: "pending",
        workspaceFileAccess: "read-only",
        createdAt,
        approvedAt: null,
      },
      memberToken,
    };
  }


  updateRoomStatus(
    sessionId: string,
    memberToken: string,
    roomStatus: RoomStatus,
  ): Session {
    this.requireOwner(sessionId, memberToken);
    this.db
      .prepare("UPDATE sessions SET room_status = ? WHERE id = ?")
      .run(roomStatus, sessionId);
    return this.getSession(sessionId);
  }

  getCurrentMember(sessionId: string, memberToken: string): Member {
    return this.requireMember(sessionId, memberToken, false);
  }

  listMembers(sessionId: string, memberToken: string): Member[] {
    this.requireMember(sessionId, memberToken, true);
    const rows = this.db
      .prepare(`
        SELECT id, session_id, display_name, device_label, role, status,
               workspace_file_access, created_at, approved_at
        FROM members WHERE session_id = ? ORDER BY created_at ASC
      `)
      .all(sessionId) as unknown as MemberRow[];
    return rows.map(toMember);
  }

  approveMember(sessionId: string, memberToken: string, targetMemberId: string): Member {
    this.requireOwner(sessionId, memberToken);
    const approvedAt = now();
    const result = this.db
      .prepare(`
        UPDATE members SET status = 'approved', approved_at = ?
        WHERE id = ? AND session_id = ? AND status = 'pending'
      `)
      .run(approvedAt, targetMemberId, sessionId);
    if (result.changes !== 1) {
      throw new ProtocolError(404, "pending_member_not_found", "Pending member was not found");
    }
    return this.memberById(sessionId, targetMemberId);
  }

  updateMemberWorkspaceFileAccess(
    sessionId: string,
    memberToken: string,
    targetMemberId: string,
    workspaceFileAccess: WorkspaceFileAccess,
  ): Member {
    this.requireOwner(sessionId, memberToken);
    const target = this.memberById(sessionId, targetMemberId);
    if (target.role === "owner") {
      throw new ProtocolError(
        400,
        "owner_workspace_access_required",
        "The owner always retains workspace write access",
      );
    }
    this.db
      .prepare(`
        UPDATE members SET workspace_file_access = ?
        WHERE session_id = ? AND id = ?
      `)
      .run(workspaceFileAccess, sessionId, targetMemberId);
    return this.memberById(sessionId, targetMemberId);
  }

}
