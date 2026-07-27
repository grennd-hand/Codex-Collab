import type { IncomingMessage, ServerResponse } from "node:http";
import {
  optionalInteger,
  ProtocolError,
  requiredString,
  type CodexRuntimeStatus,
} from "@codex-collab/protocol";
import {
  parseHistory,
  parseThreadCatalog,
  parseWorkspaceFiles,
} from "../http/route-payloads.js";
import type { RelayRouteContext } from "./route-context.js";

export async function handleWorkspaceSyncRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  context: RelayRouteContext,
): Promise<boolean> {
  const {
    store,
    sendJson,
    readJson,
    bearerToken,
    prefersMinimalResponse,
    broadcast,
  } = context;
    const workspaceMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/workspace$/);
    if (method === "GET" && workspaceMatch?.[1]) {
      sendJson(response, 200, {
        workspace: store.getWorkspace(workspaceMatch[1], bearerToken(request)),
      });
      return true;
    }

    const workspaceOverviewMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/overview$/,
    );
    if (method === "GET" && workspaceOverviewMatch?.[1]) {
      sendJson(response, 200, {
        workspace: store.getWorkspaceOverview(
          workspaceOverviewMatch[1],
          bearerToken(request),
        ),
      });
      return true;
    }

    const hostWorkspaceSyncStateMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/host\/workspace\/sync-state$/,
    );
    if (method === "GET" && hostWorkspaceSyncStateMatch?.[1]) {
      sendJson(response, 200, {
        syncState: store.getWorkspaceSyncState(
          hostWorkspaceSyncStateMatch[1],
          bearerToken(request),
        ),
      });
      return true;
    }

    const workspaceRuntimeMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/runtime$/,
    );
    if (method === "PUT" && workspaceRuntimeMatch?.[1]) {
      const body = await readJson(request);
      if (
        body.status !== "unavailable" &&
        body.status !== "idle" &&
        body.status !== "running"
      ) {
        throw new ProtocolError(400, "invalid_request", "Codex runtime status is invalid");
      }
      const minimal = prefersMinimalResponse(request);
      const result = minimal
        ? store.publishCodexRuntimeStatus(
            workspaceRuntimeMatch[1],
            bearerToken(request),
            body.status as CodexRuntimeStatus,
            true,
          )
        : store.publishCodexRuntimeStatus(
            workspaceRuntimeMatch[1],
            bearerToken(request),
            body.status as CodexRuntimeStatus,
          );
      if (result.changed) {
        broadcast(workspaceRuntimeMatch[1], "workspace.updated", {
          codexRuntimeStatus: result.workspace.codexRuntimeStatus,
          changedScopes: ["runtime"],
        });
      }
      sendJson(
        response,
        200,
        minimal ? { syncState: result.workspace } : { workspace: result.workspace },
        minimal ? { "preference-applied": "return=minimal" } : {},
      );
      return true;
    }

    const workspaceCatalogMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/catalog$/,
    );
    if (method === "PUT" && workspaceCatalogMatch?.[1]) {
      const body = await readJson(request);
      const workspace = store.publishWorkspaceCatalog(
        workspaceCatalogMatch[1],
        bearerToken(request),
        {
          deviceLabel: requiredString(body.deviceLabel, "deviceLabel", 120),
          rootLabel: requiredString(body.rootLabel, "rootLabel", 200),
          threads: parseThreadCatalog(body.threads),
        },
      );
      broadcast(workspaceCatalogMatch[1], "workspace.updated", {
        hostConnected: true,
        taskCount: workspace.threads.length,
        changedScopes: ["catalog"],
      });
      sendJson(response, 200, { workspace });
      return true;
    }

    const workspaceSelectionMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/selection$/,
    );
    const hostWorkspaceSelectionMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/host\/workspace\/selection$/,
    );
    if (method === "PUT" && hostWorkspaceSelectionMatch?.[1]) {
      const body = await readJson(request);
      const workspace = store.selectWorkspaceThreadFromHost(
        hostWorkspaceSelectionMatch[1],
        bearerToken(request),
        requiredString(body.threadId, "threadId", 120),
      );
      broadcast(hostWorkspaceSelectionMatch[1], "workspace.updated", {
        selectedThreadId: workspace.selectedThreadId,
        syncedAt: null,
        changedScopes: ["selection"],
      });
      sendJson(response, 200, { workspace });
      return true;
    }
    if (method === "PUT" && workspaceSelectionMatch?.[1]) {
      const body = await readJson(request);
      const workspace = store.selectWorkspaceThread(
        workspaceSelectionMatch[1],
        bearerToken(request),
        requiredString(body.threadId, "threadId", 120),
      );
      broadcast(workspaceSelectionMatch[1], "workspace.updated", {
        selectedThreadId: workspace.selectedThreadId,
        syncedAt: null,
        changedScopes: ["selection"],
      });
      sendJson(response, 200, { workspace });
      return true;
    }

    const workspaceHistoryMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/history$/,
    );
    const workspaceHistoryPageMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/history\/page$/,
    );
    if (method === "GET" && workspaceHistoryPageMatch?.[1]) {
      const rawLimit = url.searchParams.get("limit");
      if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
        throw new ProtocolError(
          400,
          "invalid_history_page_limit",
          "History page limit must be an integer",
        );
      }
      const rawCursor = url.searchParams.get("before");
      sendJson(response, 200, {
        workspaceHistoryPage: store.getWorkspaceHistoryPage(
          workspaceHistoryPageMatch[1],
          bearerToken(request),
          {
            ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
            ...(rawCursor === null
              ? {}
              : { before: requiredString(rawCursor, "before", 2_000) }),
          },
        ),
      });
      return true;
    }
    if (method === "GET" && workspaceHistoryMatch?.[1]) {
      sendJson(response, 200, {
        workspaceHistory: store.getWorkspaceHistory(
          workspaceHistoryMatch[1],
          bearerToken(request),
        ),
      });
      return true;
    }
    if (method === "PUT" && workspaceHistoryMatch?.[1]) {
      const body = await readJson(request, 3_000_000);
      const input = {
        threadId: requiredString(body.threadId, "threadId", 120),
        history: parseHistory(body.history),
      };
      const minimal = prefersMinimalResponse(request);
      const workspace = minimal
        ? store.publishWorkspaceHistory(
            workspaceHistoryMatch[1],
            bearerToken(request),
            input,
            true,
          )
        : store.publishWorkspaceHistory(
            workspaceHistoryMatch[1],
            bearerToken(request),
            input,
          );
      broadcast(workspaceHistoryMatch[1], "workspace.updated", {
        selectedThreadId: workspace.selectedThreadId,
        syncedAt: workspace.syncedAt,
        historyCount:
          "historyCount" in workspace
            ? workspace.historyCount
            : workspace.history.length,
        changedScopes: ["history"],
      });
      sendJson(
        response,
        200,
        minimal ? { syncState: workspace } : { workspace },
        minimal ? { "preference-applied": "return=minimal" } : {},
      );
      return true;
    }

    const workspaceSnapshotMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/snapshot$/,
    );
    if (method === "PUT" && workspaceSnapshotMatch?.[1]) {
      const body = await readJson(request, 9_000_000);
      const input = {
        threadId: requiredString(body.threadId, "threadId", 120),
        history: parseHistory(body.history),
        files: parseWorkspaceFiles(body.files),
      };
      const minimal = prefersMinimalResponse(request);
      const workspace = minimal
        ? store.publishWorkspaceSnapshot(
            workspaceSnapshotMatch[1],
            bearerToken(request),
            input,
            true,
          )
        : store.publishWorkspaceSnapshot(
            workspaceSnapshotMatch[1],
            bearerToken(request),
            input,
          );
      broadcast(workspaceSnapshotMatch[1], "workspace.updated", {
        selectedThreadId: workspace.selectedThreadId,
        syncedAt: workspace.syncedAt,
        historyCount:
          "historyCount" in workspace
            ? workspace.historyCount
            : workspace.history.length,
        fileCount:
          "fileCount" in workspace ? workspace.fileCount : workspace.files.length,
        changedScopes: ["history", "files"],
      });
      sendJson(
        response,
        200,
        minimal ? { syncState: workspace } : { workspace },
        minimal ? { "preference-applied": "return=minimal" } : {},
      );
      return true;
    }


  return false;
}
