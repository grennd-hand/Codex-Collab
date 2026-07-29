import { randomUUID } from "node:crypto";
import {
  type ClaimHostPairingResponse,
  type CodexThreadCatalogEntry,
  type Message,
  type MessageDeliveryStatus,
  type WorkspaceSummary,
  ProtocolError,
} from "@codex-collab/protocol";
import { hashToken, issueToken } from "../security/token.js";
import { MessageStore } from "../collaboration/message-store.js";
import {
  type HostPairingRow,
  type WorkspaceStateRow,
  now,
} from "../storage/session-store-types.js";

export class WorkspaceHostStore extends MessageStore {
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
            history_count = 0,
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
      this.db
        .prepare("DELETE FROM workspace_directories WHERE session_id = ?")
        .run(pairing.session_id);
      this.db
        .prepare("DELETE FROM workspace_thread_histories WHERE session_id = ?")
        .run(pairing.session_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { session, owner, memberToken };
  }

  protected workspaceState(sessionId: string): WorkspaceStateRow | undefined {
    return this.db
      .prepare(`
        SELECT session_id, host_device_label, root_label, catalog_json, selected_thread_id,
               host_token_id, host_generation, history_json, history_count,
               codex_runtime_status, synced_at
        FROM workspace_state WHERE session_id = ?
      `)
      .get(sessionId) as WorkspaceStateRow | undefined;
  }

  protected parseCatalog(value: string): CodexThreadCatalogEntry[] {
    return JSON.parse(value) as CodexThreadCatalogEntry[];
  }

}
