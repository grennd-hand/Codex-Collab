import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LargeRolloutHistoryReader } from "./large-rollout-history.js";

const roots: string[] = [];

function rolloutLine(
  id: string,
  role: "user" | "assistant",
  text: string,
  timestamp: string,
): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      id,
      type: "message",
      role,
      ...(role === "assistant" ? { phase: "final_answer" } : {}),
      content: [{ type: "text", text }],
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("large rollout history", () => {
  it("keeps old conversation outside the recent byte window and merges appends", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-large-rollout-"));
    roots.push(root);
    const path = join(root, "rollout-thread-1.jsonl");
    const noise = Array.from({ length: 20 }, (_, index) =>
      JSON.stringify({
        timestamp: `2026-07-27T00:00:${String(index).padStart(2, "0")}.000Z`,
        type: "response_item",
        payload: { id: `reasoning-${index}`, type: "reasoning", summary: ["x".repeat(80)] },
      }),
    );
    await writeFile(
      path,
      [
        rolloutLine("old-user", "user", "old prompt", "2026-07-26T23:59:00.000Z"),
        ...noise,
        rolloutLine("recent-answer", "assistant", "recent answer", "2026-07-27T00:01:00.000Z"),
        "",
      ].join("\n"),
      "utf8",
    );
    const reader = new LargeRolloutHistoryReader(320);
    const firstSize = (await stat(path)).size;
    const first = await reader.read(path, firstSize, "thread-1");

    expect(first.map((entry) => entry.id)).toContain("old-user");
    expect(first.map((entry) => entry.id)).toContain("recent-answer");

    await appendFile(
      path,
      `${rolloutLine("new-user", "user", "new prompt", "2026-07-27T00:02:00.000Z")}\n`,
      "utf8",
    );
    const second = await reader.read(path, (await stat(path)).size, "thread-1");

    expect(second.filter((entry) => entry.id === "old-user")).toHaveLength(1);
    expect(second.filter((entry) => entry.id === "recent-answer")).toHaveLength(1);
    expect(second.filter((entry) => entry.id === "new-user")).toHaveLength(1);
  });
});
