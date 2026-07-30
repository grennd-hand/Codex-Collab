import { describe, expect, it, vi } from "vitest";
import type { Member, Message } from "@codex-collab/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ExecutionProcess,
  completedExecutionDurationLabel,
  elapsedExecutionLabel,
  executionProcessPresentation,
  resolveExecutionProcessExpanded,
} from "./features/timeline/execution/ExecutionProcess.js";
import {
  canMemberStopCodex,
  chatMessageBody,
  codexExecutionPhase,
  composerPrimaryAction,
  filterUnsupportedImageAttachments,
  normalizeCodexOptionsForUi,
  restoreComposerControlFocus,
  shouldShowExecutionStatus,
  workspaceNeedsConversationLoad,
} from "./features/composer/codex-controls.js";

function command(
  kind: "codex_prompt" | "codex_stop",
  deliveryStatus: Message["deliveryStatus"],
): Pick<Message, "kind" | "deliveryStatus"> {
  return { kind, deliveryStatus };
}

function member(
  role: Member["role"],
  status: Member["status"] = "approved",
): Pick<Member, "role" | "status"> {
  return { role, status };
}

describe("workspaceNeedsConversationLoad", () => {
  it("keeps the conversation loader visible while a selected task is importing", () => {
    expect(
      workspaceNeedsConversationLoad({
        selectedThreadId: "thread-1",
        syncedAt: null,
      }),
    ).toBe(true);
  });

  it("hides the loader after the selected task snapshot is synchronized", () => {
    expect(
      workspaceNeedsConversationLoad({
        selectedThreadId: "thread-1",
        syncedAt: "2026-07-25T02:30:00.000Z",
      }),
    ).toBe(false);
  });

  it("does not show a conversation loader before a task is selected", () => {
    expect(
      workspaceNeedsConversationLoad({
        selectedThreadId: null,
        syncedAt: null,
      }),
    ).toBe(false);
    expect(workspaceNeedsConversationLoad(null)).toBe(false);
  });
});

describe("Codex execution controls", () => {
  it("shows a queued phase immediately after a web command is accepted", () => {
    expect(
      codexExecutionPhase([command("codex_prompt", "queued")], "idle"),
    ).toBe("queued");
  });

  it("keeps the running phase visible from realtime message or runtime state", () => {
    expect(
      codexExecutionPhase([command("codex_prompt", "submitted")], "idle"),
    ).toBe("running");
    expect(codexExecutionPhase([], "running")).toBe("running");
  });

  it("lets a final answer settle a stale global runtime state", () => {
    expect(
      codexExecutionPhase(
        [command("codex_prompt", "submitted")],
        "running",
        true,
      ),
    ).toBe("idle");
    expect(
      codexExecutionPhase(
        [
          command("codex_prompt", "submitted"),
          command("codex_stop", "submitted"),
        ],
        "running",
        true,
      ),
    ).toBe("idle");
  });

  it("allows an approved invited editor to stop an active shared task", () => {
    expect(canMemberStopCodex(member("editor"), "running")).toBe(true);
    expect(canMemberStopCodex(member("editor"), "queued")).toBe(true);
    expect(canMemberStopCodex(member("editor"), "stopping")).toBe(false);
    expect(canMemberStopCodex(member("owner"), "running")).toBe(true);
    expect(canMemberStopCodex(member("editor", "pending"), "running")).toBe(false);
  });

  it("switches the same primary composer button to stop even in chat mode", () => {
    expect(composerPrimaryAction("idle", "codex")).toBe("send_codex");
    expect(composerPrimaryAction("idle", "chat")).toBe("send_chat");
    expect(composerPrimaryAction("queued", "chat")).toBe("stop_codex");
    expect(composerPrimaryAction("running", "chat")).toBe("stop_codex");
    expect(composerPrimaryAction("stopping", "chat")).toBe("stop_codex");
  });

  it("shows stopping until the stop completes, then clears the execution state", () => {
    const prompt = command("codex_prompt", "submitted");

    expect(
      codexExecutionPhase(
        [prompt, command("codex_stop", "submitted")],
        "running",
      ),
    ).toBe("stopping");
    expect(canMemberStopCodex(member("editor"), "stopping")).toBe(false);
    expect(
      codexExecutionPhase(
        [prompt, command("codex_stop", "completed")],
        "running",
      ),
    ).toBe("idle");
  });

  it("hides the temporary running status after a live execution step appears", () => {
    expect(shouldShowExecutionStatus("queued", false)).toBe(true);
    expect(shouldShowExecutionStatus("stopping", true)).toBe(true);
    expect(shouldShowExecutionStatus("running", false)).toBe(true);
    expect(shouldShowExecutionStatus("running", true)).toBe(false);
    expect(shouldShowExecutionStatus("idle", false)).toBe(false);
  });
});

describe("Codex client-style task process", () => {
  it("keeps a manual disclosure choice across realtime status updates", () => {
    expect(resolveExecutionProcessExpanded(false, true)).toBe(true);
    expect(resolveExecutionProcessExpanded(true, false)).toBe(false);
    expect(resolveExecutionProcessExpanded(true, null)).toBe(true);
  });

  it("keeps active and failed work open while completed work starts collapsed", () => {
    expect(
      executionProcessPresentation([
        { status: "completed", title: "读取文件" },
        { status: "running", title: "运行测试" },
      ]),
    ).toEqual({
      status: "running",
      title: "正在执行",
      detail: "运行测试",
      progress: "1 / 2 已完成",
      defaultExpanded: true,
    });
    expect(
      executionProcessPresentation([{ status: "failed", title: "构建项目" }]),
    ).toMatchObject({
      status: "failed",
      title: "任务过程有错误",
      progress: "1 个失败",
      defaultExpanded: true,
    });
    expect(
      executionProcessPresentation([
        { status: "completed", title: "读取文件" },
        { status: "stopped", title: "运行测试" },
      ]),
    ).toMatchObject({
      status: "stopped",
      title: "已停止",
      detail: "运行测试",
      progress: "1 个未完成",
      defaultExpanded: true,
    });
    expect(
      executionProcessPresentation([{ status: "completed", title: "运行测试" }]),
    ).toMatchObject({
      status: "completed",
      title: "已处理",
      detail: "处理概要已收起",
      defaultExpanded: false,
    });
    expect(
      executionProcessPresentation(
        [{ status: "completed", title: "运行测试", role: "command" }],
        true,
      ),
    ).toMatchObject({
      status: "running",
      title: "正在执行",
      detail: "Codex 正在继续处理",
      defaultExpanded: true,
    });
    expect(
      executionProcessPresentation([
        { status: "completed", title: "运行测试", role: "command" },
        { status: "completed", title: "分析与计划", role: "reasoning" },
      ]).progress,
    ).toBe("2 个步骤（1 个操作，1 条处理）");
    expect(
      executionProcessPresentation(
        [
          { status: "running", title: "连接服务器", role: "command" },
          { status: "failed", title: "旧验证方式", role: "command" },
        ],
        true,
        true,
      ),
    ).toMatchObject({
      status: "completed",
      title: "已处理",
      defaultExpanded: false,
    });
  });

  it("renders an accessible collapse control with client-style defaults", () => {
    const imported = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        sourceLabel: "导入自 Codex 任务",
        historyKey: "collapsed-execution",
        historyEntryKeys: ["collapsed-step"],
        entries: [
          {
            id: "imported",
            role: "reasoning",
            text: "Imported reasoning",
            createdAt: null,
          },
        ],
      }),
    );
    expect(imported).toContain('aria-label="导入自 Codex 任务，处理概要"');
    expect(imported).toContain("导入自 Codex 任务：已处理");
    expect(imported).toContain('data-history-anchor="collapsed-execution"');
    expect(imported).not.toContain('data-history-anchor="collapsed-step"');

    const completed = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        completedAt: "2026-07-26T00:03:46.000Z",
        entries: [
          {
            id: "done",
            role: "command",
            text: "tool: exec_command\nstatus: completed\ninput:\n{\"cmd\":\"npm test\"}",
            createdAt: "2026-07-26T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(completed).toContain('aria-expanded="false"');
    expect(completed).toContain("已处理");
    expect(completed).toContain("耗时 3 分 46 秒");
    expect(completed).toContain("展开处理概要");
    expect(completed).not.toContain("查看执行详情");

    const finalizedWithStaleRunningStep = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        active: true,
        completedAt: "2026-07-26T00:03:46.000Z",
        entries: [
          {
            id: "stale-running",
            role: "command",
            text: "tool: exec_command\nstatus: running\ninput:\n{\"cmd\":\"npm test\"}",
            createdAt: "2026-07-26T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(finalizedWithStaleRunningStep).toContain('aria-expanded="false"');
    expect(finalizedWithStaleRunningStep).toContain("已处理");
    expect(finalizedWithStaleRunningStep).not.toContain("已运行");
    expect(finalizedWithStaleRunningStep).not.toContain("查看正在执行的内容");

    const running = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        active: true,
        entries: [
          {
            id: "running",
            role: "command",
            text: "tool: exec_command\nstatus: running\ninput:\n{\"cmd\":\"npm test\"}",
            createdAt: null,
          },
        ],
      }),
    );
    expect(running).toContain('aria-expanded="true"');
    expect(running).toContain("折叠任务过程");
    expect(running).toContain('role="status"');
    expect(running).toContain('aria-label="展开 运行测试"');
    expect(running).toContain('class="execution-step command running collapsed"');
    expect(running).toContain('title="npm test"');
    expect(running).not.toContain("execution-output-viewer");

    const stopped = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        entries: [
          {
            id: "stopped",
            role: "command",
            text: "tool: exec_command\nstatus: running\ninput:\n{\"cmd\":\"npm test\"}",
            createdAt: null,
          },
        ],
      }),
    );
    expect(stopped).toContain("execution-process stopped expanded");
    expect(stopped).toContain("任务已停止，该步骤未收到完成结果");
    expect(stopped).toContain("已停止");
    expect(stopped).not.toContain("fui-Spinner");

    const anchoredRunning = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        active: true,
        historyKey: "execution-page-group",
        historyEntryKeys: ["history-step-1"],
        entries: [
          {
            id: "duplicate-step-id",
            role: "command",
            text: "tool: exec_command\nstatus: running\ninput:\n{\"cmd\":\"npm test\"}",
            createdAt: null,
          },
        ],
      }),
    );
    expect(anchoredRunning).toContain('data-history-key="execution-page-group"');
    expect(anchoredRunning).toContain('data-history-anchor="history-step-1"');
    expect(anchoredRunning).not.toContain(
      'data-history-anchor="execution-page-group"',
    );

    const longOutput = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        entries: [
          {
            id: "long-output",
            role: "command",
            text: [
              "tool: exec_command",
              "status: failed",
              "input:",
              '{"cmd":"npm test"}',
              "output:",
              `first line\\n${"x".repeat(2_100)}\\nlast line\\nexit_code: 1`,
            ].join("\n"),
            createdAt: null,
          },
        ],
      }),
    );
    expect(longOutput).toContain("execution-output-viewer long");
    expect(longOutput).toContain('aria-label="复制完整命令输出"');
    expect(longOutput).toContain('tabindex="0"');
    expect(longOutput).toContain("可上下、左右滚动查看完整输出");

    const activeReasoning = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        active: true,
        entries: [
          {
            id: "reasoning",
            role: "reasoning",
            text: "Analyzing invite reuse behavior",
            createdAt: "2026-07-26T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(activeReasoning).toContain("正在执行");
    expect(activeReasoning).toContain("Analyzing invite reuse behavior");
    expect(activeReasoning).toContain('aria-label="展开 分析与计划"');
    expect(activeReasoning).not.toContain("查看 Codex 原始摘要");
    expect(activeReasoning).not.toContain("全部步骤已完成");

    const markdownReasoning = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        active: true,
        entries: [
          {
            id: "reasoning-markdown",
            role: "reasoning",
            text: "**Investigating relay DNS**\n**Planning stable routing**",
            createdAt: null,
          },
        ],
      }),
    );
    expect(markdownReasoning).toContain("Investigating relay DNS");
    expect(markdownReasoning).not.toContain("<strong>Investigating relay DNS</strong>");
    expect(markdownReasoning).not.toContain("**Investigating relay DNS**");

    const codeReasoning = renderToStaticMarkup(
      createElement(ExecutionProcess, {
        active: true,
        entries: [
          {
            id: "reasoning-code",
            role: "reasoning",
            text: "const ready = true;\nconsole.log(ready);",
            createdAt: null,
          },
        ],
      }),
    );
    expect(codeReasoning).toContain("const ready = true;");
    expect(codeReasoning).not.toContain("readable-code");
    expect(codeReasoning).not.toContain("<pre>const ready = true;");
  });

  it("formats a compact live elapsed-time label", () => {
    expect(elapsedExecutionLabel("2026-07-26T00:00:00.000Z", Date.parse("2026-07-26T00:00:01Z"))).toBe(
      "刚刚开始",
    );
    expect(elapsedExecutionLabel("2026-07-26T00:00:00.000Z", Date.parse("2026-07-26T00:02:09Z"))).toBe(
      "已运行 2 分 9 秒",
    );
    expect(elapsedExecutionLabel(null)).toBeNull();
  });

  it("formats a completed processing duration from the first step to the final answer", () => {
    expect(
      completedExecutionDurationLabel(
        [
          { createdAt: "2026-07-26T00:00:00.000Z" },
          { createdAt: "2026-07-26T00:02:00.000Z" },
        ],
        "2026-07-26T00:03:46.000Z",
      ),
    ).toBe("3 分 46 秒");
    expect(completedExecutionDurationLabel([{ createdAt: null }])).toBeNull();
    expect(
      completedExecutionDurationLabel([{ createdAt: "2026-07-26T00:00:00.000Z" }]),
    ).toBeNull();
  });
});

describe("Codex composer capability controls", () => {
  it("steps unsupported reasoning down and disables unsupported fast mode", () => {
    expect(
      normalizeCodexOptionsForUi({
        model: "gpt-5.6-luna",
        reasoningEffort: "ultra",
        speed: "fast",
      }),
    ).toMatchObject({ reasoningEffort: "max", speed: "fast" });
    expect(
      normalizeCodexOptionsForUi({
        model: "gpt-5.4-mini",
        reasoningEffort: "max",
        speed: "fast",
      }),
    ).toMatchObject({ reasoningEffort: "xhigh", speed: "standard" });
  });

  it("restores custom permissions safely and hides them in other modes", () => {
    expect(normalizeCodexOptionsForUi({ accessMode: "custom" })).toMatchObject({
      accessMode: "custom",
      customPermissions: {
        fileAccess: "workspace-write",
        approvalPolicy: "on-request",
      },
    });
    expect(
      normalizeCodexOptionsForUi({
        accessMode: "follow-desktop",
        customPermissions: {
          fileAccess: "full-access",
          approvalPolicy: "never",
        },
      }).customPermissions,
    ).toBeNull();
  });

  it("removes only image attachments for the text-only model", () => {
    const text = { file: { type: "text/plain" }, id: "text" };
    const image = { file: { type: "image/png" }, id: "image" };
    expect(
      filterUnsupportedImageAttachments("gpt-5.3-codex-spark", [text, image]),
    ).toEqual([text]);
    expect(filterUnsupportedImageAttachments("gpt-5.6-sol", [text, image])).toEqual([
      text,
      image,
    ]);
  });
});

describe("member chat attachments", () => {
  it("allows an attachment-only chat message while preserving typed text", () => {
    expect(chatMessageBody("", 2)).toBe("发送了 2 个附件");
    expect(chatMessageBody("  请看图片  ", 1)).toBe("请看图片");
    expect(chatMessageBody("", 0)).toBe("");
  });
});

describe("composer focus", () => {
  it("returns focus to the sent composer and places the cursor at the end", () => {
    const focus = vi.fn();
    const setSelectionRange = vi.fn();
    const schedule = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    restoreComposerControlFocus(
      {
        disabled: false,
        focus,
        setSelectionRange,
        value: "next message",
      },
      schedule,
    );

    expect(schedule).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(setSelectionRange).toHaveBeenCalledWith(12, 12);
  });

  it("does not focus a composer that remains disabled", () => {
    const focus = vi.fn();
    restoreComposerControlFocus(
      {
        disabled: true,
        focus,
        setSelectionRange: vi.fn(),
        value: "",
      },
      (callback) => {
        callback(0);
        return 1;
      },
    );
    expect(focus).not.toHaveBeenCalled();
  });
});
