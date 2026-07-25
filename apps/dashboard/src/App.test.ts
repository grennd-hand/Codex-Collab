import { describe, expect, it, vi } from "vitest";
import type { Member, Message } from "@codex-collab/protocol";
import {
  canMemberStopCodex,
  chatMessageBody,
  codexExecutionPhase,
  composerPrimaryAction,
  filterUnsupportedImageAttachments,
  normalizeCodexOptionsForUi,
  restoreComposerControlFocus,
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
