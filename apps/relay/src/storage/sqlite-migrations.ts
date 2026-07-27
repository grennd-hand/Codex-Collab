import { DatabaseSync } from "node:sqlite";
import { now } from "./session-store-types.js";
import {
  backfillInFlightMessageThreadIds,
  disconnectUnboundLegacyHosts,
} from "./legacy-data-migrations.js";
import { migrateWorkspaceOperationKinds } from "./workspace-schema-migrations.js";
export function migrateSessionStore(db: DatabaseSync): void {
    const existingMemberTokenColumns = db
      .prepare("PRAGMA table_info(member_tokens)")
      .all() as unknown as Array<{ name: string }>;
    const hadTokenPurposeColumn = existingMemberTokenColumns.some(
      (column) => column.name === "token_purpose",
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_member_id TEXT NOT NULL,
        owner_recovery_hash TEXT,
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
        history_count INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE IF NOT EXISTS workspace_directories (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        PRIMARY KEY (session_id, path)
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        key TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_file_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        requested_by_member_id TEXT NOT NULL REFERENCES members(id),
        requested_by_display_name TEXT NOT NULL,
        host_generation TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('read', 'write', 'mkdir', 'rename')),
        path TEXT NOT NULL,
        destination_path TEXT,
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
      CREATE INDEX IF NOT EXISTS workspace_directories_session_idx
        ON workspace_directories(session_id);
      CREATE INDEX IF NOT EXISTS workspace_file_operations_queue_idx
        ON workspace_file_operations(session_id, status, requested_at);
      CREATE INDEX IF NOT EXISTS workspace_file_operations_actor_idx
        ON workspace_file_operations(session_id, requested_by_member_id, requested_at);
    `);
    ensureColumn(db, 
      "account_sessions",
      "csrf_token_hash",
      "TEXT NOT NULL DEFAULT ''",
    );
    ensureColumn(db, "member_tokens", "account_session_id", "TEXT");
    ensureColumn(db, "member_tokens", "expires_at", "TEXT");
    ensureColumn(db, "member_tokens", "revoked_at", "TEXT");
    ensureColumn(db, 
      "member_tokens",
      "token_purpose",
      "TEXT NOT NULL DEFAULT 'legacy'",
    );
    ensureColumn(db, 
      "sessions",
      "room_status",
      "TEXT NOT NULL DEFAULT 'open' CHECK (room_status IN ('open', 'closed'))",
    );
    ensureColumn(db, "sessions", "owner_recovery_hash", "TEXT");
    ensureColumn(db, 
      "members",
      "workspace_file_access",
      "TEXT NOT NULL DEFAULT 'read-only' CHECK (workspace_file_access IN ('read-only', 'workspace-write'))",
    );
    db.exec("UPDATE members SET workspace_file_access = 'workspace-write' WHERE role = 'owner'");
    const approvedMemberAccessMigration = "approved-members-workspace-write-v1";
    const approvedMemberAccessApplied = db
      .prepare("SELECT 1 AS present FROM schema_migrations WHERE key = ?")
      .get(approvedMemberAccessMigration) as { present: number } | undefined;
    if (!approvedMemberAccessApplied) {
      db.exec(
        "UPDATE members SET workspace_file_access = 'workspace-write' WHERE status = 'approved'",
      );
      db.prepare("INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)").run(
        approvedMemberAccessMigration,
        now(),
      );
    }
    migrateMessagesTable(db);
    ensureColumn(db, "messages", "selected_thread_id", "TEXT");
    ensureColumn(db, 
      "workspace_state",
      "codex_runtime_status",
      "TEXT NOT NULL DEFAULT 'unavailable'",
    );
    ensureColumn(db, "workspace_state", "host_token_id", "TEXT");
    ensureColumn(db, "workspace_state", "host_generation", "TEXT");
    ensureColumn(db, 
      "workspace_state",
      "history_count",
      "INTEGER NOT NULL DEFAULT 0",
    );
    db.exec(
      "UPDATE workspace_state SET history_count = json_array_length(history_json)",
    );
    ensureColumn(db, "workspace_file_operations", "host_generation", "TEXT");
    ensureColumn(db, "workspace_file_operations", "lease_id", "TEXT");
    ensureColumn(db, "workspace_file_operations", "lease_expires_at", "TEXT");
    ensureColumn(db, "workspace_file_operations", "lease_confirmed_at", "TEXT");
    ensureColumn(db, "workspace_file_operations", "request_size", "INTEGER");
    migrateWorkspaceOperationKinds(db);
    db.exec(`
      UPDATE member_tokens
      SET token_purpose = 'account'
      WHERE account_session_id IS NOT NULL;
    `);
    if (!hadTokenPurposeColumn) {
      const repairedAt = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db
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
        db
          .prepare(`
            UPDATE member_tokens
            SET revoked_at = COALESCE(revoked_at, ?)
            WHERE account_session_id IS NULL
          `)
          .run(repairedAt);
        db.exec(`
          DELETE FROM workspace_files
          WHERE session_id IN (
            SELECT session_id FROM workspace_state
            WHERE host_token_id IS NOT NULL OR host_generation IS NOT NULL
          );
          UPDATE workspace_state
          SET host_token_id = NULL, host_generation = NULL,
              catalog_json = '[]', selected_thread_id = NULL, history_json = '[]',
              history_count = 0,
              codex_runtime_status = 'unavailable', synced_at = NULL;
        `);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    db
      .prepare(`
        UPDATE member_tokens
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE token_purpose = 'legacy' AND account_session_id IS NULL
      `)
      .run(now());
    db
      .prepare(`
        UPDATE workspace_file_operations
        SET status = 'failed', request_content = NULL, result_content = NULL,
            error_code = 'host_repaired',
            error_message = 'The host workspace changed before this operation completed',
            completed_at = COALESCE(completed_at, ?)
        WHERE host_generation IS NULL AND status IN ('queued', 'processing')
      `)
      .run(now());
    db.exec(`
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
    backfillInFlightMessageThreadIds(db);
    disconnectUnboundLegacyHosts(db);
  }

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

function migrateMessagesTable(db: DatabaseSync): void {
    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql?: string } | undefined;
    const columns = db.prepare("PRAGMA table_info(messages)").all() as unknown as Array<{
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
      db
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

    db.exec("BEGIN IMMEDIATE");
    try {
      if (hasAttachmentsTable) {
        db.exec(
          "ALTER TABLE message_attachments RENAME TO message_attachments_legacy",
        );
      }
      db.exec("ALTER TABLE messages RENAME TO messages_legacy");
      db.exec(`
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
      db.exec(`
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
        db.exec(`
          CREATE TABLE message_attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            media_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            content BLOB NOT NULL
          )
        `);
        db.exec(`
          INSERT INTO message_attachments
            (id, message_id, name, media_type, size, content)
          SELECT id, message_id, name, media_type, size, content
          FROM message_attachments_legacy
        `);
        db.exec("DROP TABLE message_attachments_legacy");
      }
      db.exec("DROP TABLE messages_legacy");
      db.exec(`
        CREATE INDEX IF NOT EXISTS messages_session_created_idx
          ON messages(session_id, created_at)
      `);
      if (hasAttachmentsTable) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS message_attachments_message_idx
            ON message_attachments(message_id)
        `);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
