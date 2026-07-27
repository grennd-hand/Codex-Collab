import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../shared/api/api-client.js";
import {
  readWorkspaceFileOperation,
  saveResultFromOperation,
  type WorkspaceFileOperation,
} from "./workspace-file-operations.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readWorkspaceFileOperation", () => {
  it("reads the synced Relay snapshot directly without queuing a Host operation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          file: {
            path: "src/App.tsx",
            size: 12,
            modifiedAt: "2026-07-27T00:00:00.000Z",
            sha256: "current-hash",
            content: "export {};",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = await readWorkspaceFileOperation(
      { sessionId: "session / 1", headers: { Authorization: "Bearer test" } },
      "src/A B.tsx",
    );

    expect(file.sha256).toBe("current-hash");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/v1/sessions/session%20%2F%201/workspace/file?path=src%2FA%20B.tsx",
    );
    expect(request.method).toBeUndefined();
  });
});

function operation(
  values: Partial<WorkspaceFileOperation>,
): WorkspaceFileOperation {
  return {
    id: "operation-1",
    sessionId: "session-1",
    requestedByMemberId: "member-1",
    requestedByDisplayName: "Xiaomi",
    kind: "write",
    path: "src/App.tsx",
    destinationPath: null,
    expectedSha256: "old-hash",
    status: "completed",
    resultFile: {
      path: "src/App.tsx",
      size: 12,
      modifiedAt: "2026-07-27T00:00:00.000Z",
      sha256: "new-hash",
      content: "export const ready = true;",
    },
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-07-27T00:00:00.000Z",
    startedAt: "2026-07-27T00:00:00.100Z",
    completedAt: "2026-07-27T00:00:00.200Z",
    ...values,
  };
}

describe("saveResultFromOperation", () => {
  it("returns the authoritative file after a completed save", () => {
    const result = saveResultFromOperation(operation({}));

    expect(result.status).toBe("saved");
    expect(result.file.sha256).toBe("new-hash");
  });

  it("keeps the authoritative host file for an explicit hash conflict", () => {
    const result = saveResultFromOperation(
      operation({
        status: "failed",
        errorCode: "file_conflict",
        errorMessage: "hash mismatch",
      }),
    );

    expect(result).toMatchObject({
      status: "conflict",
      message: "hash mismatch",
      file: { sha256: "new-hash" },
    });
  });

  it("does not disguise permission failures as conflicts", () => {
    expect(() =>
      saveResultFromOperation(
        operation({
          status: "failed",
          resultFile: null,
          errorCode: "read_only",
          errorMessage: null,
        }),
      ),
    ).toThrowError(ApiRequestError);
  });
});
