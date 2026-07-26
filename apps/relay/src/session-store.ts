import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  type Account,
  type AccountProfileResponse,
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
  type RestoreAccountRoomResponse,
  type Session,
  type WorkspaceFile,
  type WorkspaceFileAccess,
  type WorkspaceFileContent,
  type WorkspaceFileOperation,
  type WorkspaceFileOperationClaim,
  type WorkspaceFileOperationConfirmation,
  type WorkspaceFileOperationKind,
  type WorkspaceFileOperationStatus,
  type WorkspaceSummary,
  codexConfigRelativePath,
  containsLikelySecret,
  isPublishableCodexConfigPath,
  isPublishableWorkspacePath,
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
  workspace_file_access: WorkspaceFileAccess;
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
  selected_thread_id: string | null;
  completed_at: string | null;
  created_at: string;
}

interface MessageAttachmentMetadataRow {
  id: string;
  message_id: string;
  name: string;
  media_type: string;
  size: number;
}

interface MessageAttachmentRow extends MessageAttachmentMetadataRow {
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
  host_token_id: string | null;
  host_generation: string | null;
  catalog_json: string;
  selected_thread_id: string | null;
  history_json: string;
  codex_runtime_status: CodexRuntimeStatus;
  synced_at: string | null;
}

interface WorkspaceFileMetadataRow {
  path: string;
  size: number;
  modified_at: string;
  sha256: string;
}

interface WorkspaceFileRow extends WorkspaceFileMetadataRow {
  content: string;
}

interface WorkspaceFileOperationRow {
  id: string;
  session_id: string;
  requested_by_member_id: string;
  requested_by_display_name: string;
  host_generation: string | null;
  kind: WorkspaceFileOperationKind;
  path: string;
  request_content: string | null;
  request_size: number | null;
  expected_sha256: string | null;
  status: WorkspaceFileOperationStatus;
  result_content: string | null;
  result_size: number | null;
  result_modified_at: string | null;
  result_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  lease_confirmed_at: string | null;
  completed_at: string | null;
}

interface AccountRow {
  id: string;
  display_name: string;
  created_at: string;
}

interface AccountChallengeRow {
  kind: "registration" | "authentication";
  challenge: string;
  account_id: string | null;
  display_name: string | null;
  expected_origin: string;
  rp_id: string;
  expires_at: string;
}

interface AccountCredentialRow {
  id: string;
  account_id: string;
  public_key: Uint8Array;
  counter: number;
  transports_json: string;
}

interface AccountRoomRow {
  session_id: string;
  session_name: string;
  owner_member_id: string;
  room_status: RoomStatus;
  session_created_at: string;
  member_id: string;
  member_display_name: string;
  member_device_label: string | null;
  member_role: "owner" | "editor";
  member_status: MemberStatus;
  member_workspace_file_access: WorkspaceFileAccess;
  member_created_at: string;
  member_approved_at: string | null;
  last_used_at: string | null;
}

export interface AccountChallenge {
  kind: "registration" | "authentication";
  challenge: string;
  accountId: string | null;
  displayName: string | null;
  expectedOrigin: string;
  rpId: string;
}

export interface StoredAccountCredential {
  id: string;
  accountId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}

export interface AccountSessionIdentity {
  account: Account;
  accountSessionId: string;
  expiresAt: string;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeWorkspaceOperationPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new ProtocolError(400, "unsafe_workspace_path", "Use a safe relative file path");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        segment.includes(":") ||
        /[\u0000-\u001f<>"|?*]/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
    )
  ) {
    throw new ProtocolError(400, "unsafe_workspace_path", "Use a safe relative file path");
  }
  const configRelativePath = codexConfigRelativePath(normalized);
  if (configRelativePath) {
    if (!isPublishableCodexConfigPath(configRelativePath)) {
      throw new ProtocolError(
        403,
        "workspace_file_not_shared",
        "This file is not available to the collaboration editor",
      );
    }
    return `.codex/${configRelativePath}`;
  }
  if (!isPublishableWorkspacePath(normalized)) {
    throw new ProtocolError(
      403,
      "workspace_file_not_shared",
      "This file is not available to the collaboration editor",
    );
  }
  return normalized;
}

function contentSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MAX_ACTIVE_FILE_OPERATIONS_PER_MEMBER = 8;
const MAX_ACTIVE_FILE_OPERATIONS_PER_SESSION = 64;
const MAX_FILE_OPERATION_AUDIT_ROWS_PER_SESSION = 500;
const MAX_FILE_OPERATION_RESULT_CONTENT_COUNT = 20;
const MAX_FILE_OPERATION_RESULT_CONTENT_BYTES = 10_000_000;
const FILE_OPERATION_LEASE_MS = 30_000;
const MAX_WORKSPACE_FILE_COUNT = 600;
const MAX_WORKSPACE_FILE_BYTES = 5_000_000;
const MAX_MEMBER_WRITE_OPERATIONS_PER_MINUTE = 30;
const MAX_MEMBER_WRITE_BYTES_PER_MINUTE = 4_000_000;

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
    workspaceFileAccess:
      row.role === "owner" ? "workspace-write" : row.workspace_file_access,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export class SessionStore {
  readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const existingMemberTokenColumns = this.db
      .prepare("PRAGMA table_info(member_tokens)")
      .all() as unknown as Array<{ name: string }>;
    const hadTokenPurposeColumn = existingMemberTokenColumns.some(
      (column) => column.name === "token_purpose",
    );
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
        workspace_file_access TEXT NOT NULL DEFAULT 'read-only'
          CHECK (workspace_file_access IN ('read-only', 'workspace-write')),
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
        selected_thread_id TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS member_tokens (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        device_label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        account_session_id TEXT REFERENCES account_sessions(id) ON DELETE SET NULL,
        expires_at TEXT,
        revoked_at TEXT,
        token_purpose TEXT NOT NULL DEFAULT 'legacy'
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_credentials (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports_json TEXT NOT NULL DEFAULT '[]',
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS account_challenges (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
        challenge TEXT NOT NULL,
        account_id TEXT,
        display_name TEXT,
        expected_origin TEXT NOT NULL,
        rp_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS account_csrf_tokens (
        token_hash TEXT PRIMARY KEY,
        account_session_id TEXT NOT NULL REFERENCES account_sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_memberships (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        PRIMARY KEY (account_id, session_id),
        FOREIGN KEY (session_id, member_id)
          REFERENCES members(session_id, id) ON DELETE CASCADE
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
        host_token_id TEXT REFERENCES member_tokens(id) ON DELETE SET NULL,
        host_generation TEXT,
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
      CREATE TABLE IF NOT EXISTS workspace_file_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        requested_by_member_id TEXT NOT NULL REFERENCES members(id),
        requested_by_display_name TEXT NOT NULL,
        host_generation TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('read', 'write')),
        path TEXT NOT NULL,
        request_content TEXT,
        request_size INTEGER,
        expected_sha256 TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
        result_content TEXT,
        result_size INTEGER,
        result_modified_at TEXT,
        result_sha256 TEXT,
        error_code TEXT,
        error_message TEXT,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        lease_id TEXT,
        lease_expires_at TEXT,
        lease_confirmed_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS members_session_idx ON members(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS members_session_id_unique
        ON members(session_id, id);
      CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS member_tokens_member_idx ON member_tokens(member_id);
      CREATE INDEX IF NOT EXISTS account_credentials_account_idx
        ON account_credentials(account_id);
      CREATE INDEX IF NOT EXISTS account_sessions_account_idx
        ON account_sessions(account_id);
      CREATE INDEX IF NOT EXISTS account_csrf_tokens_session_idx
        ON account_csrf_tokens(account_session_id);
      CREATE INDEX IF NOT EXISTS account_memberships_session_idx
        ON account_memberships(session_id);
      CREATE INDEX IF NOT EXISTS workspace_files_session_idx ON workspace_files(session_id);
      CREATE INDEX IF NOT EXISTS workspace_file_operations_queue_idx
        ON workspace_file_operations(session_id, status, requested_at);
      CREATE INDEX IF NOT EXISTS workspace_file_operations_actor_idx
        ON workspace_file_operations(session_id, requested_by_member_id, requested_at);
    `);
    this.ensureColumn(
      "account_sessions",
      "csrf_token_hash",
      "TEXT NOT NULL DEFAULT ''",
    );
    this.ensureColumn("member_tokens", "account_session_id", "TEXT");
    this.ensureColumn("member_tokens", "expires_at", "TEXT");
    this.ensureColumn("member_tokens", "revoked_at", "TEXT");
    this.ensureColumn(
      "member_tokens",
      "token_purpose",
      "TEXT NOT NULL DEFAULT 'legacy'",
    );
    this.ensureColumn(
      "sessions",
      "room_status",
      "TEXT NOT NULL DEFAULT 'open' CHECK (room_status IN ('open', 'closed'))",
    );
    this.ensureColumn(
      "members",
      "workspace_file_access",
      "TEXT NOT NULL DEFAULT 'read-only' CHECK (workspace_file_access IN ('read-only', 'workspace-write'))",
    );
    this.db.exec(
      "UPDATE members SET workspace_file_access = 'workspace-write' WHERE role = 'owner'",
    );
    this.migrateMessagesTable();
    this.ensureColumn("messages", "selected_thread_id", "TEXT");
    this.ensureColumn(
      "workspace_state",
      "codex_runtime_status",
      "TEXT NOT NULL DEFAULT 'unavailable'",
    );
    this.ensureColumn("workspace_state", "host_token_id", "TEXT");
    this.ensureColumn("workspace_state", "host_generation", "TEXT");
    this.ensureColumn("workspace_file_operations", "host_generation", "TEXT");
    this.ensureColumn("workspace_file_operations", "lease_id", "TEXT");
    this.ensureColumn("workspace_file_operations", "lease_expires_at", "TEXT");
    this.ensureColumn("workspace_file_operations", "lease_confirmed_at", "TEXT");
    this.ensureColumn("workspace_file_operations", "request_size", "INTEGER");
    this.db.exec(`
      UPDATE member_tokens
      SET token_purpose = 'account'
      WHERE account_session_id IS NOT NULL;
    `);
    if (!hadTokenPurposeColumn) {
      const repairedAt = now();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(`
            UPDATE workspace_file_operations
            SET status = 'failed', request_content = NULL, result_content = NULL,
                lease_id = NULL, lease_expires_at = NULL, lease_confirmed_at = NULL,
                error_code = 'host_repair_required',
                error_message = 'Pair the Codex host again after upgrading',
                completed_at = COALESCE(completed_at, ?)
            WHERE status IN ('queued', 'processing')
              AND session_id IN (
                SELECT session_id FROM workspace_state
                WHERE host_token_id IS NOT NULL OR host_generation IS NOT NULL
              )
          `)
          .run(repairedAt);
        this.db
          .prepare(`
            UPDATE member_tokens
            SET revoked_at = COALESCE(revoked_at, ?)
            WHERE account_session_id IS NULL
          `)
          .run(repairedAt);
        this.db.exec(`
          DELETE FROM workspace_files
          WHERE session_id IN (
            SELECT session_id FROM workspace_state
            WHERE host_token_id IS NOT NULL OR host_generation IS NOT NULL
          );
          UPDATE workspace_state
          SET host_token_id = NULL, host_generation = NULL,
              catalog_json = '[]', selected_thread_id = NULL, history_json = '[]',
              codex_runtime_status = 'unavailable', synced_at = NULL;
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    this.db
      .prepare(`
        UPDATE member_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE token_purpose = 'legacy' AND account_session_id IS NULL
      `)
      .run(now());
    this.db
      .prepare(`
        UPDATE workspace_file_operations
        SET status = 'failed', request_content = NULL, result_content = NULL,
            error_code = 'host_repaired',
            error_message = 'The host workspace changed before this operation completed',
            completed_at = COALESCE(completed_at, ?)
        WHERE host_generation IS NULL AND status IN ('queued', 'processing')
      `)
      .run(now());
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
    this.backfillInFlightMessageThreadIds();
    this.disconnectUnboundLegacyHosts();
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
    const hasSelectedThreadId = columns.some(
      (item) => item.name === "selected_thread_id",
    );
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
          selected_thread_id TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL
        )
      `);
      this.db.exec(`
        INSERT INTO messages
          (id, session_id, sender_member_id, kind, body, codex_options_json,
           delivery_status, codex_turn_id, selected_thread_id, completed_at, created_at)
        SELECT id, session_id, sender_member_id, kind, body,
               ${hasOptions ? "codex_options_json" : "NULL"},
               ${hasDelivery ? "delivery_status" : "NULL"},
               ${hasTurnId ? "codex_turn_id" : "NULL"},
               ${hasSelectedThreadId ? "selected_thread_id" : "NULL"},
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

  createSession(
    name: string,
    ownerDisplayName: string,
    deviceLabel?: string,
    accountIdentity?: AccountSessionIdentity,
  ): CreateSessionResponse {
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

  private accountSessionIdentity(
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
      attachments.length > 0 &&
      kind !== "chat" &&
      kind !== "codex_prompt"
    ) {
      throw new ProtocolError(
        400,
        "invalid_request",
        "Attachments are supported only for chat and Codex prompts",
      );
    }
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
    const workspaceThreadId =
      kind === "codex_prompt" || kind === "codex_stop"
        ? this.workspaceState(sessionId)?.selected_thread_id ?? null
        : null;
    if ((kind === "codex_prompt" || kind === "codex_stop") && !workspaceThreadId) {
      throw new ProtocolError(
        409,
        "workspace_thread_not_selected",
        "Select a Codex task before sending a Codex command",
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
      workspaceThreadId,
      completedAt: null,
      createdAt: now(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          INSERT INTO messages
            (id, session_id, sender_member_id, kind, body, codex_options_json,
             delivery_status, codex_turn_id, selected_thread_id, completed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          message.workspaceThreadId,
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
                   m.codex_turn_id, m.selected_thread_id, m.completed_at, m.created_at
            FROM messages m JOIN members mb ON mb.id = m.sender_member_id
            WHERE m.session_id = ? AND m.created_at > ?
            ORDER BY m.created_at ASC, m.id ASC LIMIT 500
          `)
          .all(sessionId, after) as unknown as MessageRow[])
      : (this.db
          .prepare(`
            SELECT * FROM (
              SELECT m.id, m.session_id, m.sender_member_id,
                     mb.display_name AS sender_display_name,
                     m.kind, m.body, m.codex_options_json, m.delivery_status,
                     m.codex_turn_id, m.selected_thread_id, m.completed_at, m.created_at
              FROM messages m JOIN members mb ON mb.id = m.sender_member_id
              WHERE m.session_id = ?
              ORDER BY m.created_at DESC, m.id DESC LIMIT 500
            ) AS recent
            ORDER BY recent.created_at ASC, recent.id ASC
          `)
          .all(sessionId) as unknown as MessageRow[]);
    return this.toMessages(rows);
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
    return this.updateMessageDeliveryStatusAuthorized(
      sessionId,
      messageId,
      status,
      codexTurnId,
    );
  }

  updateMessageDeliveryStatusFromHost(
    sessionId: string,
    memberToken: string,
    messageId: string,
    status: MessageDeliveryStatus,
    codexTurnId?: string | null,
  ): Message {
    this.requireCurrentHost(sessionId, memberToken);
    return this.updateMessageDeliveryStatusAuthorized(
      sessionId,
      messageId,
      status,
      codexTurnId,
    );
  }

  private updateMessageDeliveryStatusAuthorized(
    sessionId: string,
    messageId: string,
    status: MessageDeliveryStatus,
    codexTurnId?: string | null,
  ): Message {
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
    const hostTokenId = randomUUID();
    const hostGeneration = randomUUID();

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
            (id, session_id, member_id, token_hash, device_label, created_at,
             token_purpose)
          VALUES (?, ?, ?, ?, ?, ?, 'host')
        `)
        .run(
          hostTokenId,
          pairing.session_id,
          owner.id,
          hashToken(memberToken),
          deviceLabel,
          claimedAt,
        );
      const previousHost = this.workspaceState(pairing.session_id);
      if (previousHost?.host_token_id) {
        this.db
          .prepare(
            "UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
          )
          .run(claimedAt, previousHost.host_token_id);
      }
      this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET status = 'failed', request_content = NULL, result_content = NULL,
              lease_id = NULL, lease_expires_at = NULL, lease_confirmed_at = NULL,
              error_code = 'host_repaired',
              error_message = 'The host workspace changed before this operation completed',
              completed_at = ?
          WHERE session_id = ? AND status IN ('queued', 'processing')
        `)
        .run(claimedAt, pairing.session_id);
      this.db
        .prepare(`
          INSERT INTO workspace_state
            (session_id, host_device_label, root_label, host_token_id, host_generation,
             catalog_json, selected_thread_id, history_json, codex_runtime_status, synced_at)
          VALUES (?, ?, ?, ?, ?, '[]', NULL, '[]', 'unavailable', NULL)
          ON CONFLICT(session_id) DO UPDATE SET
            host_device_label = excluded.host_device_label,
            root_label = excluded.root_label,
            host_token_id = excluded.host_token_id,
            host_generation = excluded.host_generation,
            catalog_json = '[]',
            selected_thread_id = NULL,
            history_json = '[]',
            codex_runtime_status = 'unavailable',
            synced_at = NULL
        `)
        .run(
          pairing.session_id,
          deviceLabel,
          rootLabel,
          hostTokenId,
          hostGeneration,
        );
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
    const host = this.requireCurrentHost(sessionId, memberToken);
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
            (session_id, host_device_label, root_label, host_token_id, host_generation,
             catalog_json, selected_thread_id, history_json, codex_runtime_status, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            host_device_label = excluded.host_device_label,
            root_label = excluded.root_label,
            host_token_id = excluded.host_token_id,
            host_generation = excluded.host_generation,
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
          host.tokenId,
          host.generation,
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
    return this.selectWorkspaceThreadAuthorized(sessionId, memberToken, threadId);
  }

  selectWorkspaceThreadFromHost(
    sessionId: string,
    memberToken: string,
    threadId: string,
  ): WorkspaceSummary {
    this.requireCurrentHost(sessionId, memberToken);
    return this.selectWorkspaceThreadAuthorized(sessionId, memberToken, threadId);
  }

  private selectWorkspaceThreadAuthorized(
    sessionId: string,
    memberToken: string,
    threadId: string,
  ): WorkspaceSummary {
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
    this.requireCurrentHost(sessionId, memberToken);
    const state = this.workspaceState(sessionId);
    if (!state?.selected_thread_id || state.selected_thread_id !== input.threadId) {
      throw new ProtocolError(
        409,
        "thread_not_selected",
        "The owner must select this Codex task before it can be imported",
      );
    }
    let snapshotBytes = 0;
    const snapshotPaths = new Set<string>();
    for (const file of input.files) {
      const normalizedPath = normalizeWorkspaceOperationPath(file.path);
      const actualSize = Buffer.byteLength(file.content);
      if (
        normalizedPath !== file.path ||
        snapshotPaths.has(normalizedPath) ||
        containsLikelySecret(file.content) ||
        actualSize !== file.size ||
        contentSha256(file.content) !== file.sha256
      ) {
        throw new ProtocolError(
          400,
          "invalid_workspace_file",
          "Host workspace file is not eligible for the shared snapshot",
        );
      }
      snapshotPaths.add(normalizedPath);
      snapshotBytes += actualSize;
    }
    if (
      input.files.length > MAX_WORKSPACE_FILE_COUNT ||
      snapshotBytes > MAX_WORKSPACE_FILE_BYTES
    ) {
      throw new ProtocolError(
        413,
        "workspace_capacity_exceeded",
        "The shared workspace file snapshot exceeds the session limit",
      );
    }
    const syncedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const incomingPaths = new Set(input.files.map((file) => file.path));
      const existingPaths = this.db
        .prepare("SELECT path FROM workspace_files WHERE session_id = ?")
        .all(sessionId) as unknown as Array<{ path: string }>;
      const deleteFile = this.db.prepare(
        "DELETE FROM workspace_files WHERE session_id = ? AND path = ?",
      );
      for (const existing of existingPaths) {
        if (!incomingPaths.has(existing.path)) {
          deleteFile.run(sessionId, existing.path);
        }
      }
      const upsertFile = this.db.prepare(`
        INSERT INTO workspace_files
          (session_id, path, size, modified_at, sha256, content)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET
          size = excluded.size,
          modified_at = excluded.modified_at,
          sha256 = excluded.sha256,
          content = excluded.content
        WHERE workspace_files.size <> excluded.size
           OR workspace_files.modified_at <> excluded.modified_at
           OR workspace_files.sha256 <> excluded.sha256
           OR workspace_files.content <> excluded.content
      `);
      for (const file of input.files) {
        upsertFile.run(
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

  publishWorkspaceHistory(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
    },
  ): WorkspaceSummary {
    this.requireCurrentHost(sessionId, memberToken);
    const state = this.workspaceState(sessionId);
    if (!state?.selected_thread_id || state.selected_thread_id !== input.threadId) {
      throw new ProtocolError(
        409,
        "thread_not_selected",
        "The owner must select this Codex task before its history can be imported",
      );
    }
    const syncedAt = now();
    this.db
      .prepare(`
        UPDATE workspace_state SET history_json = ?, synced_at = ?
        WHERE session_id = ?
      `)
      .run(JSON.stringify(input.history), syncedAt, sessionId);
    return this.getWorkspace(sessionId, memberToken);
  }

  publishCodexRuntimeStatus(
    sessionId: string,
    memberToken: string,
    status: CodexRuntimeStatus,
  ): { workspace: WorkspaceSummary; changed: boolean } {
    this.requireCurrentHost(sessionId, memberToken);
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
    if (!state?.host_token_id || !state.host_generation) {
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
        SELECT path, size, modified_at, sha256
        FROM workspace_files WHERE session_id = ? ORDER BY path ASC
      `)
      .all(sessionId) as unknown as WorkspaceFileMetadataRow[];
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
    this.requireBrowserMember(sessionId, memberToken, true);
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

  createWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    input:
      | { kind: "read"; path: string }
      | { kind: "write"; path: string; content: string; expectedSha256: string },
  ): WorkspaceFileOperation {
    const member = this.requireBrowserMember(sessionId, memberToken, true);
    const state = this.workspaceState(sessionId);
    if (!state?.host_generation || !state.host_token_id) {
      throw new ProtocolError(409, "host_not_paired", "Pair the local Codex host first");
    }
    if (!state.selected_thread_id) {
      throw new ProtocolError(
        409,
        "workspace_thread_not_selected",
        "Select a Codex task before opening or editing workspace files",
      );
    }
    const path = normalizeWorkspaceOperationPath(input.path);
    if (codexConfigRelativePath(path) && input.kind !== "read") {
      throw new ProtocolError(
        403,
        "workspace_file_not_shared",
        "Codex configuration is read-only in the collaboration editor",
      );
    }
    if (input.kind === "write") {
      this.requireRoomOpen(sessionId);
      if (member.role !== "owner" && member.workspaceFileAccess !== "workspace-write") {
        throw new ProtocolError(
          403,
          "workspace_read_only",
          "The owner has not granted this member workspace write access",
        );
      }
      const contentBytes = Buffer.byteLength(input.content);
      if (contentBytes > 2_000_000) {
        throw new ProtocolError(
          413,
          "workspace_file_too_large",
          "File exceeds the 2 MB collaboration write limit",
        );
      }
      if (input.content.includes("\0")) {
        throw new ProtocolError(
          400,
          "workspace_binary_file_unsupported",
          "The web editor supports text files only",
        );
      }
      if (containsLikelySecret(input.content)) {
        throw new ProtocolError(
          403,
          "workspace_file_not_shared",
          "This file is not available to the collaboration editor",
        );
      }
      if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
        throw new ProtocolError(
          400,
          "invalid_expected_sha256",
          "expectedSha256 must be the observed SHA-256 hash of an existing shared file",
        );
      }
      const existing = this.db
        .prepare("SELECT 1 AS present FROM workspace_files WHERE session_id = ? AND path = ?")
        .get(sessionId, path) as { present: number } | undefined;
      if (!existing) {
        throw new ProtocolError(
          404,
          "workspace_file_not_found",
          "Only files already present in the shared workspace can be edited",
        );
      }
    }

    const operationId = randomUUID();
    const requestedAt = now();
    if (input.kind === "write") {
      this.assertWorkspaceWriteAdmission(
        sessionId,
        member.id,
        path,
        Buffer.byteLength(input.content),
        requestedAt,
      );
    }
    const activeForMember = this.db
      .prepare(`
        SELECT COUNT(*) AS count FROM workspace_file_operations
        WHERE session_id = ? AND requested_by_member_id = ?
          AND status IN ('queued', 'processing')
      `)
      .get(sessionId, member.id) as { count: number };
    const activeForSession = this.db
      .prepare(`
        SELECT COUNT(*) AS count FROM workspace_file_operations
        WHERE session_id = ? AND status IN ('queued', 'processing')
      `)
      .get(sessionId) as { count: number };
    if (
      activeForMember.count >= MAX_ACTIVE_FILE_OPERATIONS_PER_MEMBER ||
      activeForSession.count >= MAX_ACTIVE_FILE_OPERATIONS_PER_SESSION
    ) {
      throw new ProtocolError(
        429,
        "workspace_operation_limit",
        "Wait for existing workspace file operations to finish",
      );
    }
    this.db
      .prepare(`
        INSERT INTO workspace_file_operations
          (id, session_id, requested_by_member_id, requested_by_display_name,
           host_generation, kind, path, request_content, request_size,
           expected_sha256, status, requested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `)
      .run(
        operationId,
        sessionId,
        member.id,
        member.displayName,
        state.host_generation,
        input.kind,
        path,
        input.kind === "write" ? input.content : null,
        input.kind === "write" ? Buffer.byteLength(input.content) : null,
        input.kind === "write" ? input.expectedSha256 : null,
        requestedAt,
      );
    return this.workspaceFileOperationById(sessionId, operationId);
  }

  listWorkspaceFileOperations(
    sessionId: string,
    memberToken: string,
    limit = 100,
  ): WorkspaceFileOperation[] {
    const member = this.requireBrowserMember(sessionId, memberToken, true);
    const rows = (member.role === "owner"
      ? this.db
          .prepare(`
            SELECT * FROM workspace_file_operations
            WHERE session_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?
          `)
          .all(sessionId, limit)
      : this.db
          .prepare(`
            SELECT * FROM workspace_file_operations
            WHERE session_id = ? AND requested_by_member_id = ?
            ORDER BY requested_at DESC, id DESC LIMIT ?
          `)
          .all(sessionId, member.id, limit)) as unknown as WorkspaceFileOperationRow[];
    return rows.map((row) => this.toWorkspaceFileOperation(row, false));
  }

  getWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    operationId: string,
  ): WorkspaceFileOperation {
    const member = this.requireBrowserMember(sessionId, memberToken, true);
    const operation = this.workspaceFileOperationById(sessionId, operationId);
    if (
      member.role !== "owner" &&
      operation.requestedByMemberId !== member.id
    ) {
      throw new ProtocolError(
        403,
        "workspace_operation_private",
        "Only the requester or owner can read this file operation",
      );
    }
    return operation;
  }

  claimNextWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
  ): {
    operation: WorkspaceFileOperationClaim | null;
    rejected: WorkspaceFileOperation[];
  } {
    const host = this.requireCurrentHost(sessionId, memberToken);
    // A claim is the host's bounded authorization lease. Permission and current-host
    // generation are rechecked when claiming; a stale worker cannot later complete it.
    const staleBefore = new Date(Date.now() - FILE_OPERATION_LEASE_MS).toISOString();
    const claimedAt = now();
    const rejected: WorkspaceFileOperation[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET status = 'queued', started_at = NULL, lease_id = NULL,
              lease_expires_at = NULL, lease_confirmed_at = NULL
          WHERE session_id = ? AND host_generation = ?
            AND status = 'processing' AND started_at < ?
        `)
        .run(sessionId, host.generation, staleBefore);

      for (;;) {
        const row = this.db
          .prepare(`
            SELECT * FROM workspace_file_operations
            WHERE session_id = ? AND host_generation = ? AND status = 'queued'
            ORDER BY requested_at ASC, id ASC LIMIT 1
          `)
          .get(sessionId, host.generation) as WorkspaceFileOperationRow | undefined;
        if (!row) {
          this.db.exec("COMMIT");
          return { operation: null, rejected };
        }
        const requester = this.db
          .prepare(`
            SELECT id, session_id, display_name, device_label, role, status,
                   workspace_file_access, created_at, approved_at
            FROM members WHERE session_id = ? AND id = ?
          `)
          .get(sessionId, row.requested_by_member_id) as MemberRow | undefined;
        const allowed =
          requester?.status === "approved" &&
          (row.kind === "read" ||
            requester.role === "owner" ||
            requester.workspace_file_access === "workspace-write");
        if (!allowed) {
          const errorCode =
            requester?.status === "approved"
              ? "workspace_read_only"
              : "member_not_approved";
          const errorMessage =
            errorCode === "workspace_read_only"
              ? "Workspace write access was removed before the host processed this operation"
              : "The requesting member is no longer approved";
          this.db
            .prepare(`
              UPDATE workspace_file_operations
              SET status = 'failed', request_content = NULL,
                  error_code = ?, error_message = ?, completed_at = ?
              WHERE id = ? AND status = 'queued'
            `)
            .run(errorCode, errorMessage, claimedAt, row.id);
          rejected.push(this.workspaceFileOperationById(sessionId, row.id));
          continue;
        }
        const leaseId = randomUUID();
        const leaseExpiresAt = new Date(Date.now() + FILE_OPERATION_LEASE_MS).toISOString();
        const claimed = this.db
          .prepare(`
            UPDATE workspace_file_operations
            SET status = 'processing', started_at = ?, lease_id = ?, lease_expires_at = ?,
                lease_confirmed_at = NULL, error_code = NULL, error_message = NULL
            WHERE id = ? AND session_id = ? AND host_generation = ? AND status = 'queued'
          `)
          .run(claimedAt, leaseId, leaseExpiresAt, row.id, sessionId, host.generation);
        if (claimed.changes !== 1) continue;
        const current = this.workspaceFileOperationRowById(sessionId, row.id);
        this.db.exec("COMMIT");
        return {
          operation: {
            ...this.toWorkspaceFileOperation(current),
            expectedSha256: null,
            leaseId,
            leaseExpiresAt,
          },
          rejected,
        };
      }
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  confirmWorkspaceFileOperationLease(
    sessionId: string,
    memberToken: string,
    operationId: string,
    leaseId: string,
  ): WorkspaceFileOperationConfirmation {
    const host = this.requireCurrentHost(sessionId, memberToken);
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const row = this.workspaceFileOperationRowById(sessionId, operationId);
      const confirmedAt = now();
      if (
        row.status !== "processing" ||
        row.host_generation !== host.generation ||
        row.lease_id !== leaseId ||
        !row.lease_expires_at ||
        Date.parse(row.lease_expires_at) <= Date.parse(confirmedAt)
      ) {
        throw new ProtocolError(
          409,
          "workspace_operation_lease_expired",
          "The workspace file operation lease expired before host execution",
        );
      }
      const permissionError = this.workspaceOperationPermissionError(row);
      if (permissionError) {
        this.db
          .prepare(`
            UPDATE workspace_file_operations
            SET status = 'failed', request_content = NULL, lease_id = NULL,
                lease_expires_at = NULL, lease_confirmed_at = NULL,
                error_code = ?, error_message = ?, completed_at = ?
            WHERE id = ? AND session_id = ? AND status = 'processing'
              AND host_generation = ? AND lease_id = ?
          `)
          .run(
            permissionError.code,
            permissionError.message,
            confirmedAt,
            operationId,
            sessionId,
            host.generation,
            leaseId,
          );
        this.db.exec("COMMIT");
        transactionOpen = false;
        throw new ProtocolError(403, permissionError.code, permissionError.message);
      }
      if (row.kind === "write") {
        if (row.request_content === null || row.expected_sha256 === null) {
          throw new ProtocolError(
            409,
            "invalid_workspace_operation",
            "The queued write operation is missing required data",
          );
        }
        const existing = this.db
          .prepare("SELECT 1 AS present FROM workspace_files WHERE session_id = ? AND path = ?")
          .get(sessionId, row.path) as { present: number } | undefined;
        if (!existing) {
          this.db
            .prepare(`
              UPDATE workspace_file_operations
              SET status = 'failed', request_content = NULL, lease_id = NULL,
                  lease_expires_at = NULL, lease_confirmed_at = NULL,
                  error_code = 'workspace_file_not_found',
                  error_message = 'The file is no longer present in the shared workspace',
                  completed_at = ?
              WHERE id = ? AND session_id = ? AND status = 'processing'
                AND host_generation = ? AND lease_id = ?
            `)
            .run(confirmedAt, operationId, sessionId, host.generation, leaseId);
          this.db.exec("COMMIT");
          transactionOpen = false;
          throw new ProtocolError(
            409,
            "workspace_file_not_found",
            "The file is no longer present in the shared workspace",
          );
        }
        this.assertWorkspaceFileCapacity(
          sessionId,
          row.path,
          Buffer.byteLength(row.request_content),
        );
      }
      const confirmed = this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET lease_confirmed_at = COALESCE(lease_confirmed_at, ?)
          WHERE id = ? AND session_id = ? AND status = 'processing'
            AND host_generation = ? AND lease_id = ? AND lease_expires_at > ?
        `)
        .run(
          confirmedAt,
          operationId,
          sessionId,
          host.generation,
          leaseId,
          confirmedAt,
        );
      if (confirmed.changes !== 1) {
        throw new ProtocolError(
          409,
          "workspace_operation_lease_expired",
          "The workspace file operation lease expired before host execution",
        );
      }
      const current = this.workspaceFileOperationRowById(sessionId, operationId);
      this.db.exec("COMMIT");
      transactionOpen = false;
      return {
        ...this.toWorkspaceFileOperation(current),
        leaseId,
        leaseExpiresAt: current.lease_expires_at!,
        requestContent: current.request_content,
      };
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private backfillInFlightMessageThreadIds(): void {
    const migratedAt = now();
    this.db.exec(`
      UPDATE messages
      SET selected_thread_id = (
        SELECT workspace_state.selected_thread_id
        FROM workspace_state
        WHERE workspace_state.session_id = messages.session_id
      )
      WHERE selected_thread_id IS NULL
        AND kind IN ('codex_prompt', 'codex_stop')
        AND delivery_status IN ('queued', 'submitted')
        AND EXISTS (
          SELECT 1 FROM workspace_state
          WHERE workspace_state.session_id = messages.session_id
            AND workspace_state.selected_thread_id IS NOT NULL
        )
    `);
    this.db
      .prepare(`
        UPDATE messages
        SET delivery_status = 'failed',
            codex_turn_id = 'migration:no-selected-workspace-task',
            completed_at = ?
        WHERE selected_thread_id IS NULL
          AND kind IN ('codex_prompt', 'codex_stop')
          AND delivery_status IN ('queued', 'submitted')
      `)
      .run(migratedAt);
  }

  private disconnectUnboundLegacyHosts(): void {
    const disconnectedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET status = 'failed', request_content = NULL, result_content = NULL,
              lease_id = NULL, lease_expires_at = NULL, lease_confirmed_at = NULL,
              error_code = 'host_repair_required',
              error_message = 'Pair the Codex host again after upgrading',
              completed_at = COALESCE(completed_at, ?)
          WHERE status IN ('queued', 'processing')
            AND session_id IN (
              SELECT session_id FROM workspace_state
              WHERE host_token_id IS NULL OR host_generation IS NULL
            )
        `)
        .run(disconnectedAt);
      this.db
        .prepare(`
          UPDATE host_pairings SET used_at = ?
          WHERE used_at IS NULL AND session_id IN (
            SELECT session_id FROM workspace_state
            WHERE host_token_id IS NULL OR host_generation IS NULL
          )
        `)
        .run(disconnectedAt);
      this.db.exec(`
        DELETE FROM workspace_files
        WHERE session_id IN (
          SELECT session_id FROM workspace_state
          WHERE host_token_id IS NULL OR host_generation IS NULL
        );
        UPDATE workspace_state
        SET catalog_json = '[]', selected_thread_id = NULL, history_json = '[]',
            codex_runtime_status = 'unavailable', synced_at = NULL
        WHERE host_token_id IS NULL OR host_generation IS NULL;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    operationId: string,
    input:
      | { status: "completed"; leaseId: string; file: WorkspaceFileContent }
      | {
          status: "failed";
          leaseId: string;
          errorCode: string;
          errorMessage: string;
          file?: WorkspaceFileContent | null;
        },
  ): WorkspaceFileOperation {
    const host = this.requireCurrentHost(sessionId, memberToken);
    const row = this.workspaceFileOperationRowById(sessionId, operationId);
    if (
      row.status !== "processing" ||
      row.host_generation !== host.generation ||
      row.lease_id !== input.leaseId ||
      !row.lease_expires_at ||
      !row.lease_confirmed_at ||
      Date.parse(row.lease_expires_at) <= Date.now()
    ) {
      throw new ProtocolError(
        409,
        "workspace_operation_not_processing",
        "The file operation is not currently claimed by the host",
      );
    }
    const permissionError = this.workspaceOperationPermissionError(row);
    if (permissionError) {
      throw new ProtocolError(403, permissionError.code, permissionError.message);
    }
    const file = input.file ?? null;
    if (file) {
      const normalizedPath = normalizeWorkspaceOperationPath(file.path);
      if (normalizedPath !== row.path) {
        throw new ProtocolError(
          400,
          "workspace_operation_path_mismatch",
          "The host result path does not match the requested path",
        );
      }
      const size = Buffer.byteLength(file.content);
      if (size > 2_000_000 || size !== file.size) {
        throw new ProtocolError(400, "invalid_workspace_file", "Host file size is invalid");
      }
      if (contentSha256(file.content) !== file.sha256) {
        throw new ProtocolError(400, "invalid_workspace_file", "Host file hash is invalid");
      }
      if (Number.isNaN(Date.parse(file.modifiedAt))) {
        throw new ProtocolError(
          400,
          "invalid_workspace_file",
          "Host file modification time is invalid",
        );
      }
      if (containsLikelySecret(file.content)) {
        throw new ProtocolError(
          403,
          "workspace_file_not_shared",
          "This file is not available to the collaboration editor",
        );
      }
    }
    const errorCode =
      input.status === "failed" ? input.errorCode.trim().slice(0, 120) : null;
    const errorMessage =
      input.status === "failed" ? input.errorMessage.trim().slice(0, 1_000) : null;
    if (input.status === "failed" && (!errorCode || !errorMessage)) {
      throw new ProtocolError(
        400,
        "invalid_workspace_operation_result",
        "Failed operations require an error code and message",
      );
    }
    const completedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (file) {
        this.assertWorkspaceFileCapacity(sessionId, row.path, file.size);
      }
      const updated = this.db
        .prepare(`
          UPDATE workspace_file_operations
          SET status = ?, request_content = NULL,
              result_content = ?, result_size = ?, result_modified_at = ?, result_sha256 = ?,
              error_code = ?, error_message = ?, completed_at = ?, lease_id = NULL,
              lease_expires_at = NULL, lease_confirmed_at = NULL
          WHERE id = ? AND session_id = ? AND host_generation = ?
            AND status = 'processing' AND lease_id = ? AND lease_expires_at > ?
            AND lease_confirmed_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM members requester
              WHERE requester.session_id = workspace_file_operations.session_id
                AND requester.id = workspace_file_operations.requested_by_member_id
                AND requester.status = 'approved'
                AND (
                  workspace_file_operations.kind = 'read'
                  OR requester.role = 'owner'
                  OR requester.workspace_file_access = 'workspace-write'
                )
            )
        `)
        .run(
          input.status,
          file?.content ?? null,
          file?.size ?? null,
          file?.modifiedAt ?? null,
          file?.sha256 ?? null,
          errorCode,
          errorMessage,
          completedAt,
          operationId,
          sessionId,
          host.generation,
          input.leaseId,
          completedAt,
        );
      if (updated.changes !== 1) {
        throw new ProtocolError(
          409,
          "workspace_operation_not_processing",
          "The file operation is no longer claimed by the host",
        );
      }
      if (file) {
        this.db
          .prepare(`
            INSERT INTO workspace_files
              (session_id, path, size, modified_at, sha256, content)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, path) DO UPDATE SET
              size = excluded.size,
              modified_at = excluded.modified_at,
              sha256 = excluded.sha256,
              content = excluded.content
          `)
          .run(
            sessionId,
            file.path,
            file.size,
            file.modifiedAt,
            file.sha256,
            file.content,
          );
      }
      this.enforceWorkspaceFileOperationRetention(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.workspaceFileOperationById(sessionId, operationId);
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

  private messageById(sessionId: string, messageId: string): Message {
    const row = this.db
      .prepare(`
        SELECT m.id, m.session_id, m.sender_member_id, mb.display_name AS sender_display_name,
               m.kind, m.body, m.codex_options_json, m.delivery_status,
               m.codex_turn_id, m.selected_thread_id, m.completed_at, m.created_at
        FROM messages m JOIN members mb ON mb.id = m.sender_member_id
        WHERE m.session_id = ? AND m.id = ?
      `)
      .get(sessionId, messageId) as MessageRow | undefined;
    if (!row) {
      throw new ProtocolError(404, "message_not_found", "Message was not found");
    }
    return this.toMessages([row])[0]!;
  }

  private toMessages(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const attachmentRows = this.db
      .prepare(`
        SELECT id, message_id, name, media_type, size
        FROM message_attachments
        WHERE message_id IN (${placeholders})
        ORDER BY rowid ASC
      `)
      .all(...rows.map((row) => row.id)) as unknown as MessageAttachmentMetadataRow[];
    const attachmentsByMessage = new Map<string, MessageAttachment[]>();
    for (const attachment of attachmentRows) {
      const attachments = attachmentsByMessage.get(attachment.message_id) ?? [];
      attachments.push({
        id: attachment.id,
        name: attachment.name,
        mediaType: attachment.media_type,
        size: attachment.size,
      });
      attachmentsByMessage.set(attachment.message_id, attachments);
    }
    return rows.map((row) => this.toMessage(row, attachmentsByMessage.get(row.id) ?? []));
  }

  private toMessage(row: MessageRow, attachments: MessageAttachment[]): Message {
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
      workspaceThreadId: row.selected_thread_id,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  }

  private accountById(accountId: string): Account {
    const row = this.db
      .prepare("SELECT id, display_name, created_at FROM accounts WHERE id = ?")
      .get(accountId) as AccountRow | undefined;
    if (!row) {
      throw new ProtocolError(401, "account_required", "Account sign-in is required");
    }
    return toAccount(row);
  }

  private createAccountSession(accountId: string): {
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

  private insertAccountMemberToken(
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

  private memberById(sessionId: string, memberId: string): Member {
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

  private requireMember(
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

  private requireOwner(sessionId: string, memberToken: string): Member {
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

  private requireBrowserMember(
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

  private requireCurrentHost(
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
    const tokenHash = hashToken(memberToken);
    const state = this.workspaceState(sessionId);
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
      .get(sessionId, owner.id, tokenHash) as { id: string } | undefined;
    if (token?.id !== state.host_token_id) {
      throw new ProtocolError(
        403,
        "current_host_required",
        "Only the currently paired host can publish or process workspace data",
      );
    }
    return { tokenId: token.id, generation: state.host_generation };
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

  private workspaceFileOperationRowById(
    sessionId: string,
    operationId: string,
  ): WorkspaceFileOperationRow {
    const row = this.db
      .prepare(`
        SELECT * FROM workspace_file_operations
        WHERE session_id = ? AND id = ?
      `)
      .get(sessionId, operationId) as WorkspaceFileOperationRow | undefined;
    if (!row) {
      throw new ProtocolError(
        404,
        "workspace_operation_not_found",
        "Workspace file operation was not found",
      );
    }
    return row;
  }

  private assertWorkspaceWriteAdmission(
    sessionId: string,
    memberId: string,
    path: string,
    contentBytes: number,
    requestedAt: string,
  ): void {
    const cutoff = new Date(Date.parse(requestedAt) - 60_000).toISOString();
    const recent = this.db
      .prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(request_size), 0) AS bytes
        FROM workspace_file_operations
        WHERE session_id = ? AND requested_by_member_id = ? AND kind = 'write'
          AND requested_at >= ?
      `)
      .get(sessionId, memberId, cutoff) as { count: number; bytes: number };
    if (
      recent.count >= MAX_MEMBER_WRITE_OPERATIONS_PER_MINUTE ||
      recent.bytes + contentBytes > MAX_MEMBER_WRITE_BYTES_PER_MINUTE
    ) {
      throw new ProtocolError(
        429,
        "workspace_write_rate_limit",
        "Wait before sending more workspace file changes",
      );
    }

    const projected = new Map(
      (
        this.db
          .prepare("SELECT path, size FROM workspace_files WHERE session_id = ?")
          .all(sessionId) as unknown as Array<{ path: string; size: number }>
      ).map((file) => [file.path, file.size]),
    );
    const activeWrites = this.db
      .prepare(`
        SELECT path, LENGTH(CAST(request_content AS BLOB)) AS content_bytes
        FROM workspace_file_operations
        WHERE session_id = ? AND kind = 'write'
          AND status IN ('queued', 'processing') AND request_content IS NOT NULL
      `)
      .all(sessionId) as unknown as Array<{ path: string; content_bytes: number }>;
    for (const active of activeWrites) projected.set(active.path, active.content_bytes);
    projected.set(path, contentBytes);
    const projectedBytes = [...projected.values()].reduce((total, size) => total + size, 0);
    if (
      projected.size > MAX_WORKSPACE_FILE_COUNT ||
      projectedBytes > MAX_WORKSPACE_FILE_BYTES
    ) {
      throw new ProtocolError(
        413,
        "workspace_capacity_exceeded",
        "The shared workspace has reached its file storage limit",
      );
    }
  }

  private workspaceOperationPermissionError(
    row: WorkspaceFileOperationRow,
  ): { code: string; message: string } | null {
    const requester = this.db
      .prepare(`
        SELECT status, role, workspace_file_access
        FROM members WHERE session_id = ? AND id = ?
      `)
      .get(row.session_id, row.requested_by_member_id) as
      | Pick<MemberRow, "status" | "role" | "workspace_file_access">
      | undefined;
    if (requester?.status !== "approved") {
      return {
        code: "member_not_approved",
        message: "The requesting member is no longer approved",
      };
    }
    if (
      row.kind === "write" &&
      requester.role !== "owner" &&
      requester.workspace_file_access !== "workspace-write"
    ) {
      return {
        code: "workspace_read_only",
        message: "Workspace write access was removed before host execution",
      };
    }
    return null;
  }

  private assertWorkspaceFileCapacity(
    sessionId: string,
    path: string,
    contentBytes: number,
  ): void {
    const current = this.db
      .prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes,
               COALESCE(MAX(CASE WHEN path = ? THEN size END), 0) AS replaced_bytes,
               MAX(CASE WHEN path = ? THEN 1 ELSE 0 END) AS path_exists
        FROM workspace_files WHERE session_id = ?
      `)
      .get(path, path, sessionId) as {
      count: number;
      bytes: number;
      replaced_bytes: number;
      path_exists: number;
    };
    const nextCount = current.count + (current.path_exists ? 0 : 1);
    const nextBytes = current.bytes - current.replaced_bytes + contentBytes;
    if (nextCount > MAX_WORKSPACE_FILE_COUNT || nextBytes > MAX_WORKSPACE_FILE_BYTES) {
      throw new ProtocolError(
        413,
        "workspace_capacity_exceeded",
        "The shared workspace has reached its file storage limit",
      );
    }
  }

  private enforceWorkspaceFileOperationRetention(sessionId: string): void {
    const rows = this.db
      .prepare(`
        SELECT id, LENGTH(CAST(result_content AS BLOB)) AS content_bytes
        FROM workspace_file_operations
        WHERE session_id = ? AND result_content IS NOT NULL
        ORDER BY completed_at DESC, requested_at DESC, id DESC
      `)
      .all(sessionId) as unknown as Array<{ id: string; content_bytes: number }>;
    let retainedCount = 0;
    let retainedBytes = 0;
    const clearResult = this.db.prepare(`
      UPDATE workspace_file_operations SET result_content = NULL WHERE id = ?
    `);
    for (const row of rows) {
      const nextCount = retainedCount + 1;
      const nextBytes = retainedBytes + row.content_bytes;
      if (
        nextCount > MAX_FILE_OPERATION_RESULT_CONTENT_COUNT ||
        nextBytes > MAX_FILE_OPERATION_RESULT_CONTENT_BYTES
      ) {
        clearResult.run(row.id);
        continue;
      }
      retainedCount = nextCount;
      retainedBytes = nextBytes;
    }
    this.db
      .prepare(`
        DELETE FROM workspace_file_operations
        WHERE id IN (
          SELECT id FROM workspace_file_operations
          WHERE session_id = ? AND status IN ('completed', 'failed')
          ORDER BY completed_at DESC, requested_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(sessionId, MAX_FILE_OPERATION_AUDIT_ROWS_PER_SESSION);
  }

  private workspaceFileOperationById(
    sessionId: string,
    operationId: string,
  ): WorkspaceFileOperation {
    return this.toWorkspaceFileOperation(
      this.workspaceFileOperationRowById(sessionId, operationId),
    );
  }

  private toWorkspaceFileOperation(
    row: WorkspaceFileOperationRow,
    includeResultContent = true,
  ): WorkspaceFileOperation {
    const resultFileMetadata =
      row.result_size !== null &&
      row.result_modified_at !== null &&
      row.result_sha256 !== null
        ? {
            path: row.path,
            size: row.result_size,
            modifiedAt: row.result_modified_at,
            sha256: row.result_sha256,
          }
        : null;
    const resultFile =
      includeResultContent && row.result_content !== null && resultFileMetadata
        ? { ...resultFileMetadata, content: row.result_content }
        : null;
    return {
      id: row.id,
      sessionId: row.session_id,
      requestedByMemberId: row.requested_by_member_id,
      requestedByDisplayName: row.requested_by_display_name,
      hostGeneration: row.host_generation ?? "",
      kind: row.kind,
      path: row.path,
      expectedSha256: row.expected_sha256,
      status: row.status,
      resultFileMetadata,
      resultFile,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      requestedAt: row.requested_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  private workspaceState(sessionId: string): WorkspaceStateRow | undefined {
    return this.db
      .prepare(`
        SELECT session_id, host_device_label, root_label, catalog_json, selected_thread_id,
               host_token_id, host_generation, history_json, codex_runtime_status, synced_at
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

  private toWorkspaceFile(row: WorkspaceFileMetadataRow): WorkspaceFile {
    return {
      path: row.path,
      size: row.size,
      modifiedAt: row.modified_at,
      sha256: row.sha256,
    };
  }
}
