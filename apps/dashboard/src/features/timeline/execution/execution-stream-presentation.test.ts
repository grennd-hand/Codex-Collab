import { describe, expect, it } from "vitest";
import type { ReadableExecution } from "./execution-presentation-types.js";
import {
  buildExecutionStreamBlocks,
  executionStepDefaultExpanded,
  hasLiveExecutionRecord,
  resolveExecutionStepExpanded,
} from "./execution-stream-presentation.js";

function record(
  id: string,
  role: ReadableExecution["role"],
  status: ReadableExecution["status"] = "completed",
): ReadableExecution {
  return {
    id,
    role,
    status,
    title: id,
    summary: id,
    input: id,
    output: null,
    sourceText: null,
    outputLineCount: 0,
    createdAt: null,
    fileChanges: [],
  };
}

describe("buildExecutionStreamBlocks", () => {
  it("folds each command run between narrative updates without reordering prose", () => {
    const blocks = buildExecutionStreamBlocks([
      record("intro", "commentary"),
      record("command-a", "command"),
      record("command-b", "command", "stopped"),
      record("update", "commentary"),
      record("command-c", "command"),
      record("command-d", "command", "stopped"),
      record("command-e", "command", "running"),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual([
      "commentary",
      "command-batch",
      "commentary",
      "command-batch",
      "command",
    ]);
    expect(blocks[1]).toMatchObject({
      kind: "command-batch",
      items: [
        { index: 1, record: { id: "command-a" } },
        { index: 2, record: { id: "command-b" } },
      ],
    });
    expect(blocks[3]).toMatchObject({
      kind: "command-batch",
      items: [
        { index: 4, record: { id: "command-c" } },
        { index: 5, record: { id: "command-d" } },
      ],
    });
  });

  it("keeps running and failed commands outside historical batches", () => {
    const blocks = buildExecutionStreamBlocks([
      record("done", "command"),
      record("failed", "command", "failed"),
      record("stopped", "command", "stopped"),
      record("running", "command", "running"),
    ]);

    expect(blocks.map((block) => block.kind)).toEqual([
      "command-batch",
      "command",
      "command-batch",
      "command",
    ]);
    expect(blocks[0]).toMatchObject({
      kind: "command-batch",
      items: [{ record: { id: "done" } }],
    });
    expect(blocks[2]).toMatchObject({
      kind: "command-batch",
      items: [{ record: { id: "stopped" } }],
    });
    expect(hasLiveExecutionRecord(blocks.flatMap((block) =>
      block.kind === "command-batch"
        ? block.items.map((item) => item.record)
        : [block.item.record],
    ))).toBe(true);
  });

  it("opens only active commands or failures unless the user chose otherwise", () => {
    expect(
      executionStepDefaultExpanded(record("running", "command", "running")),
    ).toBe(true);
    expect(
      executionStepDefaultExpanded(record("reasoning", "reasoning", "running")),
    ).toBe(false);
    expect(
      executionStepDefaultExpanded(record("stopped", "command", "stopped")),
    ).toBe(false);
    expect(
      executionStepDefaultExpanded(record("failed", "command", "failed")),
    ).toBe(true);
    expect(resolveExecutionStepExpanded(true, false)).toBe(false);
    expect(resolveExecutionStepExpanded(false, true)).toBe(true);
  });
});
