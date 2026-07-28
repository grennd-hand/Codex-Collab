import { describe, expect, it } from "vitest";
import type { CodexRecordEntry } from "@codex-collab/protocol";
import {
  limitRecordEntries,
  MAX_PUBLISHED_RECORD_ENTRIES,
  MAX_PUBLISHED_RECORD_TEXT_LENGTH,
} from "./history-common.js";

function entry(
  id: string,
  role: CodexRecordEntry["role"],
  text = id,
): CodexRecordEntry {
  return { id, role, text, createdAt: null };
}

describe("history record publication limits", () => {
  it("preserves older conversation while filling the rest with recent process details", () => {
    const entries = [
      entry("old-user", "user"),
      entry("old-answer", "assistant"),
      ...Array.from({ length: 1_100 }, (_, index) =>
        entry(`command-${index}`, "command"),
      ),
    ];

    const limited = limitRecordEntries(entries);

    expect(limited).toHaveLength(MAX_PUBLISHED_RECORD_ENTRIES);
    expect(limited.map((item) => item.id)).toContain("old-user");
    expect(limited.map((item) => item.id)).toContain("old-answer");
    expect(limited.at(-1)?.id).toBe("command-1099");
  });

  it("keeps the published text inside the relay request budget", () => {
    const entries = [
      entry("old-user", "user", "keep me"),
      ...Array.from({ length: 900 }, (_, index) =>
        entry(`reasoning-${index}`, "reasoning", "x".repeat(3_000)),
      ),
    ];

    const limited = limitRecordEntries(entries);

    expect(limited.map((item) => item.id)).toContain("old-user");
    expect(limited.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(
      MAX_PUBLISHED_RECORD_TEXT_LENGTH,
    );
  });

  it("includes structured file changes in the relay request budget", () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      ...entry(`command-${index}`, "command"),
      fileChanges: [
        {
          operationId: `operation-${index}`,
          path: `src/file-${index}.ts`,
          kind: "modified" as const,
          lifecycle: "completed" as const,
          additions: 1,
          deletions: 1,
          diff: "x".repeat(10_000),
        },
      ],
    }));

    const limited = limitRecordEntries(entries);
    const payloadLength = limited.reduce(
      (sum, item) =>
        sum + item.text.length + JSON.stringify(item.fileChanges ?? []).length,
      0,
    );

    expect(limited.length).toBeLessThan(entries.length);
    expect(payloadLength).toBeLessThanOrEqual(MAX_PUBLISHED_RECORD_TEXT_LENGTH);
  });
});
