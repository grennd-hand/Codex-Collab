import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api-client.js";
import {
  saveResultFromOperation,
  type WorkspaceFileOperation,
} from "./workspace-file-operations.js";

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
