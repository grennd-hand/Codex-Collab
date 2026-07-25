import { describe, expect, it } from "vitest";
import type { Member, Message } from "@codex-collab/protocol";
import {
  canMemberStopCodex,
  codexExecutionPhase,
  composerPrimaryAction,
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
