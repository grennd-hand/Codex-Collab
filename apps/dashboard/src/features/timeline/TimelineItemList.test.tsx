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

describe("TimelineItemList active task presentation", () => {
  it("renders commentary as prose, folds old commands, and keeps the current command open", () => {
    const items: UnifiedTimelineItem[] = [
      {
        kind: "imported",
        item: {
          kind: "execution",
          id: "execution-live",
          entryKeys: [
            "commentary-1",
            "command-1",
            "command-2",
            "commentary-2",
            "command-3",
            "command-4",
            "commentary-3",
            "command-5",
          ],
          entries: [
            {
              id: "commentary-1",
              role: "assistant",
              phase: "commentary",
              text: "先核对同步状态，再运行验证。",
              createdAt: "2026-07-30T00:00:00.000Z",
            },
            {
              id: "command-1",
              role: "command",
              text: "tool: exec_command\nstatus: completed\ninput:\n{\"cmd\":\"npm test\"}",
              createdAt: "2026-07-30T00:00:01.000Z",
            },
            {
              id: "command-2",
              role: "command",
              text: "tool: exec_command\nstatus: completed\ninput:\n{\"cmd\":\"npm run test:relay\"}",
              createdAt: "2026-07-30T00:00:02.000Z",
            },
            {
              id: "commentary-2",
              role: "assistant",
              phase: "commentary",
              text: "测试通过，继续构建。",
              createdAt: "2026-07-30T00:00:03.000Z",
            },
            {
              id: "command-3",
              role: "command",
              text: "tool: exec_command\nstatus: completed\ninput:\n{\"cmd\":\"npm run lint\"}",
              createdAt: "2026-07-30T00:00:04.000Z",
            },
            {
              id: "command-4",
              role: "command",
              text: "tool: exec_command\nstatus: failed\ninput:\n{\"cmd\":\"npm run typecheck\"}\noutput:\nexit_code: 1",
              createdAt: "2026-07-30T00:00:05.000Z",
            },
            {
              id: "commentary-3",
              role: "assistant",
              phase: "commentary",
              text: "类型检查通过，开始生成发布资产。",
              createdAt: "2026-07-30T00:00:06.000Z",
            },
            {
              id: "command-5",
              role: "command",
              text: "tool: exec_command\nstatus: running\ninput:\n{\"cmd\":\"npm run build\"}",
              createdAt: "2026-07-30T00:00:07.000Z",
            },
          ],
        },
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(TimelineItemList, {
        items,
        memberId: "owner-1",
        executionPhase: "running",
        identityForMember: fallbackMemberIdentity,
        onOpenFile: vi.fn(),
      }),
    );

    expect(markup).toContain("execution-process running expanded streaming");
    expect(markup).toContain("先核对同步状态，再运行验证。");
    expect(markup).toContain("测试通过，继续构建。");
    expect(markup).toContain("类型检查通过，开始生成发布资产。");
    expect(markup).toContain("运行了多个命令");
    expect(markup).toContain('aria-label="展开 运行了 2 个命令"');
    expect(markup.match(/class="execution-command-batch /g)).toHaveLength(2);
    expect(markup).toContain("execution-command-batch collapsed has-failure");
    expect(markup).toContain('aria-label="展开 运行了 2 个命令，其中 1 个失败"');
    expect(markup).toContain("1 个失败");
    expect(markup).toContain('class="execution-step command running expanded"');
    expect(markup).toContain("npm run build");
    expect(markup).not.toContain("npm test");
    expect(markup).not.toContain("npm run test:relay");
    expect(markup).not.toContain("npm run lint");
    expect(markup).not.toContain("npm run typecheck");
    const firstBatch = markup.indexOf("运行了多个命令");
    const secondBatch = markup.lastIndexOf("运行了多个命令");
    expect(markup.indexOf("先核对同步状态，再运行验证。")).toBeLessThan(firstBatch);
    expect(firstBatch).toBeLessThan(markup.indexOf("测试通过，继续构建。"));
    expect(markup.indexOf("测试通过，继续构建。")).toBeLessThan(secondBatch);
    expect(secondBatch).toBeLessThan(
      markup.indexOf("类型检查通过，开始生成发布资产。"),
    );
    expect(
      markup.indexOf("类型检查通过，开始生成发布资产。"),
    ).toBeLessThan(markup.indexOf("npm run build"));
  });
});
