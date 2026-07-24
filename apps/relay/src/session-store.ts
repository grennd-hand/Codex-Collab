import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  type CreateSessionResponse,
  type JoinInviteResponse,
  type Member,
  type MemberStatus,
  type Message,
  type MessageKind,
  type Session,
  ProtocolError,
} from "@codex-collab/protocol";
import { hashToken, issueToken } from "./token.js";

interface MemberRow {
  id: string;
  session_id: string;
  display_name: string;
  device_label: string | null;
  role: "owner" | "editor";
  status: MemberStatus;
  created_at: string;
  approved_at: string | null;
}

interface SessionRow {
  id: string;
  name: string;
  owner_member_id: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  sender_member_id: string;
  sender_display_name: string;
  kind: MessageKind;
  body: string;
  created_at: string;
}

interface InviteRow {
  id: string;
  session_id: string;
  expires_at: string;
  max_uses: number;
  uses: number;
}

function now(): string {
  return new Date().toISOString();
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    ownerMemberId: row.owner_member_id,
    createdAt: row.created_at,
  };
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    sessionId: row.session_id,
    displayName: row.display_name,
    deviceLabel: row.device_label,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    senderMemberId: row.sender_member_id,
    senderDisplayName: row.sender_display_name,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
  };
}

export class SessionStore {
  readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_member_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        device_label TEXT,
        role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        approved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_member_id TEXT NOT NULL REFERENCES members(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_uses INTEGER NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sender_member_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'codex_prompt', 'system')),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS members_session_idx ON members(session_id);
      CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages(session_id, created_at);
    `);
  }

  createSession(name: string, ownerDisplayName: string, deviceLabel?: string): CreateSessionResponse {
    const sessionId = randomUUID();
    const ownerId = randomUUID();
    const memberToken = issueToken("ccm");
    const createdAt = now();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO sessions (id, name, owner_member_id, created_at) VALUES (?, ?, ?, ?)")
        .run(sessionId, name, ownerId, createdAt);
      this.db
        .prepare(`
          INSERT INTO members
            (id, session_id, display_name, device_label, role, status, token_hash, created_at, approved_at)
          VALUES (?, ?, ?, ?, 'owner', 'approved', ?, ?, ?)
        `)
        .run(
          ownerId,
          sessionId,
          ownerDisplayName,
          deviceLabel ?? null,
          hashToken(memberToken),
          createdAt,
          createdAt,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      session: { id: sessionId, name, ownerMemberId: ownerId, createdAt },
      owner: {
        id: ownerId,
        sessionId,
        displayName: ownerDisplayName,
        deviceLabel: deviceLabel ?? null,
        role: "owner",
        status: "approved",
        createdAt,
        approvedAt: createdAt,
      },
      memberToken,
    };
  }

  createInvite(
    sessionId: string,
    memberToken: string,
    expiresInMinutes: number,
    maxUses: number,
  ): { inviteToken: string; expiresAt: string } {
    const owner = this.requireMember(sessionId, memberToken, true);
    if (owner.role !== "owner") {
      throw new ProtocolError(403, "owner_required", "Only the owner can create invitations");
    }

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

  joinInvite(inviteToken: string, displayName: string, deviceLabel?: string): JoinInviteResponse {
    const invite = this.db
      .prepare(`
        SELECT id, session_id, expires_at, max_uses, uses
        FROM invites WHERE token_hash = ?
      `)
      .get(hashToken(inviteToken)) as InviteRow | undefined;

    if (!invite) {
      throw new ProtocolError(404, "invite_not_found", "Invitation is invalid");
    }
    if (Date.parse(invite.expires_at) <= Date.now()) {
      throw new ProtocolError(410, "invite_expired", "Invitation has expired");
    }
    if (invite.uses >= invite.max_uses) {
      throw new ProtocolError(410, "invite_exhausted", "Invitation has already been used");
    }

    const memberToken = issueToken("ccm");
    const memberId = randomUUID();
    const createdAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO members
            (id, session_id, display_name, device_label, role, status, token_hash, created_at, approved_at)
          VALUES (?, ?, ?, ?, 'editor', 'pending', ?, ?, NULL)
        `)
        .run(
          memberId,
          invite.session_id,
          displayName,
          deviceLabel ?? null,
          hashToken(memberToken),
          createdAt,
        );
      this.db.prepare("UPDATE invites SET uses = uses + 1 WHERE id = ?").run(invite.id);
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
        createdAt,
        approvedAt: null,
      },
      memberToken,
    };
  }

  getSession(sessionId: string): Session {
    const row = this.db
      .prepare("SELECT id, name, owner_member_id, created_at FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "session_not_found", "Session was not found");
    }
    return toSession(row);
  }

  getCurrentMember(sessionId: string, memberToken: string): Member {
    return this.requireMember(sessionId, memberToken, false);
  }

  listMembers(sessionId: string, memberToken: string): Member[] {
    this.requireMember(sessionId, memberToken, true);
    const rows = this.db
      .prepare(`
        SELECT id, session_id, display_name, device_label, role, status, created_at, approved_at
        FROM members WHERE session_id = ? ORDER BY created_at ASC
      `)
      .all(sessionId) as unknown as MemberRow[];
    return rows.map(toMember);
  }

  approveMember(sessionId: string, memberToken: string, targetMemberId: string): Member {
    const owner = this.requireMember(sessionId, memberToken, true);
    if (owner.role !== "owner") {
      throw new ProtocolError(403, "owner_required", "Only the owner can approve members");
    }
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

  addMessage(
    sessionId: string,
    memberToken: string,
    kind: MessageKind,
    body: string,
  ): Message {
    const sender = this.requireMember(sessionId, memberToken, true);
    const message: Message = {
      id: randomUUID(),
      sessionId,
      senderMemberId: sender.id,
      senderDisplayName: sender.displayName,
      kind,
      body,
      createdAt: now(),
    };
    this.db
      .prepare(`
        INSERT INTO messages (id, session_id, sender_member_id, kind, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.sessionId,
        message.senderMemberId,
        message.kind,
        message.body,
        message.createdAt,
      );
    return message;
  }

  listMessages(sessionId: string, memberToken: string, after?: string): Message[] {
    this.requireMember(sessionId, memberToken, true);
    const rows = after
      ? (this.db
          .prepare(`
            SELECT m.id, m.session_id, m.sender_member_id, mb.display_name AS sender_display_name,
                   m.kind, m.body, m.created_at
            FROM messages m JOIN members mb ON mb.id = m.sender_member_id
            WHERE m.session_id = ? AND m.created_at > ?
            ORDER BY m.created_at ASC LIMIT 500
          `)
          .all(sessionId, after) as unknown as MessageRow[])
      : (this.db
          .prepare(`
            SELECT m.id, m.session_id, m.sender_member_id, mb.display_name AS sender_display_name,
                   m.kind, m.body, m.created_at
            FROM messages m JOIN members mb ON mb.id = m.sender_member_id
            WHERE m.session_id = ?
            ORDER BY m.created_at ASC LIMIT 500
          `)
          .all(sessionId) as unknown as MessageRow[]);
    return rows.map(toMessage);
  }

  authenticateRealtime(sessionId: string, memberToken: string): Member {
    return this.requireMember(sessionId, memberToken, true);
  }

  private memberById(sessionId: string, memberId: string): Member {
    const row = this.db
      .prepare(`
        SELECT id, session_id, display_name, device_label, role, status, created_at, approved_at
        FROM members WHERE session_id = ? AND id = ?
      `)
      .get(sessionId, memberId) as MemberRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "member_not_found", "Member was not found");
    }
    return toMember(row);
  }

  private requireMember(
    sessionId: string,
    memberToken: string,
    requireApproved: boolean,
  ): Member {
    const row = this.db
      .prepare(`
        SELECT id, session_id, display_name, device_label, role, status, created_at, approved_at
        FROM members WHERE session_id = ? AND token_hash = ?
      `)
      .get(sessionId, hashToken(memberToken)) as MemberRow | undefined;
    if (!row) {
      throw new ProtocolError(401, "unauthorized", "Member token is invalid");
    }
    if (requireApproved && row.status !== "approved") {
      throw new ProtocolError(403, "member_not_approved", "Owner approval is required");
    }
    return toMember(row);
  }
}
