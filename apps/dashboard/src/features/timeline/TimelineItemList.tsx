import { AttachRegular, BotRegular, HistoryRegular } from "@fluentui/react-icons";
import type { UnifiedTimelineItem } from "./history/imported-timeline.js";
import type { MemberIdentity } from "../collaboration/member-identity.js";
import type { CodexExecutionPhase } from "../composer/codex-controls.js";
import type { IdeNavigationTarget } from "../../ide/state/types.js";
import { formatFileSize } from "../composer/attachments.js";
import { shortTimeLabel } from "../../shared/date-time.js";
import { deliveryStatusLabel } from "./content/message-status.js";
import { ExecutionProcess, ReadableOutput } from "./execution/ExecutionProcess.js";

interface TimelineItemListProps {
  items: readonly UnifiedTimelineItem[];
  memberId: string | null;
  executionPhase: CodexExecutionPhase;
  identityForMember: (memberId: string) => MemberIdentity;
  onOpenFile: (target: IdeNavigationTarget) => void;
}

function SharedTimelineMessage({
  item,
  mine,
  identity,
}: {
  item: Extract<UnifiedTimelineItem, { kind: "shared" }>["message"];
  mine: boolean;
  identity: MemberIdentity;
}) {
  const isCodexCommand = item.kind === "codex_prompt" || item.kind === "codex_stop";
  return (
    <article
      className={`message identity-message ${mine ? "mine" : ""} ${
        isCodexCommand ? "codex-message" : ""
      }`}
      style={identity.style}
      data-history-anchor={`shared:${item.id}`}
      data-history-key={`shared:${item.id}`}
    >
      <div className="message-meta">
        <span>{item.senderDisplayName}</span>
        <span>
          {item.kind === "codex_prompt"
            ? "Codex 指令"
            : item.kind === "codex_stop"
              ? "停止指令"
              : "聊天"}
        </span>
        {deliveryStatusLabel(item) ? (
          <span className={`delivery-status ${item.deliveryStatus ?? "queued"}`}>
            {deliveryStatusLabel(item)}
          </span>
        ) : null}
        <time dateTime={item.createdAt}>{shortTimeLabel(item.createdAt)}</time>
      </div>
      <div className="message-bubble">
        {isCodexCommand ? <BotRegular aria-hidden="true" /> : null}
        <div className="message-content">
          <p>{item.body}</p>
          {item.attachments.length > 0 ? (
            <div className="message-attachments">
              {item.attachments.map((attachment) => (
                <span key={attachment.id}>
                  <AttachRegular aria-hidden="true" />
                  <span>{attachment.name}</span>
                  <small>{formatFileSize(attachment.size)}</small>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ImportedTimelineMessage({
  item,
}: {
  item: Extract<UnifiedTimelineItem, { kind: "imported" }>["item"] & {
    kind: "message";
  };
}) {
  const { entry } = item;
  const key = item.key ?? entry.id;
  return (
    <article
      aria-label={`导入自 Codex 任务，${
        entry.role === "user" ? "历史用户输入" : "Codex 回复"
      }`}
      className={`message imported-message ${entry.role}`}
      data-history-anchor={key}
      data-history-key={key}
    >
      <div className="message-meta">
        <span className="imported-history-source">
          <HistoryRegular aria-hidden="true" />
          导入自 Codex 任务
        </span>
        <span>{entry.role === "user" ? "历史用户输入" : "Codex 回复"}</span>
        {entry.createdAt ? (
          <time dateTime={entry.createdAt}>{shortTimeLabel(entry.createdAt)}</time>
        ) : null}
      </div>
      <div className="message-bubble">
        {entry.role === "assistant" ? <BotRegular aria-hidden="true" /> : null}
        <div className="message-content">
          {entry.role === "assistant" ? (
            <ReadableOutput text={entry.text} />
          ) : (
            <p>{entry.text}</p>
          )}
        </div>
      </div>
    </article>
  );
}

export function TimelineItemList({
  items,
  memberId,
  executionPhase,
  identityForMember,
  onOpenFile,
}: TimelineItemListProps) {
  return items.map((timelineItem, index) => {
    if (timelineItem.kind === "shared") {
      const item = timelineItem.message;
      return (
        <SharedTimelineMessage
          key={`shared-${item.id}`}
          item={item}
          mine={item.senderMemberId === memberId}
          identity={identityForMember(item.senderMemberId)}
        />
      );
    }
    if (timelineItem.item.kind === "message") {
      const item = timelineItem.item;
      return <ImportedTimelineMessage key={`codex-${item.key ?? item.entry.id}`} item={item} />;
    }
    const item = timelineItem.item;
    return (
      <ExecutionProcess
        active={executionPhase === "running" && index === items.length - 1}
        entries={item.entries}
        completedAt={item.completedAt ?? null}
        historyKey={item.id}
        historyEntryKeys={item.entryKeys}
        key={item.id}
        sourceLabel="导入自 Codex 任务"
        onOpenFile={onOpenFile}
      />
    );
  });
}
