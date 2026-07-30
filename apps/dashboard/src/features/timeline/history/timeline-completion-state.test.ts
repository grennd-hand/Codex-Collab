import { describe, expect, it } from "vitest";
import type { CodexRecordEntry } from "@codex-collab/protocol";
import {
  buildUnifiedTimeline,
  latestTimelineTurnHasFinalAnswer,
} from "./imported-timeline.js";

function record(
  id: string,
  role: CodexRecordEntry["role"],
  text = id,
): CodexRecordEntry {
  return { id, role, text, createdAt: null };
}

describe("latestTimelineTurnHasFinalAnswer", () => {
  it("keeps a turn terminal when trailing process records arrive after its final answer", () => {
    const timeline = buildUnifiedTimeline(
      [
        record("user-1", "user"),
        {
          ...record("answer-1", "assistant", "已经完成"),
          phase: "final_answer",
        },
        record("late-command", "command"),
      ],
      [],
    );

    expect(latestTimelineTurnHasFinalAnswer(timeline)).toBe(true);
  });

  it("requires another final answer after a new user turn starts", () => {
    const timeline = buildUnifiedTimeline(
      [
        record("user-1", "user"),
        record("answer-1", "assistant"),
        record("user-2", "user"),
        record("reasoning-2", "reasoning"),
      ],
      [],
    );

    expect(latestTimelineTurnHasFinalAnswer(timeline)).toBe(false);
  });
});
