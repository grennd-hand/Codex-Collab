import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CodexFileChange, CodexRecordEntry, Message } from "@codex-collab/protocol";
import { fallbackMemberIdentity } from "../collaboration/member-identity.js";
import { TimelineItemList } from "./TimelineItemList.js";
import type { UnifiedTimelineItem } from "./history/imported-timeline.js";

function fileChange(index: number): CodexFileChange {
  return {
    operationId: `operation-${index}`,
    path: `src/file-${index}.ts`,
    kind: "modified",
    lifecycle: "completed",
    additions: index,
    deletions: 1,
  };
}

function completedItems(): UnifiedTimelineItem[] {
  const step: CodexRecordEntry = {
    id: "command-1",
    role: "command",
    text: "tool: apply_patch\nstatus: completed",
    createdAt: "2026-07-30T00:00:00.000Z",
    fileChanges: [1, 2, 3, 4].map(fileChange),
  };
  return [
    {
      kind: "imported",
      item: {
        kind: "execution",
        id: "execution-1",
        entries: [step],
        entryKeys: ["command-key"],
        completedAt: "2026-07-30T00:03:46.000Z",
      },
    },
    {
      kind: "imported",
      item: {
        kind: "message",
        key: "answer-key",
        entry: {
          id: "answer-1",
          role: "assistant",
          phase: "final_answer",
          text: "任务已经完成。\n\n- 构建通过\n- 文件已更新",
          createdAt: "2026-07-30T00:03:46.000Z",
        },
      },
    },
  ];
}

function renderTimeline(items: UnifiedTimelineItem[]): string {
  return renderToStaticMarkup(
    createElement(TimelineItemList, {
      items,
      memberId: "owner-1",
      executionPhase: "idle",
      identityForMember: fallbackMemberIdentity,
      onOpenFile: vi.fn(),
    }),
  );
}

describe("TimelineItemList completed task presentation", () => {
  it("groups an adjacent final answer with the collapsed execution and file summary", () => {
    const markup = renderTimeline(completedItems());

    expect(markup).toContain("execution-process completed collapsed has-completion");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("已处理");
    expect(markup).toContain("3 分 46 秒");
    expect(markup).toContain('aria-label="Codex 最终总结"');
    expect(markup).toContain("任务已经完成。");
    expect(markup).toContain("构建通过");
    expect(markup).toContain("已编辑");
    expect(markup).toContain("4 个文件");
    expect(markup).toContain("+10");
    expect(markup).toContain("-4");
    expect(markup).toContain("再显示 1 个文件");
    expect(markup).toContain('data-history-anchor="answer-key"');
    expect(markup).not.toContain("imported-message assistant");
  });

  it("does not reorder a final answer across an intervening timeline item", () => {
    const items = completedItems();
    const message: Message = {
      id: "prompt-2",
      sessionId: "session-1",
      senderMemberId: "owner-1",
      senderDisplayName: "Owner",
      kind: "codex_prompt",
      body: "下一条任务",
      attachments: [],
      codexOptions: null,
      deliveryStatus: "submitted",
      codexTurnId: null,
      workspaceThreadId: "thread-1",
      completedAt: null,
      createdAt: "2026-07-30T00:02:00.000Z",
    };
    items.splice(1, 0, { kind: "shared", message });
    const markup = renderTimeline(items);

    expect(markup).not.toContain("execution-completion-summary");
    expect(markup).toContain("imported-message assistant");
    expect(markup).toContain("下一条任务");
    expect(markup.indexOf("下一条任务")).toBeLessThan(
      markup.indexOf("任务已经完成。"),
    );
  });
});
