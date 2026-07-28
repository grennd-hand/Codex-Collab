import { describe, expect, it, vi } from "vitest";
import { findPeerPromptTurnIds } from "./command-correlation.js";

describe("Codex command correlation", () => {
  it("finds a prompt by user-message client id across all pages", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: "turn-other", items: [{ type: "userMessage", clientId: "other" }] }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [{ id: "turn-match", items: [{ type: "userMessage", clientId: "command-1" }] }],
        nextCursor: null,
      });

    await expect(
      findPeerPromptTurnIds(request, "thread-1", "command-1"),
    ).resolves.toEqual(["turn-match"]);
    expect(request).toHaveBeenNthCalledWith(2, "thread/turns/list", {
      threadId: "thread-1",
      cursor: "page-2",
      limit: 100,
      sortDirection: "asc",
      itemsView: "full",
    });
  });

  it("finds the exact metadata marker and rejects repeated cursors", async () => {
    const metadataRequest = vi.fn().mockResolvedValue({
      data: [{
        id: "turn-metadata",
        items: [{
          type: "userMessage",
          metadata: { responsesapi: { collab_command_id: "command-2" } },
        }],
      }],
    });
    await expect(
      findPeerPromptTurnIds(metadataRequest, "thread-1", "command-2"),
    ).resolves.toEqual(["turn-metadata"]);

    const repeatedCursorRequest = vi.fn().mockResolvedValue({ data: [], nextCursor: "repeat" });
    await expect(
      findPeerPromptTurnIds(repeatedCursorRequest, "thread-1", "command-2"),
    ).rejects.toThrow("repeated a turn history cursor");
  });
});
