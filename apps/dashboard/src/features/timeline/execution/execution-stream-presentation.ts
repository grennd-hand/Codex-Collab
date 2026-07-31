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

function commandNeedsOwnRow(record: ReadableExecution): boolean {
  return record.status === "running" || record.status === "failed";
}

export function buildExecutionStreamBlocks(
  records: readonly ReadableExecution[],
): ExecutionStreamBlock[] {
  const historicalCommands = records.flatMap((record, index) =>
    record.role === "command" && !commandNeedsOwnRow(record)
      ? [{ index, record }]
      : [],
  );
  const firstHistoricalCommandIndex = historicalCommands[0]?.index;

  return records.flatMap((record, index): ExecutionStreamBlock[] => {
    const item = { index, record };
    if (record.role === "command" && !commandNeedsOwnRow(record)) {
      return index === firstHistoricalCommandIndex
        ? [{ kind: "command-batch", items: historicalCommands }]
        : [];
    }

    return [{ kind: record.role, item }];
  });
}

export function hasLiveExecutionRecord(
  records: readonly ReadableExecution[],
): boolean {
  return records.some((record) => record.status === "running");
}

export function executionStepDefaultExpanded(
  record: Pick<ReadableExecution, "role" | "status">,
): boolean {
  return (
    record.status === "failed" ||
    (record.role === "command" && record.status === "running")
  );
}

export function resolveExecutionStepExpanded(
  defaultExpanded: boolean,
  manualExpanded: boolean | null,
): boolean {
  return manualExpanded ?? defaultExpanded;
}
