import { ChevronDownRegular, WindowConsoleRegular } from "@fluentui/react-icons";
import { useId, useState } from "react";
import type { IdeNavigationTarget } from "../../../ide/state/types.js";
import type { ExecutionStreamRecord } from "./execution-stream-presentation.js";
import { timeLabel } from "./execution-process-presentation.js";
import { ExecutionStepCard } from "./ExecutionStepCard.js";

export function ExecutionCommandBatch({
  items,
  historyEntryKeys,
  onOpenFile,
}: {
  items: readonly ExecutionStreamRecord[];
  historyEntryKeys?: readonly (string | null)[];
  onOpenFile?: (target: IdeNavigationTarget) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const label = items.length === 1 ? "运行了 1 个命令" : "运行了多个命令";
  const failedCount = items.filter(({ record }) => record.status === "failed").length;
  const failureLabel = failedCount > 0 ? `${failedCount} 个失败` : null;
  const accessibleLabel = `运行了 ${items.length} 个命令${
    failureLabel ? `，其中 ${failureLabel}` : ""
  }`;
  const latestCreatedAt = items.at(-1)?.record.createdAt ?? null;

  return (
    <section
      className={`execution-command-batch ${expanded ? "expanded" : "collapsed"}${
        failureLabel ? " has-failure" : ""
      }`}
    >
      {!expanded
        ? items.map(({ index, record }) => {
            const historyKey = historyEntryKeys?.[index];
            return historyKey ? (
              <span
                className="execution-command-batch-anchor"
                data-history-anchor={historyKey}
                key={`anchor-${historyKey}-${record.id}`}
              />
            ) : null;
          })
        : null}
      <button
        type="button"
        className="execution-command-batch-disclosure"
        aria-controls={contentId}
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"} ${accessibleLabel}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <WindowConsoleRegular aria-hidden="true" />
        <span>{label}</span>
        {failureLabel ? (
          <span className="execution-command-batch-failure">{failureLabel}</span>
        ) : null}
        {latestCreatedAt ? (
          <time dateTime={latestCreatedAt}>{timeLabel(latestCreatedAt)}</time>
        ) : null}
        <ChevronDownRegular className="execution-command-batch-chevron" aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="execution-command-batch-content" id={contentId}>
          {items.map(({ index, record }) => (
            <ExecutionStepCard
              key={`command-${historyEntryKeys?.[index] ?? `${record.id}-${index}`}`}
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
