import type {
  CodexFileChange,
  CodexRecordEntry,
} from "@codex-collab/protocol";
import { presentCommandEntry } from "../execution/command-entry-presentation.js";
import type {
  PresentExecutionEntryOptions,
  ReadableExecution,
} from "../execution/execution-presentation-types.js";

export type {
  ExecutionStatus,
  PresentExecutionEntryOptions,
  ReadableBlock,
  ReadableExecution,
  ReadableSourceKind,
} from "../execution/execution-presentation-types.js";
export {
  classifyReadableSource,
  executionOutputNeedsViewport,
  parseReadableBlocks,
} from "./readable-markdown.js";

function reasoningDisplayText(text: string, active: boolean): {
  displayText: string;
  sourceText: string | null;
} {
  const normalized = text.trim();
  if (/\p{Script=Han}/u.test(normalized)) {
    return { displayText: normalized, sourceText: null };
  }
  return {
    displayText: active
      ? "Codex 正在分析当前任务并规划下一步。"
      : "Codex 已完成本阶段的分析与计划。",
    sourceText: normalized || null,
  };
}

export function presentExecutionEntry(
  entry: CodexRecordEntry,
  options: PresentExecutionEntryOptions = {},
): ReadableExecution {
  if (entry.role === "reasoning") {
    const active = options.active === true;
    const reasoning = reasoningDisplayText(entry.text, active);
    return {
      id: entry.id,
      role: "reasoning",
      title: "分析与计划",
      status: active ? "running" : "completed",
      summary: active ? "Codex 正在处理" : "Codex 的当前处理思路",
      input: reasoning.displayText,
      output: null,
      sourceText: reasoning.sourceText,
      outputLineCount: 0,
      createdAt: entry.createdAt,
      fileChanges: [],
    };
  }

  if (entry.role === "assistant" && entry.phase === "commentary") {
    return {
      id: entry.id,
      role: "commentary",
      title: "处理进展",
      status: "completed",
      summary: "Codex 的阶段性处理说明",
      input: entry.text.trim() || null,
      output: null,
      sourceText: null,
      outputLineCount: 0,
      createdAt: entry.createdAt,
      fileChanges: [],
    };
  }

  return presentCommandEntry(entry);
}

export function presentExecutionEntries(
  entries: readonly CodexRecordEntry[],
  active = false,
  finalized = false,
): ReadableExecution[] {
  const records = entries.map((entry) => presentExecutionEntry(entry));
  if (finalized) {
    return records.map((record) =>
      record.status === "running"
        ? {
            ...record,
            status: "completed",
            summary: "任务完成时该步骤已结束",
          }
        : record,
    );
  }
  if (!active || records.some((record) => record.status === "running")) {
    return records;
  }

  const latestIndex = entries.length - 1;
  if (latestIndex >= 0 && entries[latestIndex]?.role === "reasoning") {
    records[latestIndex] = presentExecutionEntry(entries[latestIndex]!, {
      active: true,
    });
  }
  return records;
}

export function collectExecutionFileChanges(
  entries: readonly CodexRecordEntry[],
): CodexFileChange[] {
  const latest = new Map<string, CodexFileChange>();
  for (const entry of entries) {
    for (const change of presentExecutionEntry(entry).fileChanges) {
      latest.set(change.operationId, change);
    }
  }
  return [...latest.values()];
}
