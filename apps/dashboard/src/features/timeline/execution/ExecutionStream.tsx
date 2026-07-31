import { ChevronDownRegular, HistoryRegular } from "@fluentui/react-icons";
import { useId, useState } from "react";
import type { ReadableExecution } from "./execution-presentation-types.js";
import type { IdeNavigationTarget } from "../../../ide/state/types.js";
import { ReadableOutput } from "../content/ReadableOutput.js";
import { timeLabel } from "./execution-process-presentation.js";
import {
  buildExecutionStreamBlocks,
  compactLiveExecutionStream,
  type ExecutionStreamRecord,
} from "./execution-stream-presentation.js";
import { ExecutionCommandBatch } from "./ExecutionCommandBatch.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";
import { ExecutionStepCard } from "./ExecutionStepCard.js";

function ExecutionHistoryBatch({
  items,
  historyEntryKeys,
  sourceLabel,
  onOpenFile,
}: {
  items: readonly ExecutionStreamRecord[];
  historyEntryKeys?: readonly (string | null)[];
  sourceLabel?: string | null;
  onOpenFile?: (target: IdeNavigationTarget) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const commandCount = items.filter(({ record }) => record.role === "command").length;
  const failedCount = items.filter(({ record }) => record.status === "failed").length;
  const label = `已运行 ${items.length} 个步骤`;
  const detail = commandCount > 0 ? `，其中 ${commandCount} 个命令` : "";
  const failure = failedCount > 0 ? `，${failedCount} 个失败` : "";
  const latestCreatedAt = items.at(-1)?.record.createdAt ?? null;

  return (
    <section
      className={`execution-command-batch execution-history-batch ${
        expanded ? "expanded" : "collapsed"
      }${failedCount > 0 ? " has-failure" : ""}`}
    >
      {!expanded
        ? items.map(({ index, record }) => {
            const historyKey = historyEntryKeys?.[index];
            return historyKey ? (
              <span
                className="execution-command-batch-anchor"
                data-history-anchor={historyKey}
                key={`history-anchor-${historyKey}-${record.id}`}
              />
            ) : null;
          })
        : null}
      <button
        type="button"
        className="execution-command-batch-disclosure"
        aria-controls={contentId}
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"} ${label}${detail}${failure}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <HistoryRegular aria-hidden="true" />
        <span>{label}</span>
        {failedCount > 0 ? (
          <span className="execution-command-batch-failure">{failedCount} 个失败</span>
        ) : null}
        {latestCreatedAt ? (
          <time dateTime={latestCreatedAt}>{timeLabel(latestCreatedAt)}</time>
        ) : null}
        <ChevronDownRegular className="execution-command-batch-chevron" aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="execution-command-batch-content" id={contentId}>
          <ExecutionStream
            records={items.map(({ record }) => record)}
            historyEntryKeys={items.map(({ index }) => historyEntryKeys?.[index] ?? null)}
            sourceLabel={sourceLabel}
            waitingForNextStep={false}
            onOpenFile={onOpenFile}
          />
        </div>
      ) : null}
    </section>
  );
}

export function ExecutionStream({
  records,
  historyEntryKeys,
  sourceLabel,
  waitingForNextStep = true,
  onOpenFile,
}: {
  records: readonly ReadableExecution[];
  historyEntryKeys?: readonly (string | null)[];
  sourceLabel?: string | null;
  waitingForNextStep?: boolean;
  onOpenFile?: (target: IdeNavigationTarget) => void;
}) {
  const compact = waitingForNextStep ? compactLiveExecutionStream(records) : null;
  const visibleRecords = compact?.current ? [compact.current.record] : records;
  const blocks = buildExecutionStreamBlocks(
    visibleRecords,
    compact?.current?.index ?? 0,
  );
  return (
    <div className="execution-stream">
      {compact && compact.history.length > 0 ? (
        <ExecutionHistoryBatch
          items={compact.history}
          historyEntryKeys={historyEntryKeys}
          sourceLabel={sourceLabel}
          onOpenFile={onOpenFile}
        />
      ) : null}
      {blocks.map((block) => {
        if (block.kind === "command-batch") {
          const first = block.items[0]!;
          return (
            <ExecutionCommandBatch
              key={`command-batch-${first.record.id}-${first.index}`}
              items={block.items}
              historyEntryKeys={historyEntryKeys}
              onOpenFile={onOpenFile}
            />
          );
        }

        const { index, record } = block.item;
        const historyKey = historyEntryKeys?.[index];
        if (block.kind === "commentary") {
          return (
            <article
              className="execution-commentary"
              data-history-anchor={historyKey ?? undefined}
              key={`commentary-${historyKey ?? `${record.id}-${index}`}`}
              aria-label={`${sourceLabel ? `${sourceLabel}，` : ""}Codex 处理进展`}
            >
              {record.input ? <ReadableOutput text={record.input} /> : null}
              {record.createdAt ? (
                <time dateTime={record.createdAt}>{timeLabel(record.createdAt)}</time>
              ) : null}
            </article>
          );
        }

        return (
          <ExecutionStepCard
            key={`${block.kind}-${historyKey ?? `${record.id}-${index}`}`}
            record={record}
            historyKey={historyKey}
            onOpenFile={onOpenFile}
          />
        );
      })}
      {waitingForNextStep && !compact?.current ? (
        <div className="execution-stream-waiting" role="status" aria-live="polite">
          <ExecutionStatusIcon status="running" fallback="reasoning" />
          <span>Codex 正在继续处理</span>
        </div>
      ) : null}
    </div>
  );
}
