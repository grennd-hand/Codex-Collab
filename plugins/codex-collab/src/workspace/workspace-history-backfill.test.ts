import { describe, expect, it, vi } from "vitest";
import { cacheNextWorkspaceThreadHistory } from "./workspace-history-backfill.js";
import { profile } from "../sync/workspace-sync-test-fixtures.js";

const threads = [
  { id: "selected", name: "Selected", preview: "", updatedAt: 2, path: null },
  { id: "cached", name: "Cached", preview: "", updatedAt: 1, path: null },
  { id: "missing", name: "Missing", preview: "", updatedAt: 0, path: null },
];

function syncState(cachedThreadIds?: string[]) {
  return {
    hostConnected: true,
    hostDeviceLabel: "Owner PC",
    rootLabel: "Project",
    threads: [],
    selectedThreadId: "selected",
    selectedThread: null,
    historyCount: 1,
    fileCount: 1,
    codexRuntimeStatus: "idle" as const,
    syncedAt: "2026-07-28T00:00:00.000Z",
    ...(cachedThreadIds ? { cachedThreadIds } : {}),
  };
}

describe("workspace history backfill", () => {
  it("does nothing while the Relay is too old to report its history cache", async () => {
    const codex = { readThreadHistory: vi.fn() };
    const relay = { publishWorkspaceHistory: vi.fn() };

    await expect(
      cacheNextWorkspaceThreadHistory(
        profile,
        syncState(),
        threads,
        codex as never,
        relay as never,
      ),
    ).resolves.toEqual(syncState());
    expect(codex.readThreadHistory).not.toHaveBeenCalled();
  });

  it("stores one uncached historical task without changing the selected task", async () => {
    const history = [
      { id: "entry", role: "assistant" as const, text: "Done", createdAt: null },
    ];
    const updated = syncState(["selected", "cached", "missing"]);
    const codex = { readThreadHistory: vi.fn().mockResolvedValue(history) };
    const relay = { publishWorkspaceHistory: vi.fn().mockResolvedValue(updated) };

    await expect(
      cacheNextWorkspaceThreadHistory(
        profile,
        syncState(["selected", "cached"]),
        threads,
        codex as never,
        relay as never,
      ),
    ).resolves.toEqual(updated);
    expect(codex.readThreadHistory).toHaveBeenCalledWith("missing", null);
    expect(relay.publishWorkspaceHistory).toHaveBeenCalledWith(
      "session-1",
      "member-token",
      { threadId: "missing", history },
    );
  });
});
