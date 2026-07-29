import type { WorkspaceSummary, WorkspaceSyncState } from "@codex-collab/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayClient, RelayRequestError } from "./relay-client.js";

const syncState: WorkspaceSyncState = {
  hostConnected: true,
  hostDeviceLabel: "Owner PC",
  rootLabel: "Project",
  threads: [],
  selectedThreadId: "thread-1",
  selectedThread: null,
  historyCount: 2,
  fileCount: 3,
  codexRuntimeStatus: "idle",
  syncedAt: "2026-07-27T00:00:00.000Z",
};

const workspace: WorkspaceSummary = {
  ...syncState,
  history: [
    { id: "one", role: "user", text: "One", createdAt: null },
    { id: "two", role: "assistant", text: "Two", createdAt: null },
  ],
  files: [
    { path: "a.ts", size: 1, modifiedAt: "2026-07-27T00:00:00.000Z", sha256: "a".repeat(64) },
    { path: "b.ts", size: 1, modifiedAt: "2026-07-27T00:00:00.000Z", sha256: "b".repeat(64) },
    { path: "c.ts", size: 1, modifiedAt: "2026-07-27T00:00:00.000Z", sha256: "c".repeat(64) },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RelayClient compact workspace synchronization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends owner recovery credentials in the request body instead of the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await new RelayClient("https://relay.example.com").recoverSession({
      sessionId: "room/one",
      recoveryKey: "ccr_secret",
      deviceLabel: "Owner PC",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://relay.example.com/v1/sessions/recover",
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("ccr_secret");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: "room/one",
      recoveryKey: "ccr_secret",
      deviceLabel: "Owner PC",
    });
  });

  it("loads the host-only compact sync state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ syncState }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new RelayClient("https://relay.example.com").getWorkspaceSyncState(
        "session-1",
        "host-token",
      ),
    ).resolves.toEqual(syncState);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/v1/sessions/session-1/host/workspace/sync-state",
    );
  });

  it("falls back to the legacy workspace route during a rolling deployment", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "not_found", message: "Route not found" } },
          404,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ workspace }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new RelayClient("https://relay.example.com").getWorkspaceSyncState(
        "session-1",
        "host-token",
      ),
    ).resolves.toEqual(syncState);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/v1/sessions/session-1/workspace",
    );
  });

  it("preserves non-404 relay errors without leaking or retrying the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { code: "forbidden", message: "Host access required" } },
        403,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new RelayClient(
      "https://relay.example.com",
    ).getWorkspaceSyncState("session/one", "host-secret");
    await expect(request).rejects.toEqual(
      new RelayRequestError(403, "forbidden", "Host access required"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("session%2Fone");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("host-secret");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ authorization: "Bearer host-secret" }),
    });
  });

  it("requests a minimal response for history uploads and accepts a legacy reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ workspace }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new RelayClient("https://relay.example.com").publishWorkspaceHistory(
        "session-1",
        "host-token",
        { threadId: "thread-1", history: workspace.history },
      ),
    ).resolves.toEqual(syncState);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ prefer: "return=minimal" }),
    });
  });

  it("releases only the explicitly identified workspace operation lease", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ operation: { id: "operation/one", status: "queued" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new RelayClient("https://relay.example.com").releaseWorkspaceFileOperationLease(
      "session/one",
      "host-secret",
      "operation/one",
      { leaseId: "lease-one" },
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://relay.example.com/v1/sessions/session%2Fone/workspace/file-operations/operation%2Fone/lease-release",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer host-secret" }),
      body: JSON.stringify({ leaseId: "lease-one" }),
    });
  });
});
