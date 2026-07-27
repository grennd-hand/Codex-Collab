import {
  type CodexRecordEntry,
  type CodexRuntimeStatus,
  type CodexThreadCatalogEntry,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceHistoryPage,
  type WorkspaceHistoryResult,
  type WorkspaceOverview,
  type WorkspaceSummary,
  type WorkspaceSyncState,
  containsLikelySecret,
  ProtocolError,
} from "@codex-collab/protocol";
import { WorkspaceHostStore } from "./workspace-host-store.js";
import { paginateWorkspaceHistory } from "./workspace-history-pagination.js";
import {
  type WorkspaceFileMetadataRow,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILE_COUNT,
  contentSha256,
  normalizeWorkspaceOperationPath,
  now,
} from "../storage/session-store-types.js";

export class WorkspaceHistoryStore extends WorkspaceHostStore {
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`
          UPDATE workspace_state
          SET selected_thread_id = ?, history_json = '[]', history_count = 0,
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
  ): WorkspaceSummary;
  publishWorkspaceSnapshot(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
      files: WorkspaceFileContent[];
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
        UPDATE workspace_state SET history_json = ?, history_count = ?, synced_at = ?
        WHERE session_id = ?
      `)
      .run(JSON.stringify(input.history), input.history.length, syncedAt, sessionId);
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

  getWorkspaceOverview(sessionId: string, memberToken: string): WorkspaceOverview {
    const member = this.requireBrowserMember(sessionId, memberToken, true);
    return this.workspaceOverview(sessionId, member.role === "owner");
  }

  getWorkspaceHistory(
    sessionId: string,
    memberToken: string,
  ): WorkspaceHistoryResult {
    this.requireBrowserMember(sessionId, memberToken, true);
    const state = this.workspaceState(sessionId);
    if (!state?.host_token_id || !state.host_generation) {
      return { selectedThreadId: null, history: [], syncedAt: null };
    }
    return {
      selectedThreadId: state.selected_thread_id,
      history: this.parseHistory(state.history_json),
      syncedAt: state.synced_at,
    };
  }

  getWorkspaceHistoryPage(
    sessionId: string,
    memberToken: string,
    options: { limit?: number; before?: string | null } = {},
  ): WorkspaceHistoryPage {
    this.requireBrowserMember(sessionId, memberToken, true);
    const state = this.workspaceState(sessionId);
    if (!state?.host_token_id || !state.host_generation || !state.selected_thread_id) {
      return {
        selectedThreadId: null,
        items: [],
        totalCount: 0,
        hasOlder: false,
        olderCursor: null,
        syncedAt: null,
      };
    }

    return paginateWorkspaceHistory({
      sessionId,
      threadId: state.selected_thread_id,
      history: this.parseHistory(state.history_json),
      syncedAt: state.synced_at,
      limit: options.limit,
      before: options.before,
    });
  }

  getWorkspaceSyncState(
    sessionId: string,
    memberToken: string,
  ): WorkspaceSyncState {
    this.requireCurrentHost(sessionId, memberToken);
    const overview = this.workspaceOverview(sessionId, true);
    const { files, ...state } = overview;
    return { ...state, fileCount: files.length };
  }

  getWorkspace(sessionId: string, memberToken: string): WorkspaceSummary {
    const member = this.requireMember(sessionId, memberToken, true);
    const overview = this.workspaceOverview(sessionId, member.role === "owner");
    const state = this.workspaceState(sessionId);
    return {
      ...overview,
      history:
        overview.hostConnected && state ? this.parseHistory(state.history_json) : [],
    };
  }

  protected workspaceOverview(
    sessionId: string,
    includeThreadCatalog: boolean,
  ): WorkspaceOverview {
    const state = this.workspaceState(sessionId);
    if (!state?.host_token_id || !state.host_generation) {
      return {
        hostConnected: false,
        hostDeviceLabel: null,
        rootLabel: null,
        threads: [],
        selectedThreadId: null,
        selectedThread: null,
        historyCount: 0,
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
      threads: includeThreadCatalog ? fullCatalog : [],
      selectedThreadId: state.selected_thread_id,
      selectedThread,
      historyCount: state.history_count,
      files: rows.map((row) => this.toWorkspaceFile(row)),
      codexRuntimeStatus: state.codex_runtime_status,
      syncedAt: state.synced_at,
    };
  }


  protected parseHistory(value: string): CodexRecordEntry[] {
    return JSON.parse(value) as CodexRecordEntry[];
  }

  protected toWorkspaceFile(row: WorkspaceFileMetadataRow): WorkspaceFile {
    return {
      path: row.path,
      size: row.size,
      modifiedAt: row.modified_at,
      sha256: row.sha256,
    };
  }}
