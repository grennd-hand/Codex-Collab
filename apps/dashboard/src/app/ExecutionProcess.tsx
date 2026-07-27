import { Button, Spinner } from "@fluentui/react-components";
import {
  CheckmarkCircleRegular,
  ChevronDownRegular,
  CopyRegular,
  DismissRegular,
  DocumentRegular,
  HistoryRegular,
} from "@fluentui/react-icons";
import { useEffect, useId, useState, type ReactNode } from "react";
import type { CodexRecordEntry } from "@codex-collab/protocol";
import { copyText } from "../clipboard.js";
import {
  classifyReadableSource,
  executionOutputNeedsViewport,
  parseReadableBlocks,
  presentExecutionEntries,
  type ExecutionStatus,
  type ReadableExecution,
} from "../readable-output.js";
import { IdeFileChanges } from "../ide/IdeFileChanges.js";
import type { IdeNavigationTarget } from "../ide/types.js";

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderInlineText(text: string): ReactNode[] {
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  return text.split(pattern).filter(Boolean).map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) {
      return (
        <a
          href={link[2]}
          key={`${index}-${part}`}
          rel="noreferrer"
          target="_blank"
        >
          {link[1]}
        </a>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${index}-${part}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${index}-${part}`}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export function ReadableOutput({ text }: { text: string }) {
  const blocks = parseReadableBlocks(text);
  return (
    <div className="readable-output">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "heading") {
          return block.level === 3 ? (
            <h4 key={key}>{renderInlineText(block.text)}</h4>
          ) : (
            <h3 className={`level-${block.level}`} key={key}>
              {renderInlineText(block.text)}
            </h3>
          );
        }
        if (block.kind === "unordered-list") {
          return (
            <ul key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`}>{renderInlineText(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "ordered-list") {
          return (
            <ol key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`}>{renderInlineText(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.kind === "quote") {
          return <blockquote key={key}>{renderInlineText(block.text)}</blockquote>;
        }
        if (block.kind === "code") {
          return (
            <div className="readable-code" key={key}>
              {block.language ? <span>{block.language}</span> : null}
              <pre>{block.text}</pre>
            </div>
          );
        }
        return <p key={key}>{renderInlineText(block.text)}</p>;
      })}
    </div>
  );
}

function ReadableSource({ text }: { text: string }) {
  if (classifyReadableSource(text) === "code") {
    return (
      <div className="readable-code">
        <span>代码</span>
        <pre>{text}</pre>
      </div>
    );
  }
  return <ReadableOutput text={text} />;
}

function executionStatusLabel(status: ExecutionStatus): string {
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

function ExecutionElapsedTime({ startedAt }: { startedAt: string }) {
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    setCurrentTime(Date.now());
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const label = elapsedExecutionLabel(startedAt, currentTime);
  return label ? <span>{label}</span> : null;
}

function ExecutionStatusIcon({
  status,
  fallback,
}: {
  status: ExecutionStatus;
  fallback: "command" | "reasoning";
}) {
  if (status === "running") return <Spinner size="tiny" />;
  if (status === "completed") return <CheckmarkCircleRegular />;
  if (status === "failed") return <DismissRegular />;
  return fallback === "command" ? <DocumentRegular /> : <HistoryRegular />;
}

function ExecutionStepCard({
  record,
  compact = false,
  historyKey,
  onOpenFile,
}: {
  record: ReadableExecution;
  compact?: boolean;
  historyKey?: string | null;
  onOpenFile?: (target: IdeNavigationTarget) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(
    record.status === "running" || record.status === "failed",
  );
  const [outputCopied, setOutputCopied] = useState(false);
  const outputNeedsViewport = executionOutputNeedsViewport(record.output);

  useEffect(() => {
    setDetailsOpen(record.status === "running" || record.status === "failed");
  }, [record.status]);

  useEffect(() => {
    setOutputCopied(false);
  }, [record.output]);

  return (
    <article
      className={`execution-step ${record.role} ${record.status}${compact ? " compact" : ""}`}
      data-history-anchor={historyKey ?? undefined}
    >
      <div className="execution-step-marker" aria-hidden="true">
        <ExecutionStatusIcon
          status={record.status}
          fallback={record.role === "command" ? "command" : "reasoning"}
        />
      </div>
      <div className="execution-step-content">
        <header>
          <div>
            <strong>{record.title}</strong>
            <span className={`execution-state ${record.status}`}>
              {executionStatusLabel(record.status)}
            </span>
          </div>
          {record.createdAt ? (
            <time dateTime={record.createdAt}>{timeLabel(record.createdAt)}</time>
          ) : null}
        </header>
        <p className="execution-step-summary">{record.summary}</p>
        {(record.role === "reasoning" || record.role === "commentary") &&
        record.input ? (
          <ReadableOutput text={record.input} />
        ) : null}
        {record.role === "reasoning" && record.sourceText ? (
          <details className="execution-details reasoning-source">
            <summary>
              <span>查看 Codex 原始摘要</span>
              <small>内容可能为英文</small>
            </summary>
            <div className="execution-detail-body">
              <div className="reasoning-source-content">
                <span>原始摘要</span>
                <ReadableSource text={record.sourceText} />
              </div>
            </div>
          </details>
        ) : null}
        {record.fileChanges.length > 0 ? (
          <IdeFileChanges
            changes={record.fileChanges}
            title={
              record.status === "running"
                ? "正在编辑文件"
                : record.status === "failed"
                  ? "文件编辑失败"
                  : `编辑了 ${record.fileChanges.length} 个文件`
            }
            defaultExpanded={
              record.status === "running" || record.status === "failed"
            }
            onOpenFile={
              onOpenFile
                ? (path, change) =>
                    onOpenFile({
                      path,
                      ...(change.line ? { line: change.line } : {}),
                      ...(change.column ? { column: change.column } : {}),
                    })
                : undefined
            }
          />
        ) : null}
        {record.role === "command" && (record.input || record.output) ? (
          <details className="execution-details" open={detailsOpen}>
            <summary
              onClick={(event) => {
                event.preventDefault();
                setDetailsOpen((current) => !current);
              }}
            >
              <span>
                {record.status === "running"
                  ? "查看正在执行的内容"
                  : record.status === "failed"
                    ? "查看失败详情"
                    : "查看执行详情"}
              </span>
              {record.outputLineCount > 0 ? (
                <small>{record.outputLineCount} 行输出</small>
              ) : null}
            </summary>
            <div className="execution-detail-body">
              {record.input ? (
                <div className="execution-input">
                  <span>命令</span>
                  <pre>{record.input}</pre>
                </div>
              ) : null}
              {record.output ? (
                <div
                  className={`execution-output-viewer${outputNeedsViewport ? " long" : ""}`}
                >
                  <div className="execution-output-toolbar">
                    <strong>输出</strong>
                    <small>{record.outputLineCount} 行</small>
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<CopyRegular />}
                      aria-label="复制完整命令输出"
                      onClick={() => {
                        void copyText(record.output ?? "").then(setOutputCopied);
                      }}
                    >
                      {outputCopied ? "已复制" : "复制"}
                    </Button>
                  </div>
                  <pre
                    tabIndex={0}
                    aria-label="命令输出，可在框内滚动查看完整内容"
                  >
                    {record.output}
                  </pre>
                  <div className="execution-output-footer">
                    <span className={`execution-output-result ${record.status}`}>
                      {executionStatusLabel(record.status)}
                    </span>
                    <span>
                      {outputNeedsViewport
                        ? "可上下、左右滚动查看完整输出"
                        : "可滚动查看完整输出"}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

export function ExecutionProcess({
  entries,
  active = false,
  completedAt = null,
  historyKey,
  historyEntryKeys,
  sourceLabel = null,
  onOpenFile,
}: {
  entries: CodexRecordEntry[];
  active?: boolean;
  completedAt?: string | null;
  historyKey?: string;
  historyEntryKeys?: readonly (string | null)[];
  sourceLabel?: string | null;
  onOpenFile?: (target: IdeNavigationTarget) => void;
}) {
  const finalized = Boolean(completedAt);
  const records = presentExecutionEntries(entries, active && !finalized, finalized);
  const presentation = executionProcessPresentation(
    records,
    active && !finalized,
    finalized,
  );
  const [expanded, setExpanded] = useState(presentation.defaultExpanded);
  const contentId = useId();
  const runningStartedAt =
    presentation.status === "running"
      ? (records.find((record) => record.createdAt)?.createdAt ?? null)
      : null;
  const completedDuration =
    presentation.status === "completed"
      ? completedExecutionDurationLabel(records, completedAt)
      : null;
  const disclosureAction =
    presentation.status === "completed"
      ? expanded
        ? "收起处理概要"
        : "展开处理概要"
      : expanded
        ? "折叠任务过程"
        : "展开任务过程";

  useEffect(() => {
    setExpanded(presentation.defaultExpanded);
  }, [presentation.defaultExpanded, presentation.status]);
  return (
    <section
      className={`execution-process ${presentation.status} ${
        expanded ? "expanded" : "collapsed"
      }`}
      data-history-key={historyKey}
      data-history-anchor={expanded ? undefined : historyKey}
      aria-label={`${sourceLabel ? `${sourceLabel}，` : ""}${
        presentation.status === "completed" ? "处理概要" : "任务过程"
      }`}
    >
      <span
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {presentation.title}：{completedDuration ? `耗时 ${completedDuration}，` : ""}
        {presentation.detail}，{presentation.progress}
      </span>
      <header className="execution-process-heading">
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={`${presentation.title}：${presentation.detail}，${
            presentation.progress
          }，${disclosureAction}`}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="execution-process-status-icon" aria-hidden="true">
            <ExecutionStatusIcon
              status={presentation.status}
              fallback="reasoning"
            />
          </span>
          <span className="execution-process-title">
            <strong>
              {sourceLabel
                ? `${sourceLabel}：${presentation.title}`
                : presentation.title}
            </strong>
            {presentation.status !== "completed" || expanded ? (
              <span>{presentation.detail}</span>
            ) : null}
          </span>
          <span className="execution-process-meta">
            {runningStartedAt ? (
              <ExecutionElapsedTime startedAt={runningStartedAt} />
            ) : null}
            {completedDuration ? <span>耗时 {completedDuration}</span> : null}
            {presentation.status !== "completed" ||
            expanded ||
            !completedDuration ? (
              <span>{presentation.progress}</span>
            ) : null}
          </span>
          <ChevronDownRegular
            className="execution-process-chevron"
            aria-hidden="true"
          />
        </button>
      </header>
      {expanded ? (
        <div className="execution-step-list" id={contentId}>
          {records.map((record, index) => (
            <ExecutionStepCard
              key={`codex-${historyEntryKeys?.[index] ?? `${record.id}-${index}`}`}
              record={record}
              historyKey={historyEntryKeys?.[index]}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
