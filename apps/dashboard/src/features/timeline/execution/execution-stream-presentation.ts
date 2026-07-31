import type { ReadableExecution } from "./execution-presentation-types.js";

export interface ExecutionStreamRecord {
  index: number;
  record: ReadableExecution;
}

export type ExecutionStreamBlock =
  | {
      kind: "commentary" | "reasoning" | "command";
      item: ExecutionStreamRecord;
    }
  | {
      kind: "command-batch";
      items: ExecutionStreamRecord[];
    };

export interface CompactLiveExecutionStream {
  current: ExecutionStreamRecord | null;
  history: ExecutionStreamRecord[];
}

function commandNeedsOwnRow(record: ReadableExecution): boolean {
  return record.status === "running";
}

export function buildExecutionStreamBlocks(
  records: readonly ReadableExecution[],
  indexOffset = 0,
): ExecutionStreamBlock[] {
  const blocks: ExecutionStreamBlock[] = [];
  let commandBatch: ExecutionStreamRecord[] = [];

  const flushCommandBatch = () => {
    if (commandBatch.length === 0) return;
    blocks.push({ kind: "command-batch", items: commandBatch });
    commandBatch = [];
  };

  records.forEach((record, index) => {
    const item = { index: index + indexOffset, record };
    if (record.role === "command" && !commandNeedsOwnRow(record)) {
      commandBatch.push(item);
      return;
    }

    flushCommandBatch();
    blocks.push({ kind: record.role, item });
  });
  flushCommandBatch();
  return blocks;
}

export function compactLiveExecutionStream(
  records: readonly ReadableExecution[],
): CompactLiveExecutionStream {
  const latestIndex = records.length - 1;
  const latest = records[latestIndex];
  if (!latest || latest.status !== "running") {
    return {
      current: null,
      history: records.map((record, index) => ({ index, record })),
    };
  }
  return {
    current: { index: latestIndex, record: latest },
    history: records
      .slice(0, latestIndex)
      .map((record, index) => ({ index, record })),
  };
}

export function hasLiveExecutionRecord(
  records: readonly ReadableExecution[],
): boolean {
  return records.some((record) => record.status === "running");
}

export function executionStepDefaultExpanded(
  record: Pick<ReadableExecution, "role" | "status">,
): boolean {
  return record.role === "command" && record.status === "running";
}

export function resolveExecutionStepExpanded(
  defaultExpanded: boolean,
  manualExpanded: boolean | null,
): boolean {
  return manualExpanded ?? defaultExpanded;
}
