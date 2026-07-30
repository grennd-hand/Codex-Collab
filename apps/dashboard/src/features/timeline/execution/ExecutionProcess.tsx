import { ChevronDownRegular } from "@fluentui/react-icons";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { CodexRecordEntry } from "@codex-collab/protocol";
import {
  IdeFileChanges,
  navigationTargetForFileChange,
} from "../../../ide/changes/IdeFileChanges.js";
import type { IdeNavigationTarget } from "../../../ide/state/types.js";
import { ReadableOutput } from "../content/ReadableOutput.js";
import {
  collectExecutionFileChanges,
  presentExecutionEntries,
} from "../content/readable-output.js";
import { ExecutionStepCard } from "./ExecutionStepCard.js";
import {
  completedExecutionDurationLabel,
  executionProcessPresentation,
  resolveExecutionProcessExpanded,
} from "./execution-process-presentation.js";
import {
  ExecutionElapsedTime,
  ExecutionStatusIcon,
} from "./ExecutionStatusIcon.js";

export { ReadableOutput } from "../content/ReadableOutput.js";
export {
  completedExecutionDurationLabel,
  elapsedExecutionLabel,
  executionProcessPresentation,
  resolveExecutionProcessExpanded,
  type ExecutionProcessPresentation,
} from "./execution-process-presentation.js";

export function ExecutionProcess({
  entries,
  active = false,
  completedAt = null,
  historyKey,
  historyEntryKeys,
  completion,
  sourceLabel = null,
  onOpenFile,
}: {
  entries: CodexRecordEntry[];
  active?: boolean;
  completedAt?: string | null;
  historyKey?: string;
  historyEntryKeys?: readonly (string | null)[];
  completion?: {
    entry: CodexRecordEntry;
    historyKey?: string;
  } | null;
  sourceLabel?: string | null;
  onOpenFile?: (target: IdeNavigationTarget) => void;
}) {
  const finalized = Boolean(completedAt || completion);
  const records = presentExecutionEntries(entries, active && !finalized, finalized);
  const completedFileChanges = completion
    ? collectExecutionFileChanges(entries)
    : [];
  const presentation = executionProcessPresentation(
    records,
    active && !finalized,
    finalized,
  );
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const previousStatusRef = useRef(presentation.status);
  const expanded = resolveExecutionProcessExpanded(
    presentation.defaultExpanded,
    manualExpanded,
  );
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

  useLayoutEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = presentation.status;
    if (
      previousStatus !== presentation.status &&
      (presentation.status === "failed" || presentation.status === "stopped")
    ) {
      setManualExpanded(null);
    }
  }, [presentation.status]);
  return (
    <section
      className={`execution-process ${presentation.status} ${
        expanded ? "expanded" : "collapsed"
      }${completion ? " has-completion" : ""}`}
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
          onClick={() => setManualExpanded(!expanded)}
        >
          <span className="execution-process-status-icon" aria-hidden="true">
            <ExecutionStatusIcon
              status={presentation.status}
              fallback="reasoning"
            />
          </span>
          <span className="execution-process-title">
            <strong>
              {sourceLabel &&
              !(presentation.status === "completed" && completion)
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
            {completedDuration ? <span>{completedDuration}</span> : null}
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
      {completion ? (
        <div className="execution-completion">
          <article
            className="execution-completion-summary"
            data-history-anchor={completion.historyKey}
            data-history-key={completion.historyKey}
            aria-label="Codex 最终总结"
          >
            <ReadableOutput text={completion.entry.text} />
          </article>
          {completedFileChanges.length > 0 ? (
            <IdeFileChanges
              changes={completedFileChanges}
              className="execution-completion-files"
              title="已编辑"
              defaultExpanded
              initialVisibleCount={3}
              onOpenFile={
                onOpenFile
                  ? (_path, change) =>
                      onOpenFile(navigationTargetForFileChange(change))
                  : undefined
              }
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
