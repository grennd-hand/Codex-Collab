import type { ReadableExecution } from "./execution-presentation-types.js";
import type { IdeNavigationTarget } from "../../../ide/state/types.js";
import { ReadableOutput } from "../content/ReadableOutput.js";
import { timeLabel } from "./execution-process-presentation.js";
import {
  buildExecutionStreamBlocks,
  hasLiveExecutionRecord,
} from "./execution-stream-presentation.js";
import { ExecutionCommandBatch } from "./ExecutionCommandBatch.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";
import { ExecutionStepCard } from "./ExecutionStepCard.js";

export function ExecutionStream({
  records,
  historyEntryKeys,
  sourceLabel,
  onOpenFile,
}: {
  records: readonly ReadableExecution[];
  historyEntryKeys?: readonly (string | null)[];
  sourceLabel?: string | null;
  onOpenFile?: (target: IdeNavigationTarget) => void;
}) {
  const blocks = buildExecutionStreamBlocks(records);
  return (
    <div className="execution-stream">
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
      {!hasLiveExecutionRecord(records) ? (
        <div className="execution-stream-waiting" role="status" aria-live="polite">
          <ExecutionStatusIcon status="running" fallback="reasoning" />
          <span>Codex 正在继续处理</span>
        </div>
      ) : null}
    </div>
  );
}
