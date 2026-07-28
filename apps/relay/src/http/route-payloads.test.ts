import { describe, expect, it } from "vitest";
import {
  MAX_WORKSPACE_HISTORY_ENTRIES,
  ProtocolError,
} from "@codex-collab/protocol";
import { parseCodexFileChanges, parseHistory } from "./route-payloads.js";

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

describe("Codex file activity payloads", () => {
  const legacyChange = {
    operationId: "operation-1",
    path: "src/app.ts",
    kind: "modified",
    lifecycle: "completed",
    additions: 2,
    deletions: 1,
  };

  it("keeps legacy summaries valid and accepts additive structured activity", () => {
    expect(parseCodexFileChanges([legacyChange], 0)).toEqual([legacyChange]);
    expect(
      parseCodexFileChanges([{ ...legacyChange, diff: "@@ -1 +1 @@\n-old\n+new" }], 0),
    ).toEqual([
      {
        ...legacyChange,
        diff: {
          format: "unified",
          text: "@@ -1 +1 @@\n-old\n+new",
          truncated: false,
        },
      },
    ]);

    expect(
      parseCodexFileChanges(
        [
          {
            ...legacyChange,
            taskId: "task-1",
            actor: { type: "codex", id: "codex", displayName: "Codex" },
            timestamp: "2026-07-28T10:20:30+08:00",
            range: { startLine: 4, startColumn: 2, endLine: 8, endColumn: 5 },
            beforeSha256: "a".repeat(64),
            afterSha256: "b".repeat(64),
            diff: {
              format: "unified",
              text: "@@ -4,1 +4,1 @@\n-old\n+new",
              truncated: false,
            },
          },
        ],
        0,
      ),
    ).toEqual([
      {
        ...legacyChange,
        taskId: "task-1",
        actor: { type: "codex", id: "codex", displayName: "Codex" },
        timestamp: "2026-07-28T02:20:30.000Z",
        range: { startLine: 4, startColumn: 2, endLine: 8, endColumn: 5 },
        beforeSha256: "a".repeat(64),
        afterSha256: "b".repeat(64),
        diff: {
          format: "unified",
          text: "@@ -4,1 +4,1 @@\n-old\n+new",
          truncated: false,
        },
      },
    ]);
  });

  it("rejects unsafe diff content, private paths, invalid ranges and invalid hashes", () => {
    expect(() =>
      parseCodexFileChanges(
        [{ ...legacyChange, diff: { format: "unified", text: "+API_KEY=sk-secret-value-that-is-long", truncated: false } }],
        0,
      ),
    ).toThrowError(/safe to share/i);
    expect(() =>
      parseCodexFileChanges(
        [{ ...legacyChange, path: ".env", diff: { format: "unified", text: "+safe", truncated: false } }],
        0,
      ),
    ).toThrowError(/safe to share/i);
    expect(() =>
      parseCodexFileChanges(
        [{ ...legacyChange, range: { startLine: 9, endLine: 2 } }],
        0,
      ),
    ).toThrowError(/at or after/i);
    expect(() =>
      parseCodexFileChanges([{ ...legacyChange, beforeSha256: "not-a-hash" }], 0),
    ).toThrowError(/SHA-256/i);
  });
});
