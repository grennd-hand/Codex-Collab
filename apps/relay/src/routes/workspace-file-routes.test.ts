import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceFileOperation } from "@codex-collab/protocol";
import { describe, expect, it, vi } from "vitest";
import { handleWorkspaceFileRoutes } from "./workspace-file-routes.js";
import type { RelayRouteContext } from "./route-context.js";

const queuedOperation: WorkspaceFileOperation = {
  id: "operation-1",
  sessionId: "session-1",
  requestedByMemberId: "member-1",
  requestedByDisplayName: "Editor",
  hostGeneration: "generation-1",
  kind: "mkdir",
  path: "src/new",
  destinationPath: null,
  expectedSha256: null,
  status: "queued",
  resultFileMetadata: null,
  resultFile: null,
  errorCode: null,
  errorMessage: null,
  requestedAt: "2026-07-29T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
};

function releaseContext(body: Record<string, unknown>) {
  const releaseWorkspaceFileOperationLease = vi.fn(() => queuedOperation);
  const sendJson = vi.fn();
  const broadcast = vi.fn();
  const context = {
    store: { releaseWorkspaceFileOperationLease },
    sendJson,
    readJson: vi.fn().mockResolvedValue(body),
    bearerToken: vi.fn(() => "host-token"),
    enforceRateLimit: vi.fn(),
    broadcast,
  } as unknown as RelayRouteContext;
  return { context, releaseWorkspaceFileOperationLease, sendJson, broadcast };
}

describe("workspace file operation release route", () => {
  it("validates and routes the exact lease before broadcasting the requeue", async () => {
    const route = releaseContext({ leaseId: "  lease-one  " });

    await expect(
      handleWorkspaceFileRoutes(
        {} as IncomingMessage,
        {} as ServerResponse,
        new URL(
          "http://relay.test/v1/sessions/session-1/workspace/file-operations/operation-1/lease-release",
        ),
        "POST",
        route.context,
      ),
    ).resolves.toBe(true);
    expect(route.releaseWorkspaceFileOperationLease).toHaveBeenCalledWith(
      "session-1",
      "host-token",
      "operation-1",
      "lease-one",
    );
    expect(route.broadcast).toHaveBeenCalledWith(
      "session-1",
      "file.operation.updated",
      expect.objectContaining({ operationId: "operation-1", status: "queued" }),
    );
    expect(route.sendJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      { operation: queuedOperation },
    );
  });

  it("rejects a missing lease before calling the store", async () => {
    const route = releaseContext({});
    const result = handleWorkspaceFileRoutes(
      {} as IncomingMessage,
      {} as ServerResponse,
      new URL(
        "http://relay.test/v1/sessions/session-1/workspace/file-operations/operation-1/lease-release",
      ),
      "POST",
      route.context,
    );

    await expect(result).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_request",
    });
    expect(route.releaseWorkspaceFileOperationLease).not.toHaveBeenCalled();
  });
});
