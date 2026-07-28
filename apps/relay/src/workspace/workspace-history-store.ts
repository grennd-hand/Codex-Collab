import {
  type CodexRecordEntry,
  type CodexRuntimeStatus,
  type CodexThreadCatalogEntry,
  type WorkspaceFileContent,
  type WorkspaceSummary,
  type WorkspaceSyncState,
  containsLikelySecret,
  ProtocolError,
} from "@codex-collab/protocol";
import { WorkspaceHistoryQueryStore } from "./workspace-history-query-store.js";
import {
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILE_COUNT,
  contentSha256,
  normalizeWorkspaceOperationPath,
  now,
} from "../storage/session-store-types.js";

export class WorkspaceHistoryStore extends WorkspaceHistoryQueryStore {
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
    const sameWorkspaceRoot =
      current?.host_device_label === input.deviceLabel &&
      current.root_label === input.rootLabel;
    const selectedStillExists =
      sameWorkspaceRoot &&
      current?.selected_thread_id &&
      input.threads.some((thread) => thread.id === current.selected_thread_id);
    const selectedThreadId = selectedStillExists ? current.selected_thread_id : null;
    const historyJson = selectedStillExists ? current?.history_json ?? "[]" : "[]";
    const historyCount = selectedStillExists ? current?.history_count ?? 0 : 0;
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
             catalog_json, selected_thread_id, history_json, history_count,
             codex_runtime_status, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            host_device_label = excluded.host_device_label,
            root_label = excluded.root_label,
            host_token_id = excluded.host_token_id,
            host_generation = excluded.host_generation,
            catalog_json = excluded.catalog_json,
            selected_thread_id = excluded.selected_thread_id,
            history_json = excluded.history_json,
            history_count = excluded.history_count,
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
          historyCount,
          codexRuntimeStatus,
          syncedAt,
        );
      if (!sameWorkspaceRoot) {
        this.db.prepare("DELETE FROM workspace_files WHERE session_id = ?").run(sessionId);
        this.clearWorkspaceDirectories(sessionId);
        this.clearWorkspaceThreadHistories(sessionId);
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

  protected selectWorkspaceThreadAuthorized(
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
    const cached = this.workspaceThreadHistory(sessionId, threadId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE workspace_state
          SET selected_thread_id = ?, history_json = ?, history_count = ?,
              codex_runtime_status = 'unavailable', synced_at = ?
          WHERE session_id = ?
        `)
        .run(
          threadId,
          cached?.history_json ?? "[]",
          cached?.history_count ?? 0,
          cached?.synced_at ?? null,
          sessionId,
        );
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
      directories?: string[];
    },
  ): WorkspaceSummary;
  publishWorkspaceSnapshot(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
      files: WorkspaceFileContent[];
      directories?: string[];
    },
    returnMinimal: true,
  ): WorkspaceSyncState;
  publishWorkspaceSnapshot(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
      files: WorkspaceFileContent[];
      directories?: string[];
    },
    returnMinimal = false,
  ): WorkspaceSummary | WorkspaceSyncState {
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
    const requestedDirectories = input.directories ?? [];
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
      this.replaceWorkspaceDirectories(sessionId, requestedDirectories);
      this.upsertWorkspaceThreadHistory(
        sessionId,
        input.threadId,
        input.history,
        syncedAt,
      );
      this.db
        .prepare(`
          UPDATE workspace_state SET history_json = ?, history_count = ?, synced_at = ?
          WHERE session_id = ?
        `)
        .run(JSON.stringify(input.history), input.history.length, syncedAt, sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return returnMinimal
      ? this.getWorkspaceSyncState(sessionId, memberToken)
      : this.getWorkspace(sessionId, memberToken);
  }

  publishWorkspaceHistory(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
    },
  ): WorkspaceSummary;
  publishWorkspaceHistory(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
    },
    returnMinimal: true,
  ): WorkspaceSyncState;
  publishWorkspaceHistory(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
    },
    returnMinimal = false,
  ): WorkspaceSummary | WorkspaceSyncState {
    this.requireCurrentHost(sessionId, memberToken);
    const state = this.workspaceState(sessionId);
    if (
      !state ||
      !this.parseCatalog(state.catalog_json).some((thread) => thread.id === input.threadId)
    ) {
      throw new ProtocolError(
        404,
        "thread_not_found",
        "Codex task is not in the host catalog",
      );
    }
    const syncedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.upsertWorkspaceThreadHistory(
        sessionId,
        input.threadId,
        input.history,
        syncedAt,
      );
      if (state.selected_thread_id === input.threadId) {
        this.db
          .prepare(`
            UPDATE workspace_state SET history_json = ?, history_count = ?, synced_at = ?
            WHERE session_id = ?
          `)
          .run(JSON.stringify(input.history), input.history.length, syncedAt, sessionId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return returnMinimal
      ? this.getWorkspaceSyncState(sessionId, memberToken)
      : this.getWorkspace(sessionId, memberToken);
  }

  publishCodexRuntimeStatus(
    sessionId: string,
    memberToken: string,
    status: CodexRuntimeStatus,
  ): { workspace: WorkspaceSummary; changed: boolean };
  publishCodexRuntimeStatus(
    sessionId: string,
    memberToken: string,
    status: CodexRuntimeStatus,
    returnMinimal: true,
  ): { workspace: WorkspaceSyncState; changed: boolean };
  publishCodexRuntimeStatus(
    sessionId: string,
    memberToken: string,
    status: CodexRuntimeStatus,
    returnMinimal = false,
  ): {
    workspace: WorkspaceSummary | WorkspaceSyncState;
    changed: boolean;
  } {
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
      workspace: returnMinimal
        ? this.getWorkspaceSyncState(sessionId, memberToken)
        : this.getWorkspace(sessionId, memberToken),
      changed,
    };
  }
}
