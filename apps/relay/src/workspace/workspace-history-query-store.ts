import {
  type CodexRecordEntry,
  type WorkspaceFile,
  type WorkspaceHistoryPage,
  type WorkspaceHistoryResult,
  type WorkspaceOverview,
  type WorkspaceSummary,
  type WorkspaceSyncState,
} from "@codex-collab/protocol";
import type { WorkspaceFileMetadataRow } from "../storage/session-store-types.js";
import { WorkspaceThreadHistoryStore } from "./workspace-thread-history-store.js";
import { paginateWorkspaceHistory } from "./workspace-history-pagination.js";

export class WorkspaceHistoryQueryStore extends WorkspaceThreadHistoryStore {
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
    return {
      ...state,
      fileCount: files.length,
      cachedThreadIds: this.cachedWorkspaceThreadIds(sessionId),
    };
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
        hostGeneration: null,
        hostDeviceLabel: null,
        rootLabel: null,
        threads: [],
        selectedThreadId: null,
        selectedThread: null,
        historyCount: 0,
        files: [],
        directories: [],
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
      hostGeneration: state.host_generation,
      hostDeviceLabel: state.host_device_label,
      rootLabel: state.root_label,
      threads: includeThreadCatalog ? fullCatalog : [],
      selectedThreadId: state.selected_thread_id,
      selectedThread,
      historyCount: state.history_count,
      files: rows.map((row) => this.toWorkspaceFile(row)),
      directories: this.workspaceDirectories(sessionId),
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
  }
}
