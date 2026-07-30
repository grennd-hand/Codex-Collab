import type {
  CodexFileChange,
  CodexRecordEntry,
} from "@codex-collab/protocol";
import { presentCommandEntry } from "../execution/command-entry-presentation.js";
import { nestedProcessSession } from "../execution/nested-process-session.js";
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
  const sessionOwners = new Map<string, number>();
  entries.forEach((entry, index) => {
    const process = nestedProcessSession(entry);
    if (!process) return;
    if (process.kind === "start") {
      sessionOwners.set(process.sessionId, index);
      if (active && !finalized) {
        records[index] = {
          ...records[index]!,
          status: "running",
          summary: "正在执行，结果返回后会自动更新",
        };
      }
      return;
    }

    const ownerIndex = sessionOwners.get(process.sessionId);
    if (ownerIndex === undefined) return;
    const owner = records[ownerIndex]!;
    const status = process.running
      ? "running"
      : process.exitCode === null || process.exitCode === 0
        ? "completed"
        : "failed";
    records[index] = {
      ...records[index]!,
      title: owner.title,
      input: owner.input,
      status,
      summary:
        status === "running"
          ? "正在执行，结果返回后会自动更新"
          : status === "failed"
            ? `执行失败，退出码 ${process.exitCode}`
            : "执行完成",
    };
    if (!process.running) {
      records[ownerIndex] = {
        ...owner,
        status,
        summary: records[index]!.summary,
      };
    }
  });
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
  const latestIndex = records.length - 1;
  let currentRunningCommandIndex = -1;
  if (active) {
    for (let index = latestIndex; index >= 0; index -= 1) {
      const record = records[index];
      if (record?.role !== "command") continue;
      if (record.status === "running") currentRunningCommandIndex = index;
      break;
    }
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.status !== "running") continue;
    const isCurrentStep = active && index === currentRunningCommandIndex;
    if (!isCurrentStep) {
      records[index] = {
        ...record,
        status: "stopped",
        summary: active
          ? "后续步骤已继续，该步骤不再运行"
          : "任务已停止，该步骤未收到完成结果",
        output:
          record.output?.replace(
            "后台任务仍在运行，结果会继续同步",
            active
              ? "该后台步骤已被后续处理取代"
              : "该后台步骤已随任务停止",
          ) ?? null,
      };
    }
  }

  if (
    active &&
    currentRunningCommandIndex < 0 &&
    latestIndex >= 0 &&
    records[latestIndex]?.status !== "running" &&
    entries[latestIndex]?.role === "reasoning"
  ) {
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
