import { describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_HISTORY_ENTRIES,
  ProtocolError,
} from "@codex-collab/protocol";
import { parseHistory } from "./route-payloads.js";

function historyEntry(index: number) {
  return {
    id: `entry-${index}`,
    role: "command",
    text: "status: completed",
    createdAt: null,
  };
}

describe("workspace history payload limits", () => {
  it("accepts the same entry budget published by the Host", () => {
    const history = Array.from(
      { length: MAX_WORKSPACE_HISTORY_ENTRIES },
      (_, index) => historyEntry(index),
    );
    expect(parseHistory(history)).toHaveLength(MAX_WORKSPACE_HISTORY_ENTRIES);
  });

  it("rejects payloads beyond the shared entry budget", () => {
    const history = Array.from(
      { length: MAX_WORKSPACE_HISTORY_ENTRIES + 1 },
      (_, index) => historyEntry(index),
    );
    expect(() => parseHistory(history)).toThrow(ProtocolError);
  });
});
