import { DatabaseSync } from "node:sqlite";
import {
  type Member,
  type RoomStatus,
  type Session,
  ProtocolError,
} from "@codex-collab/protocol";
import { hashToken } from "../security/token.js";
import { migrateSessionStore } from "./sqlite-migrations.js";
import {
  type MemberRow,
  type SessionRow,
  now,
  toMember,
  toSession,
} from "./session-store-types.js";

export class SqliteSessionStore {
  readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    migrateSessionStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  getSession(sessionId: string): Session {
    const row = this.db
      .prepare(
        "SELECT id, name, owner_member_id, room_status, created_at FROM sessions WHERE id = ?",
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "session_not_found", "Session was not found");
    }
    return toSession(row);
  }

  authenticateRealtime(sessionId: string, memberToken: string): Member {
    return this.requireMember(sessionId, memberToken, true);
  }

  accountSessionForMemberToken(
    sessionId: string,
    memberToken: string,
  ): string | null {
    const usedAt = now();
    const idleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const row = this.db
      .prepare(`
        SELECT mt.account_session_id
        FROM member_tokens mt
        JOIN account_sessions account_session ON account_session.id = mt.account_session_id
        WHERE mt.session_id = ? AND mt.token_hash = ?
          AND mt.account_session_id IS NOT NULL
          AND mt.revoked_at IS NULL
          AND (mt.expires_at IS NULL OR mt.expires_at > ?)
          AND account_session.revoked_at IS NULL
          AND account_session.last_used_at > ?
          AND account_session.expires_at > ?
      `)
      .get(sessionId, hashToken(memberToken), usedAt, idleCutoff, usedAt) as
      | { account_session_id: string }
      | undefined;
    return row?.account_session_id ?? null;
  }

  protected memberById(sessionId: string, memberId: string): Member {
    const row = this.db
      .prepare(`
        SELECT id, session_id, display_name, device_label, role, status,
               workspace_file_access, created_at, approved_at
        FROM members WHERE session_id = ? AND id = ?
      `)
      .get(sessionId, memberId) as MemberRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "member_not_found", "Member was not found");
    }
    return toMember(row);
  }

  protected requireMember(
    sessionId: string,
    memberToken: string,
    requireApproved: boolean,
  ): Member {
    const tokenHash = hashToken(memberToken);
    const usedAt = now();
    const idleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const row = this.db
      .prepare(`
        SELECT members.id, members.session_id, members.display_name,
               members.device_label, members.role, members.status,
               members.workspace_file_access, members.created_at, members.approved_at,
               member_token.account_session_id
        FROM members
        LEFT JOIN member_tokens member_token
          ON member_token.session_id = members.session_id
          AND member_token.member_id = members.id
          AND member_token.token_hash = ?
        LEFT JOIN account_sessions account_session
          ON account_session.id = member_token.account_session_id
        WHERE members.session_id = ?
          AND (
            members.token_hash = ?
            OR (
              member_token.token_hash IS NOT NULL
              AND member_token.revoked_at IS NULL
              AND (member_token.expires_at IS NULL OR member_token.expires_at > ?)
              AND (
                member_token.account_session_id IS NULL
                OR (
                  account_session.revoked_at IS NULL
                  AND account_session.last_used_at > ?
                  AND account_session.expires_at > ?
                )
              )
            )
          )
      `)
      .get(
        tokenHash,
        sessionId,
        tokenHash,
        usedAt,
        idleCutoff,
        usedAt,
      ) as (MemberRow & { account_session_id: string | null }) | undefined;
    if (!row) {
      throw new ProtocolError(401, "unauthorized", "Member token is invalid");
    }
    if (row.account_session_id) {
      this.db
        .prepare("UPDATE account_sessions SET last_used_at = ? WHERE id = ?")
        .run(usedAt, row.account_session_id);
    }
    if (requireApproved && row.status !== "approved") {
      throw new ProtocolError(403, "member_not_approved", "Owner approval is required");
    }
    return toMember(row);
  }

  protected requireOwner(sessionId: string, memberToken: string): Member {
    if (memberToken.startsWith("cch_")) {
      throw new ProtocolError(
        403,
        "browser_owner_required",
        "Use the owner browser session for room administration",
      );
    }
    const member = this.requireMember(sessionId, memberToken, true);
    if (member.role !== "owner") {
      throw new ProtocolError(403, "owner_required", "Only the owner can manage the host workspace");
    }
    return member;
  }

  protected requireBrowserMember(
    sessionId: string,
    memberToken: string,
    requireApproved: boolean,
  ): Member {
    if (memberToken.startsWith("cch_")) {
      throw new ProtocolError(
        403,
        "browser_member_required",
        "Use a browser member session for collaboration editor access",
      );
    }
    return this.requireMember(sessionId, memberToken, requireApproved);
  }

  protected requireRoomOpen(sessionId: string): void {
    const row = this.db
      .prepare("SELECT room_status FROM sessions WHERE id = ?")
      .get(sessionId) as { room_status: RoomStatus } | undefined;
    if (!row) {
      throw new ProtocolError(404, "session_not_found", "Session was not found");
    }
    if (row.room_status === "closed") {
      throw new ProtocolError(409, "room_closed", "This room is closed");
    }
  }

  protected selectedWorkspaceThreadId(sessionId: string): string | null {
    const row = this.db
      .prepare("SELECT selected_thread_id FROM workspace_state WHERE session_id = ?")
      .get(sessionId) as { selected_thread_id: string | null } | undefined;
    return row?.selected_thread_id ?? null;
  }

  protected requireCurrentHost(
    sessionId: string,
    memberToken: string,
  ): { tokenId: string; generation: string } {
    if (!memberToken.startsWith("cch_")) {
      throw new ProtocolError(
        403,
        "host_token_required",
        "Use the currently paired Codex host token for workspace processing",
      );
    }
    const owner = this.requireMember(sessionId, memberToken, true);
    if (owner.role !== "owner") {
      throw new ProtocolError(403, "owner_required", "Only the owner host can publish a workspace");
    }
    const state = this.db
      .prepare("SELECT host_token_id, host_generation FROM workspace_state WHERE session_id = ?")
      .get(sessionId) as
      | { host_token_id: string | null; host_generation: string | null }
      | undefined;
    if (!state?.host_token_id || !state.host_generation) {
      throw new ProtocolError(
        409,
        "host_repair_required",
        "Pair this Codex host again before publishing or processing workspace data",
      );
    }
    const token = this.db
      .prepare(`
        SELECT id FROM member_tokens
        WHERE session_id = ? AND member_id = ? AND token_hash = ?
          AND revoked_at IS NULL AND token_purpose = 'host'
      `)
      .get(sessionId, owner.id, hashToken(memberToken)) as { id: string } | undefined;
    if (token?.id !== state.host_token_id) {
      throw new ProtocolError(
        403,
        "current_host_required",
        "Only the currently paired host can publish or process workspace data",
      );
    }
    return { tokenId: token.id, generation: state.host_generation };
  }

}
