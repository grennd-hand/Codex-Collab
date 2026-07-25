import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  type ClaimHostPairingResponse,
  type CodexPromptOptions,
  type CodexRecordEntry,
  type CodexRuntimeStatus,
  type CodexThreadCatalogEntry,
  type CreateSessionResponse,
  type JoinInviteResponse,
  type Member,
  type MemberStatus,
  type Message,
  type MessageAttachment,
  type MessageDeliveryStatus,
  type MessageKind,
  type RoomStatus,
  type Session,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceSummary,
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
  room_status: RoomStatus;
  created_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  sender_member_id: string;
  sender_display_name: string;
  kind: MessageKind;
  body: string;
  codex_options_json: string | null;
  delivery_status: MessageDeliveryStatus | null;
  codex_turn_id: string | null;
  completed_at: string | null;
  created_at: string;
}

interface MessageAttachmentRow {
  id: string;
  message_id: string;
  name: string;
  media_type: string;
  size: number;
  content: Uint8Array;
}

interface InviteRow {
  id: string;
  session_id: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  room_status: RoomStatus;
}

interface HostPairingRow {
  id: string;
  session_id: string;
  expires_at: string;
  used_at: string | null;
}

interface WorkspaceStateRow {
  session_id: string;
  host_device_label: string;
  root_label: string;
  catalog_json: string;
  selected_thread_id: string | null;
  history_json: string;
  codex_runtime_status: CodexRuntimeStatus;
  synced_at: string | null;
}

interface WorkspaceFileRow {
  path: string;
  size: number;
  modified_at: string;
  sha256: string;
  content: string;
}

function now(): string {
  return new Date().toISOString();
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    ownerMemberId: row.owner_member_id,
    roomStatus: row.room_status,
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
        room_status TEXT NOT NULL DEFAULT 'open'
          CHECK (room_status IN ('open', 'closed')),
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
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'codex_prompt', 'codex_stop', 'system')),
        body TEXT NOT NULL,
        codex_options_json TEXT,
        delivery_status TEXT
          CHECK (delivery_status IN ('queued', 'submitted', 'completed', 'failed')),
        codex_turn_id TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS member_tokens (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        device_label TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_pairings (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_by_member_id TEXT NOT NULL REFERENCES members(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS workspace_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        host_device_label TEXT NOT NULL,
        root_label TEXT NOT NULL,
        catalog_json TEXT NOT NULL DEFAULT '[]',
        selected_thread_id TEXT,
        history_json TEXT NOT NULL DEFAULT '[]',
        codex_runtime_status TEXT NOT NULL DEFAULT 'unavailable'
          CHECK (codex_runtime_status IN ('unavailable', 'idle', 'running')),
        synced_at TEXT
      );
      CREATE TABLE IF NOT EXISTS workspace_files (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (session_id, path)
      );
      CREATE INDEX IF NOT EXISTS members_session_idx ON members(session_id);
      CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS member_tokens_member_idx ON member_tokens(member_id);
      CREATE INDEX IF NOT EXISTS workspace_files_session_idx ON workspace_files(session_id);
    `);
    this.ensureColumn(
      "sessions",
      "room_status",
      "TEXT NOT NULL DEFAULT 'open' CHECK (room_status IN ('open', 'closed'))",
    );
    this.migrateMessagesTable();
    this.ensureColumn(
      "workspace_state",
      "codex_runtime_status",
      "TEXT NOT NULL DEFAULT 'unavailable'",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        content BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_attachments_message_idx
        ON message_attachments(message_id);
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private migrateMessagesTable(): void {
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql?: string } | undefined;
    const columns = this.db.prepare("PRAGMA table_info(messages)").all() as unknown as Array<{
      name: string;
    }>;
    const hasOptions = columns.some((item) => item.name === "codex_options_json");
    const hasDelivery = columns.some((item) => item.name === "delivery_status");
    const hasTurnId = columns.some((item) => item.name === "codex_turn_id");
    const hasCompletedAt = columns.some((item) => item.name === "completed_at");
    const hasAttachmentsTable = Boolean(
      this.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments'",
        )
        .get(),
    );
    if (
      schema?.sql?.includes("'codex_stop'") &&
      schema.sql.includes("'completed'") &&
      hasOptions &&
      hasDelivery &&
      hasTurnId &&
      hasCompletedAt
    ) {
      return;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (hasAttachmentsTable) {
        this.db.exec(
          "ALTER TABLE message_attachments RENAME TO message_attachments_legacy",
        );
      }
      this.db.exec("ALTER TABLE messages RENAME TO messages_legacy");
      this.db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sender_member_id TEXT NOT NULL REFERENCES members(id),
          kind TEXT NOT NULL CHECK (kind IN ('chat', 'codex_prompt', 'codex_stop', 'system')),
          body TEXT NOT NULL,
          codex_options_json TEXT,
          delivery_status TEXT
            CHECK (delivery_status IN ('queued', 'submitted', 'completed', 'failed')),
          codex_turn_id TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL
        )
      `);
      this.db.exec(`
        INSERT INTO messages
          (id, session_id, sender_member_id, kind, body, codex_options_json,
           delivery_status, codex_turn_id, completed_at, created_at)
        SELECT id, session_id, sender_member_id, kind, body,
               ${hasOptions ? "codex_options_json" : "NULL"},
               ${hasDelivery ? "delivery_status" : "NULL"},
               ${hasTurnId ? "codex_turn_id" : "NULL"},
               ${hasCompletedAt ? "completed_at" : "NULL"},
               created_at
        FROM messages_legacy
      `);
      if (hasAttachmentsTable) {
        this.db.exec(`
          CREATE TABLE message_attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            media_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            content BLOB NOT NULL
          )
        `);
        this.db.exec(`
          INSERT INTO message_attachments
            (id, message_id, name, media_type, size, content)
          SELECT id, message_id, name, media_type, size, content
          FROM message_attachments_legacy
        `);
        this.db.exec("DROP TABLE message_attachments_legacy");
      }
      this.db.exec("DROP TABLE messages_legacy");
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS messages_session_created_idx
          ON messages(session_id, created_at)
      `);
      if (hasAttachmentsTable) {
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS message_attachments_message_idx
            ON message_attachments(message_id)
        `);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createSession(name: string, ownerDisplayName: string, deviceLabel?: string): CreateSessionResponse {
    const sessionId = randomUUID();
    const ownerId = randomUUID();
    const memberToken = issueToken("ccm");
    const createdAt = now();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO sessions (id, name, owner_member_id, room_status, created_at) VALUES (?, ?, ?, 'open', ?)",
        )
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

  joinInvite(inviteToken: string, displayName: string, deviceLabel?: string): JoinInviteResponse {
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
      .prepare(
        "SELECT id, name, owner_member_id, room_status, created_at FROM sessions WHERE id = ?",
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "session_not_found", "Session was not found");
    }
    return toSession(row);
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
    input: {
      attachments?: Array<{
        name: string;
        mediaType: string;
        size: number;
        content: Uint8Array;
      }>;
      codexOptions?: CodexPromptOptions | null;
    } = {},
  ): Message {
    const sender = this.requireMember(sessionId, memberToken, true);
    if (kind === "chat" || kind === "codex_prompt") {
      this.requireRoomOpen(sessionId);
    }
    const attachments = input.attachments ?? [];
    if (
      sender.role !== "owner" &&
      input.codexOptions?.accessMode &&
      input.codexOptions.accessMode !== "follow-desktop"
    ) {
      throw new ProtocolError(
        403,
        "owner_required",
        "Only the owner can change Codex approval permissions",
      );
    }
    const message: Message = {
      id: randomUUID(),
      sessionId,
      senderMemberId: sender.id,
      senderDisplayName: sender.displayName,
      kind,
      body,
      attachments: [],
      codexOptions: input.codexOptions ?? null,
      deliveryStatus:
        kind === "codex_prompt" || kind === "codex_stop" ? "queued" : null,
      codexTurnId: null,
      completedAt: null,
      createdAt: now(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO messages
            (id, session_id, sender_member_id, kind, body, codex_options_json,
             delivery_status, codex_turn_id, completed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          message.id,
          message.sessionId,
          message.senderMemberId,
          message.kind,
          message.body,
          message.codexOptions ? JSON.stringify(message.codexOptions) : null,
          message.deliveryStatus,
          message.codexTurnId,
          message.completedAt,
          message.createdAt,
        );
      const insertAttachment = this.db.prepare(`
        INSERT INTO message_attachments
          (id, message_id, name, media_type, size, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const attachment of attachments) {
        insertAttachment.run(
          randomUUID(),
          message.id,
          attachment.name,
          attachment.mediaType,
          attachment.size,
          attachment.content,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.messageById(sessionId, message.id);
  }

  listMessages(sessionId: string, memberToken: string, after?: string): Message[] {
    this.requireMember(sessionId, memberToken, true);
    const rows = after
      ? (this.db
          .prepare(`
            SELECT m.id, m.session_id, m.sender_member_id, mb.display_name AS sender_display_name,
                   m.kind, m.body, m.codex_options_json, m.delivery_status,
                   m.codex_turn_id, m.completed_at, m.created_at
            FROM messages m JOIN members mb ON mb.id = m.sender_member_id
            WHERE m.session_id = ? AND m.created_at > ?
            ORDER BY m.created_at ASC LIMIT 500
          `)
          .all(sessionId, after) as unknown as MessageRow[])
      : (this.db
          .prepare(`
            SELECT m.id, m.session_id, m.sender_member_id, mb.display_name AS sender_display_name,
                   m.kind, m.body, m.codex_options_json, m.delivery_status,
                   m.codex_turn_id, m.completed_at, m.created_at
            FROM messages m JOIN members mb ON mb.id = m.sender_member_id
            WHERE m.session_id = ?
            ORDER BY m.created_at ASC LIMIT 500
          `)
          .all(sessionId) as unknown as MessageRow[]);
    return rows.map((row) => this.toMessage(row));
  }

  getMessageAttachment(
    sessionId: string,
    memberToken: string,
    messageId: string,
    attachmentId: string,
  ): MessageAttachmentRow {
    this.requireMember(sessionId, memberToken, true);
    const row = this.db
      .prepare(`
        SELECT a.id, a.message_id, a.name, a.media_type, a.size, a.content
        FROM message_attachments a
        JOIN messages m ON m.id = a.message_id
        WHERE m.session_id = ? AND m.id = ? AND a.id = ?
      `)
      .get(sessionId, messageId, attachmentId) as MessageAttachmentRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "attachment_not_found", "Attachment was not found");
    }
    return row;
  }

  updateMessageDeliveryStatus(
    sessionId: string,
    memberToken: string,
    messageId: string,
    status: MessageDeliveryStatus,
    codexTurnId?: string | null,
  ): Message {
    this.requireOwner(sessionId, memberToken);
    const completedAt = status === "completed" || status === "failed" ? now() : null;
    const result = this.db
      .prepare(`
        UPDATE messages
        SET delivery_status = ?,
            codex_turn_id = COALESCE(?, codex_turn_id),
            completed_at = ?
        WHERE session_id = ? AND id = ? AND kind IN ('codex_prompt', 'codex_stop')
      `)
      .run(status, codexTurnId ?? null, completedAt, sessionId, messageId);
    if (result.changes !== 1) {
      throw new ProtocolError(404, "message_not_found", "Codex command was not found");
    }
    return this.messageById(sessionId, messageId);
  }

  createHostPairing(
    sessionId: string,
    memberToken: string,
    expiresInMinutes: number,
  ): { pairingToken: string; expiresAt: string } {
    const owner = this.requireOwner(sessionId, memberToken);
    const pairingToken = issueToken("ccp");
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString();
    this.db
      .prepare(`
        INSERT INTO host_pairings
          (id, session_id, token_hash, created_by_member_id, created_at, expires_at, used_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        randomUUID(),
        sessionId,
        hashToken(pairingToken),
        owner.id,
        now(),
        expiresAt,
      );
    return { pairingToken, expiresAt };
  }

  claimHostPairing(
    pairingToken: string,
    deviceLabel: string,
    rootLabel: string,
  ): ClaimHostPairingResponse {
    const pairing = this.db
      .prepare(`
        SELECT id, session_id, expires_at, used_at
        FROM host_pairings WHERE token_hash = ?
      `)
      .get(hashToken(pairingToken)) as HostPairingRow | undefined;
    if (!pairing) {
      throw new ProtocolError(404, "pairing_not_found", "Host pairing code is invalid");
    }
    if (pairing.used_at) {
      throw new ProtocolError(410, "pairing_used", "Host pairing code has already been used");
    }
    if (Date.parse(pairing.expires_at) <= Date.now()) {
      throw new ProtocolError(410, "pairing_expired", "Host pairing code has expired");
    }

    const session = this.getSession(pairing.session_id);
    const owner = this.memberById(pairing.session_id, session.ownerMemberId);
    const memberToken = issueToken("cch");
    const claimedAt = now();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = this.db
        .prepare(`
          UPDATE host_pairings SET used_at = ?
          WHERE id = ? AND used_at IS NULL
        `)
        .run(claimedAt, pairing.id);
      if (claimed.changes !== 1) {
        throw new ProtocolError(410, "pairing_used", "Host pairing code has already been used");
      }
      this.db
        .prepare(`
          INSERT INTO member_tokens
            (id, session_id, member_id, token_hash, device_label, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          pairing.session_id,
          owner.id,
          hashToken(memberToken),
          deviceLabel,
          claimedAt,
        );
      this.db
        .prepare(`
          INSERT INTO workspace_state
            (session_id, host_device_label, root_label, catalog_json, selected_thread_id,
             history_json, codex_runtime_status, synced_at)
          VALUES (?, ?, ?, '[]', NULL, '[]', 'unavailable', NULL)
          ON CONFLICT(session_id) DO UPDATE SET
            host_device_label = excluded.host_device_label,
            root_label = excluded.root_label,
            catalog_json = '[]',
            selected_thread_id = NULL,
            history_json = '[]',
            codex_runtime_status = 'unavailable',
            synced_at = NULL
        `)
        .run(pairing.session_id, deviceLabel, rootLabel);
      this.db.prepare("DELETE FROM workspace_files WHERE session_id = ?").run(pairing.session_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { session, owner, memberToken };
  }

  publishWorkspaceCatalog(
    sessionId: string,
    memberToken: string,
    input: {
      deviceLabel: string;
      rootLabel: string;
      threads: CodexThreadCatalogEntry[];
    },
  ): WorkspaceSummary {
    this.requireOwner(sessionId, memberToken);
    const current = this.workspaceState(sessionId);
    const selectedStillExists =
      current?.selected_thread_id &&
      input.threads.some((thread) => thread.id === current.selected_thread_id);
    const selectedThreadId = selectedStillExists ? current.selected_thread_id : null;
    const historyJson = selectedStillExists ? current?.history_json ?? "[]" : "[]";
    const codexRuntimeStatus = selectedStillExists
      ? current?.codex_runtime_status ?? "unavailable"
      : "unavailable";
    const syncedAt = selectedStillExists ? current?.synced_at ?? null : null;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO workspace_state
            (session_id, host_device_label, root_label, catalog_json, selected_thread_id,
             history_json, codex_runtime_status, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            host_device_label = excluded.host_device_label,
            root_label = excluded.root_label,
            catalog_json = excluded.catalog_json,
            selected_thread_id = excluded.selected_thread_id,
            history_json = excluded.history_json,
            codex_runtime_status = excluded.codex_runtime_status,
            synced_at = excluded.synced_at
        `)
        .run(
          sessionId,
          input.deviceLabel,
          input.rootLabel,
          JSON.stringify(input.threads),
          selectedThreadId,
          historyJson,
          codexRuntimeStatus,
          syncedAt,
        );
      if (!selectedStillExists) {
        this.db.prepare("DELETE FROM workspace_files WHERE session_id = ?").run(sessionId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkspace(sessionId, memberToken);
  }

  selectWorkspaceThread(
    sessionId: string,
    memberToken: string,
    threadId: string,
  ): WorkspaceSummary {
    this.requireOwner(sessionId, memberToken);
    const state = this.workspaceState(sessionId);
    if (!state) {
      throw new ProtocolError(409, "host_not_paired", "Pair the local Codex host first");
    }
    const catalog = this.parseCatalog(state.catalog_json);
    if (!catalog.some((thread) => thread.id === threadId)) {
      throw new ProtocolError(404, "thread_not_found", "Codex task is not in the host catalog");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE workspace_state
          SET selected_thread_id = ?, history_json = '[]',
              codex_runtime_status = 'unavailable', synced_at = NULL
          WHERE session_id = ?
        `)
        .run(threadId, sessionId);
      this.db.prepare("DELETE FROM workspace_files WHERE session_id = ?").run(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkspace(sessionId, memberToken);
  }

  publishWorkspaceSnapshot(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
      files: WorkspaceFileContent[];
    },
  ): WorkspaceSummary {
    this.requireOwner(sessionId, memberToken);
    const state = this.workspaceState(sessionId);
    if (!state?.selected_thread_id || state.selected_thread_id !== input.threadId) {
      throw new ProtocolError(
        409,
        "thread_not_selected",
        "The owner must select this Codex task before it can be imported",
      );
    }
    const syncedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM workspace_files WHERE session_id = ?").run(sessionId);
      const insertFile = this.db.prepare(`
        INSERT INTO workspace_files
          (session_id, path, size, modified_at, sha256, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const file of input.files) {
        insertFile.run(
          sessionId,
          file.path,
          file.size,
          file.modifiedAt,
          file.sha256,
          file.content,
        );
      }
      this.db
        .prepare(`
          UPDATE workspace_state SET history_json = ?, synced_at = ?
          WHERE session_id = ?
        `)
        .run(JSON.stringify(input.history), syncedAt, sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkspace(sessionId, memberToken);
  }

  publishCodexRuntimeStatus(
    sessionId: string,
    memberToken: string,
    status: CodexRuntimeStatus,
  ): { workspace: WorkspaceSummary; changed: boolean } {
    this.requireOwner(sessionId, memberToken);
    const state = this.workspaceState(sessionId);
    if (!state) {
      throw new ProtocolError(409, "host_not_paired", "Pair the local Codex host first");
    }
    const changed = state.codex_runtime_status !== status;
    if (changed) {
      this.db
        .prepare(`
          UPDATE workspace_state SET codex_runtime_status = ?
          WHERE session_id = ?
        `)
        .run(status, sessionId);
    }
    return {
      workspace: this.getWorkspace(sessionId, memberToken),
      changed,
    };
  }

  getWorkspace(sessionId: string, memberToken: string): WorkspaceSummary {
    const member = this.requireMember(sessionId, memberToken, true);
    const state = this.workspaceState(sessionId);
    if (!state) {
      return {
        hostConnected: false,
        hostDeviceLabel: null,
        rootLabel: null,
        threads: [],
        selectedThreadId: null,
        selectedThread: null,
        history: [],
        files: [],
        codexRuntimeStatus: "unavailable",
        syncedAt: null,
      };
    }
    const fullCatalog = this.parseCatalog(state.catalog_json);
    const selectedThread =
      fullCatalog.find((thread) => thread.id === state.selected_thread_id) ?? null;
    const rows = this.db
      .prepare(`
        SELECT path, size, modified_at, sha256, content
        FROM workspace_files WHERE session_id = ? ORDER BY path ASC
      `)
      .all(sessionId) as unknown as WorkspaceFileRow[];
    return {
      hostConnected: true,
      hostDeviceLabel: state.host_device_label,
      rootLabel: state.root_label,
      threads: member.role === "owner" ? fullCatalog : [],
      selectedThreadId: state.selected_thread_id,
      selectedThread,
      history: this.parseHistory(state.history_json),
      files: rows.map((row) => this.toWorkspaceFile(row)),
      codexRuntimeStatus: state.codex_runtime_status,
      syncedAt: state.synced_at,
    };
  }

  getWorkspaceFile(
    sessionId: string,
    memberToken: string,
    path: string,
  ): WorkspaceFileContent {
    this.requireMember(sessionId, memberToken, true);
    const row = this.db
      .prepare(`
        SELECT path, size, modified_at, sha256, content
        FROM workspace_files WHERE session_id = ? AND path = ?
      `)
      .get(sessionId, path) as WorkspaceFileRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "workspace_file_not_found", "Shared file was not found");
    }
    return { ...this.toWorkspaceFile(row), content: row.content };
  }

  authenticateRealtime(sessionId: string, memberToken: string): Member {
    return this.requireMember(sessionId, memberToken, true);
  }

  private messageById(sessionId: string, messageId: string): Message {
    const row = this.db
      .prepare(`
        SELECT m.id, m.session_id, m.sender_member_id, mb.display_name AS sender_display_name,
               m.kind, m.body, m.codex_options_json, m.delivery_status,
               m.codex_turn_id, m.completed_at, m.created_at
        FROM messages m JOIN members mb ON mb.id = m.sender_member_id
        WHERE m.session_id = ? AND m.id = ?
      `)
      .get(sessionId, messageId) as MessageRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "message_not_found", "Message was not found");
    }
    return this.toMessage(row);
  }

  private toMessage(row: MessageRow): Message {
    const attachmentRows = this.db
      .prepare(`
        SELECT id, message_id, name, media_type, size, content
        FROM message_attachments WHERE message_id = ? ORDER BY rowid ASC
      `)
      .all(row.id) as unknown as MessageAttachmentRow[];
    const attachments: MessageAttachment[] = attachmentRows.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.media_type,
      size: attachment.size,
    }));
    return {
      id: row.id,
      sessionId: row.session_id,
      senderMemberId: row.sender_member_id,
      senderDisplayName: row.sender_display_name,
      kind: row.kind,
      body: row.body,
      attachments,
      codexOptions: row.codex_options_json
        ? (JSON.parse(row.codex_options_json) as CodexPromptOptions)
        : null,
      deliveryStatus: row.delivery_status,
      codexTurnId: row.codex_turn_id,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
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
    const tokenHash = hashToken(memberToken);
    const row = this.db
      .prepare(`
        SELECT id, session_id, display_name, device_label, role, status, created_at, approved_at
        FROM members
        WHERE session_id = ?
          AND (
            token_hash = ?
            OR EXISTS (
              SELECT 1 FROM member_tokens
              WHERE member_tokens.session_id = members.session_id
                AND member_tokens.member_id = members.id
                AND member_tokens.token_hash = ?
            )
          )
      `)
      .get(sessionId, tokenHash, tokenHash) as MemberRow | undefined;
    if (!row) {
      throw new ProtocolError(401, "unauthorized", "Member token is invalid");
    }
    if (requireApproved && row.status !== "approved") {
      throw new ProtocolError(403, "member_not_approved", "Owner approval is required");
    }
    return toMember(row);
  }

  private requireOwner(sessionId: string, memberToken: string): Member {
    const member = this.requireMember(sessionId, memberToken, true);
    if (member.role !== "owner") {
      throw new ProtocolError(403, "owner_required", "Only the owner can manage the host workspace");
    }
    return member;
  }

  private requireRoomOpen(sessionId: string): void {
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

  private workspaceState(sessionId: string): WorkspaceStateRow | undefined {
    return this.db
      .prepare(`
        SELECT session_id, host_device_label, root_label, catalog_json, selected_thread_id,
               history_json, codex_runtime_status, synced_at
        FROM workspace_state WHERE session_id = ?
      `)
      .get(sessionId) as WorkspaceStateRow | undefined;
  }

  private parseCatalog(value: string): CodexThreadCatalogEntry[] {
    return JSON.parse(value) as CodexThreadCatalogEntry[];
  }

  private parseHistory(value: string): CodexRecordEntry[] {
    return JSON.parse(value) as CodexRecordEntry[];
  }

  private toWorkspaceFile(row: WorkspaceFileRow): WorkspaceFile {
    return {
      path: row.path,
      size: row.size,
      modifiedAt: row.modified_at,
      sha256: row.sha256,
    };
  }
}
