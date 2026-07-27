import type { ExecutionStatus, ReadableExecution } from "./readable-output.js";

export function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function executionStatusLabel(status: ExecutionStatus): string {
  switch (status) {
    case "running":
      return "正在运行";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return "已记录";
  }
}

export interface ExecutionProcessPresentation {
  status: ExecutionStatus;
  title: string;
  detail: string;
  progress: string;
  defaultExpanded: boolean;
}

export function executionProcessPresentation(
  records: readonly (Pick<ReadableExecution, "status" | "title"> &
    Partial<Pick<ReadableExecution, "role">>)[],
  active = false,
  finalized = false,
): ExecutionProcessPresentation {
  const running = records.filter((record) => record.status === "running");
  const failed = records.filter((record) => record.status === "failed");
  const completedCount = records.filter(
    (record) => record.status === "completed",
  ).length;
  const commandCount = records.filter((record) => record.role === "command").length;
  const processCount = records.filter(
    (record) => record.role === "reasoning" || record.role === "commentary",
  ).length;
  const hasRoleDetails = commandCount > 0 || processCount > 0;
  const stepBreakdown = hasRoleDetails
    ? `${records.length} 个步骤（${commandCount} 个操作，${processCount} 条处理）`
    : `${records.length} 个步骤`;
  const latestRunning = running.at(-1);

  if (finalized) {
    return {
      status: "completed",
      title: "已处理",
      detail: "处理概要已收起",
      progress: stepBreakdown,
      defaultExpanded: false,
    };
  }
  if (running.length > 0) {
    return {
      status: "running",
      title: "正在执行",
      detail: latestRunning?.title ?? "正在等待当前步骤",
      progress: `${completedCount} / ${records.length} 已完成${
        hasRoleDetails ? `（${commandCount} 个操作）` : ""
      }`,
      defaultExpanded: true,
    };
  }
  if (active) {
    return {
      status: "running",
      title: "正在执行",
      detail: "Codex 正在继续处理",
      progress:
        records.length > 0
          ? `已同步 ${stepBreakdown}，等待下一步`
          : "正在等待首个执行步骤",
      defaultExpanded: true,
    };
  }
  if (failed.length > 0) {
    return {
      status: "failed",
      title: "任务过程有错误",
      detail: failed.at(-1)?.title ?? "请查看失败步骤",
      progress: hasRoleDetails
        ? `${failed.length} 个失败；${stepBreakdown}`
        : `${failed.length} 个失败`,
      defaultExpanded: true,
    };
  }
  if (records.length > 0 && completedCount === records.length) {
    return {
      status: "completed",
      title: "已处理",
      detail: "处理概要已收起",
      progress: stepBreakdown,
      defaultExpanded: false,
    };
  }
  return {
    status: "unknown",
    title: "任务过程",
    detail: "已记录执行活动",
    progress: stepBreakdown,
    defaultExpanded: false,
  };
}

export function elapsedExecutionLabel(
  startedAt: string | null,
  currentTime = Date.now(),
): string | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || started > currentTime) return null;
  const totalSeconds = Math.max(0, Math.floor((currentTime - started) / 1_000));
  if (totalSeconds < 2) return "刚刚开始";
  if (totalSeconds < 60) return `已运行 ${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `已运行 ${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `已运行 ${hours} 小时 ${minutes % 60} 分`;
}

export function completedExecutionDurationLabel(
  records: readonly Pick<ReadableExecution, "createdAt">[],
  completedAt: string | null = null,
): string | null {
  const timestamps = records
    .map((record) => (record.createdAt ? Date.parse(record.createdAt) : Number.NaN))
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  const started = Math.min(...timestamps);
  if (!completedAt && Math.max(...timestamps) === started) return null;
  const completed = completedAt ? Date.parse(completedAt) : Math.max(...timestamps);
  if (!Number.isFinite(completed) || completed < started) return null;
  const totalSeconds = Math.max(0, Math.floor((completed - started) / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

