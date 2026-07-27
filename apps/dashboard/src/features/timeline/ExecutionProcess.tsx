import { ChevronDownRegular } from "@fluentui/react-icons";
import { useEffect, useId, useState } from "react";
import type { CodexRecordEntry } from "@codex-collab/protocol";
import type { IdeNavigationTarget } from "../../ide/types.js";
import { presentExecutionEntries } from "./readable-output.js";
import { ExecutionStepCard } from "./ExecutionStepCard.js";
import {
  completedExecutionDurationLabel,
  executionProcessPresentation,
} from "./execution-process-presentation.js";
import {
  ExecutionElapsedTime,
  ExecutionStatusIcon,
} from "./ExecutionStatusIcon.js";

export { ReadableOutput } from "./ReadableOutput.js";
export {
  completedExecutionDurationLabel,
  elapsedExecutionLabel,
  executionProcessPresentation,
  type ExecutionProcessPresentation,
} from "./execution-process-presentation.js";

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
