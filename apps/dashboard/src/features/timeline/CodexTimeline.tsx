import { Button, Spinner } from "@fluentui/react-components";
import {
  ChatMultipleRegular,
  ChevronDownRegular,
  HistoryRegular,
  LockClosedRegular,
} from "@fluentui/react-icons";
import type { Member } from "@codex-collab/protocol";
import { useLayoutEffect, useRef, type RefObject } from "react";
import type { WorkspaceHistoryWindow } from "../../app/workspace-history-window.js";
import type { IdeNavigationTarget } from "../../ide/types.js";
import type { MemberIdentity } from "../collaboration/member-identity.js";
import type { CodexExecutionPhase } from "../composer/codex-controls.js";
import type { UnifiedTimelineItem } from "./imported-timeline.js";
import { shouldShowExecutionStatus } from "../composer/codex-controls.js";
import { TimelineItemList } from "./TimelineItemList.js";
import {
  historyScrollIntent,
  historyTopLoadDecision,
} from "./history-scroll.js";

interface CodexTimelineProps {
  streamRef: RefObject<HTMLElement | null>;
  history: WorkspaceHistoryWindow;
  initialLoading: boolean;
  hiddenUnassignedMessageCount: number;
  hasContent: boolean;
  member: Member | null;
  items: readonly UnifiedTimelineItem[];
  executionPhase: CodexExecutionPhase;
  executionEntryCount: number;
  hasRunningExecutionEntry: boolean;
  pinned: boolean;
  identityForMember: (memberId: string) => MemberIdentity;
  onPinnedChange: (pinned: boolean) => void;
  onLoadOlder: () => void;
  onRetry: () => void;
  onOpenFile: (target: IdeNavigationTarget) => void;
}

function ExecutionStatus({
  phase,
  entryCount,
}: {
  phase: CodexExecutionPhase;
  entryCount: number;
}) {
  return (
    <div className={`codex-execution-status ${phase}`} role="status" aria-live="polite">
      <Spinner size="tiny" />
      <div>
        <strong>
          {phase === "queued"
            ? "Codex 指令已排队"
            : phase === "stopping"
              ? "正在停止 Codex"
              : "正在运行"}
        </strong>
        <span>
          {phase === "queued"
            ? "等待共享任务开始执行"
            : phase === "stopping"
              ? "停止请求已发送，请稍候"
              : entryCount > 0
                ? `已显示 ${entryCount} 条过程记录，正在等待下一步`
                : "首个执行步骤到达后会显示在这里"}
        </span>
      </div>
    </div>
  );
}

export function CodexTimeline({
  streamRef,
  history,
  initialLoading,
  hiddenUnassignedMessageCount,
  hasContent,
  member,
  items,
  executionPhase,
  executionEntryCount,
  hasRunningExecutionEntry,
  pinned,
  identityForMember,
  onPinnedChange,
  onLoadOlder,
  onRetry,
  onOpenFile,
}: CodexTimelineProps) {
  const previousScrollTopRef = useRef(0);
  const topLoadLatchedRef = useRef(false);

  useLayoutEffect(() => {
    previousScrollTopRef.current = streamRef.current?.scrollTop ?? 0;
    topLoadLatchedRef.current = false;
  }, [history.threadId, streamRef]);

  const jumpToLatest = () => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.scrollTop = stream.scrollHeight;
    previousScrollTopRef.current = stream.scrollTop;
    onPinnedChange(true);
  };

  return (
    <section
      className="message-stream"
      aria-label="Codex 对话"
      aria-busy={initialLoading || history.olderLoading}
      ref={streamRef}
      onScroll={(event) => {
        const stream = event.currentTarget;
        const intent = historyScrollIntent(
          stream,
          previousScrollTopRef.current,
          history.hasOlder && !history.olderLoading,
        );
        previousScrollTopRef.current = stream.scrollTop;
        onPinnedChange(intent.pinned);
        const topLoad = historyTopLoadDecision(
          stream.scrollTop,
          intent.loadOlder,
          topLoadLatchedRef.current,
        );
        topLoadLatchedRef.current = topLoad.latched;
        if (topLoad.trigger) onLoadOlder();
      }}
    >
      {initialLoading ? (
        <div className="conversation-loading" role="status" aria-live="polite">
          <Spinner label="正在加载最近对话记录" labelPosition="below" size="medium" />
        </div>
      ) : (
        <>
          {history.hasOlder || history.olderLoading || history.error ? (
            <div className="history-page-control" role="status">
              {history.olderLoading ? (
                <><Spinner size="tiny" /><span>正在加载更早记录…</span></>
              ) : history.hasOlder ? (
                <Button
                  appearance="subtle"
                  icon={<HistoryRegular />}
                  size="small"
                  onClick={() => {
                    topLoadLatchedRef.current = true;
                    onLoadOlder();
                  }}
                >
                  查看更早记录
                </Button>
              ) : null}
              {history.error ? (
                <>
                  <span className="history-page-error">{history.error}</span>
                  <Button appearance="subtle" size="small" onClick={onRetry}>重试</Button>
                </>
              ) : null}
            </div>
          ) : null}
          {hiddenUnassignedMessageCount > 0 ? (
            <div className="timeline-provenance-notice" role="note">
              <HistoryRegular aria-hidden="true" />
              <div>
                <strong>已隐藏 {hiddenUnassignedMessageCount} 条未归属旧指令</strong>
                <span>这些消息没有 Codex 任务标识，不会作为当前任务消息显示。</span>
              </div>
            </div>
          ) : null}
          {!hasContent ? (
            <div className="message-empty">
              {member?.status === "pending" ? (
                <><LockClosedRegular /><h3>等待主人批准</h3><p>批准后，Codex 对话与执行记录会在这里实时同步。</p></>
              ) : (
                <><ChatMultipleRegular /><h3>Codex 对话从这里开始</h3><p>成员聊天已独立放在左侧，这里只显示当前 Codex 任务。</p></>
              )}
            </div>
          ) : (
            <TimelineItemList
              items={items}
              memberId={member?.id ?? null}
              executionPhase={executionPhase}
              identityForMember={identityForMember}
              onOpenFile={onOpenFile}
            />
          )}
        </>
      )}
      {!pinned && hasContent ? (
        <Button className="jump-to-latest" icon={<ChevronDownRegular />} onClick={jumpToLatest} size="small">
          跳到最新
        </Button>
      ) : null}
      {!initialLoading && shouldShowExecutionStatus(executionPhase, hasRunningExecutionEntry) ? (
        <ExecutionStatus phase={executionPhase} entryCount={executionEntryCount} />
      ) : null}
    </section>
  );
}
