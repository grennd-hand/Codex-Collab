import { randomUUID } from "node:crypto";
import {
  type CodexPromptOptions,
  type Message,
  type MessageAttachment,
  type MessageDeliveryStatus,
  type MessageKind,
  ProtocolError,
} from "@codex-collab/protocol";
import { RoomMemberStore } from "./room-member-store.js";
import {
  type MessageAttachmentMetadataRow,
  type MessageAttachmentRow,
  type MessageRow,
  now,
} from "../storage/session-store-types.js";

export class MessageStore extends RoomMemberStore {
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
      expectedWorkspaceThreadId?: string;
    } = {},
  ): Message {
    const sender = this.requireMember(sessionId, memberToken, true);
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
    const expectedWorkspaceThreadId = input.expectedWorkspaceThreadId?.trim() || null;
    if (kind === "codex_prompt" && !expectedWorkspaceThreadId) {
      throw new ProtocolError(
        400,
        "invalid_request",
        "expectedWorkspaceThreadId is required for Codex prompts",
      );
    }
    const messageId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (kind === "chat" || kind === "codex_prompt") {
        this.requireRoomOpen(sessionId);
      }
      const workspaceThreadId =
        kind === "codex_prompt" || kind === "codex_stop"
          ? this.selectedWorkspaceThreadId(sessionId)
          : null;
      if (
        kind === "codex_prompt" &&
        workspaceThreadId !== expectedWorkspaceThreadId
      ) {
        throw new ProtocolError(
          409,
          "stale_workspace_thread",
          "The selected Codex task changed before the prompt was submitted",
        );
      }
      if ((kind === "codex_prompt" || kind === "codex_stop") && !workspaceThreadId) {
        throw new ProtocolError(
          409,
          "workspace_thread_not_selected",
          "Select a Codex task before sending a Codex command",
        );
      }
      const message: Message = {
        id: messageId,
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
    return this.messageById(sessionId, messageId);
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

  protected updateMessageDeliveryStatusAuthorized(
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


  protected messageById(sessionId: string, messageId: string): Message {
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

  protected toMessages(rows: MessageRow[]): Message[] {
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

  protected toMessage(row: MessageRow, attachments: MessageAttachment[]): Message {
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
}
