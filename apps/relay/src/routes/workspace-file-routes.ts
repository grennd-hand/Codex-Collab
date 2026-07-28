import type { IncomingMessage, ServerResponse } from "node:http";
import {
  optionalInteger,
  ProtocolError,
  requiredString,
  type ReleaseWorkspaceFileOperationLeaseRequest,
  type WorkspaceFileContent,
} from "@codex-collab/protocol";
import {
  parseWorkspaceFileOperationRequest,
  parseWorkspaceOperationResultFile,
  toWorkspaceFileOperationEvent,
} from "../http/route-payloads.js";
import type { RelayRouteContext } from "./route-context.js";

export async function handleWorkspaceFileRoutes(
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
    enforceRateLimit,
    broadcast,
  } = context;
    const workspaceFileOperationClaimMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations\/claim$/,
    );
    if (method === "POST" && workspaceFileOperationClaimMatch?.[1]) {
      await readJson(request, 4_096);
      const result = store.claimNextWorkspaceFileOperation(
        workspaceFileOperationClaimMatch[1],
        bearerToken(request),
      );
      for (const rejected of result.rejected) {
        broadcast(
          workspaceFileOperationClaimMatch[1],
          "file.operation.updated",
          toWorkspaceFileOperationEvent(rejected),
        );
      }
      if (result.operation) {
        broadcast(
          workspaceFileOperationClaimMatch[1],
          "file.operation.updated",
          toWorkspaceFileOperationEvent(result.operation),
        );
      }
      sendJson(response, 200, { operation: result.operation });
      return true;
    }

    const workspaceFileOperationLeaseMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations\/([^/]+)\/lease-confirmation$/,
    );
    if (
      method === "POST" &&
      workspaceFileOperationLeaseMatch?.[1] &&
      workspaceFileOperationLeaseMatch[2]
    ) {
      const body = await readJson(request, 4_096);
      const operation = store.confirmWorkspaceFileOperationLease(
        workspaceFileOperationLeaseMatch[1],
        bearerToken(request),
        workspaceFileOperationLeaseMatch[2],
        requiredString(body.leaseId, "leaseId", 100),
      );
      sendJson(response, 200, { operation });
      return true;
    }

    const workspaceFileOperationReleaseMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations\/([^/]+)\/lease-release$/,
    );
    if (
      method === "POST" &&
      workspaceFileOperationReleaseMatch?.[1] &&
      workspaceFileOperationReleaseMatch[2]
    ) {
      const body = await readJson(request, 4_096);
      const input: ReleaseWorkspaceFileOperationLeaseRequest = {
        leaseId: requiredString(body.leaseId, "leaseId", 100),
      };
      const operation = store.releaseWorkspaceFileOperationLease(
        workspaceFileOperationReleaseMatch[1],
        bearerToken(request),
        workspaceFileOperationReleaseMatch[2],
        input.leaseId,
      );
      broadcast(
        workspaceFileOperationReleaseMatch[1],
        "file.operation.updated",
        toWorkspaceFileOperationEvent(operation),
      );
      sendJson(response, 200, { operation });
      return true;
    }

    const workspaceFileOperationResultMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations\/([^/]+)\/result$/,
    );
    if (
      method === "PATCH" &&
      workspaceFileOperationResultMatch?.[1] &&
      workspaceFileOperationResultMatch[2]
    ) {
      const body = await readJson(request, 2_100_000);
      let input:
        | { status: "completed"; leaseId: string; file?: WorkspaceFileContent }
        | {
            status: "failed";
            leaseId: string;
            errorCode: string;
            errorMessage: string;
            file?: WorkspaceFileContent | null;
          };
      if (body.status === "completed") {
        input = {
          status: "completed",
          leaseId: requiredString(body.leaseId, "leaseId", 100),
          ...(body.file === undefined || body.file === null
            ? {}
            : { file: parseWorkspaceOperationResultFile(body.file) }),
        };
      } else if (body.status === "failed") {
        input = {
          status: "failed",
          leaseId: requiredString(body.leaseId, "leaseId", 100),
          errorCode: requiredString(body.errorCode, "errorCode", 120),
          errorMessage: requiredString(body.errorMessage, "errorMessage", 1_000),
          ...(body.file === undefined || body.file === null
            ? {}
            : { file: parseWorkspaceOperationResultFile(body.file) }),
        };
      } else {
        throw new ProtocolError(
          400,
          "invalid_request",
          "status must be completed or failed",
        );
      }
      const operation = store.completeWorkspaceFileOperation(
        workspaceFileOperationResultMatch[1],
        bearerToken(request),
        workspaceFileOperationResultMatch[2],
        input,
      );
      broadcast(
        workspaceFileOperationResultMatch[1],
        "file.operation.updated",
        toWorkspaceFileOperationEvent(operation),
      );
      sendJson(response, 200, { operation });
      return true;
    }

    const workspaceFileOperationMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations\/([^/]+)$/,
    );
    if (
      method === "GET" &&
      workspaceFileOperationMatch?.[1] &&
      workspaceFileOperationMatch[2]
    ) {
      sendJson(response, 200, {
        operation: store.getWorkspaceFileOperation(
          workspaceFileOperationMatch[1],
          bearerToken(request),
          workspaceFileOperationMatch[2],
        ),
      });
      return true;
    }

    const workspaceFileOperationsMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file-operations$/,
    );
    if (workspaceFileOperationsMatch?.[1] && method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      const limit = optionalInteger(
        rawLimit === null ? undefined : Number(rawLimit),
        100,
        "limit",
        1,
        200,
      );
      sendJson(response, 200, {
        operations: store.listWorkspaceFileOperations(
          workspaceFileOperationsMatch[1],
          bearerToken(request),
          limit,
        ),
      });
      return true;
    }
    if (workspaceFileOperationsMatch?.[1] && method === "POST") {
      enforceRateLimit(request, "workspace-file-operation", 120, 60_000);
      const body = await readJson(request, 2_100_000);
      const operation = store.createWorkspaceFileOperation(
        workspaceFileOperationsMatch[1],
        bearerToken(request),
        parseWorkspaceFileOperationRequest(body),
      );
      broadcast(
        workspaceFileOperationsMatch[1],
        "file.operation.updated",
        toWorkspaceFileOperationEvent(operation),
      );
      sendJson(response, 202, { operation });
      return true;
    }

    const workspaceFileMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/workspace\/file$/,
    );
    if (method === "GET" && workspaceFileMatch?.[1]) {
      const path = url.searchParams.get("path");
      sendJson(response, 200, {
        file: store.getWorkspaceFile(
          workspaceFileMatch[1],
          bearerToken(request),
          requiredString(path, "path", 500),
        ),
      });
      return true;
    }

  return false;
}
