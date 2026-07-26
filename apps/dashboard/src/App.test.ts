import { describe, expect, it, vi } from "vitest";
import type { Member, Message } from "@codex-collab/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ExecutionProcess,
  canMemberStopCodex,
  chatMessageBody,
  codexExecutionPhase,
  composerPrimaryAction,
  elapsedExecutionLabel,
  executionProcessPresentation,
  filterUnsupportedImageAttachments,
  normalizeCodexOptionsForUi,
  restoreComposerControlFocus,
  shouldShowExecutionStatus,
  workspaceNeedsConversationLoad,
} from "./App.js";

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
  it("keeps active and failed work open while completed work starts collapsed", () => {
    expect(
      executionProcessPresentation([
        { status: "completed", title: "读取文件" },
        { status: "running", title: "运行测试" },
      ]),
    ).toEqual({
      status: "running",
      title: "正在运行",
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
      executionProcessPresentation([{ status: "completed", title: "运行测试" }]),
    ).toMatchObject({
      status: "completed",
      detail: "全部步骤已完成",
      defaultExpanded: false,
    });
  });

  it("renders an accessible collapse control with client-style defaults", () => {
    const completed = renderToStaticMarkup(
      createElement(ExecutionProcess, {
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
    expect(completed).toContain("全部步骤已完成");
    expect(completed).toContain("展开任务过程");
    expect(completed).not.toContain("查看执行详情");

    const running = renderToStaticMarkup(
      createElement(ExecutionProcess, {
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
    expect(running).toContain("正在运行");
    expect(running).toContain('role="status"');
    expect(running).toContain("查看正在执行的内容");
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
