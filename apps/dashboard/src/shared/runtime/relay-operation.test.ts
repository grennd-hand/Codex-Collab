import { describe, expect, it } from "vitest";
import { parseRelayOperation, relayOperationRequest } from "./relay-operation.js";

describe("Dashboard Relay operation allowlist", () => {
  it("maps an authenticated browser request to a typed operation and back", () => {
    const operation = parseRelayOperation(
      "/v1/sessions/room%201/workspace/history/page?limit=40&before=cursor%2F1",
      { headers: { authorization: "Bearer member-secret" } },
    );

    expect(operation).toEqual({
      operation: "workspace.history-page.get",
      sessionId: "room 1",
      authorization: "member-secret",
      input: { limit: 40, before: "cursor/1" },
    });
    expect(relayOperationRequest(operation)).toEqual({
      path: "/v1/sessions/room%201/workspace/history/page?limit=40&before=cursor%2F1",
      init: {
        headers: { authorization: "Bearer member-secret" },
      },
    });
  });

  it("maps file writes without exposing a generic URL operation", () => {
    expect(
      parseRelayOperation("/v1/sessions/s1/workspace/file-operations", {
        method: "POST",
        headers: {
          authorization: "Bearer browser-only",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "write",
          path: "src/app.ts",
          content: "export {};",
          expectedSha256: "abc",
        }),
      }),
    ).toMatchObject({
      operation: "workspace.file-operation.create",
      sessionId: "s1",
      input: { kind: "write", path: "src/app.ts" },
    });
  });

  it("rejects external URLs, unknown routes and non-JSON bodies", () => {
    expect(() => parseRelayOperation("https://attacker.invalid/v1/sessions")).toThrow(
      "不接受外部 URL",
    );
    expect(() => parseRelayOperation("/v1/admin", { method: "POST" })).toThrow(
      "不支持",
    );
    expect(() =>
      parseRelayOperation("/v1/sessions", {
        method: "POST",
        body: new URLSearchParams({ name: "unsafe" }),
      }),
    ).toThrow("只接受 JSON 请求体");
  });
});
