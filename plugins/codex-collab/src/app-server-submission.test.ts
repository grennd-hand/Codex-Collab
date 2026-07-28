import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  buildCodexTurnStartParams,
  decodeInlineTextAttachment,
} from "./app-server-client.js";

describe("Codex app-server submission", () => {
  it("inlines bounded UTF-8 text attachments without shell access", () => {
    expect(
      decodeInlineTextAttachment({
        name: "notes.txt",
        mediaType: "text/plain",
        content: new TextEncoder().encode("ATTACHMENT_DIRECT_OK"),
      }),
    ).toBe("ATTACHMENT_DIRECT_OK");
    expect(
      decodeInlineTextAttachment({
        name: "archive.bin",
        mediaType: "application/octet-stream",
        content: new Uint8Array([0, 1, 2]),
      }),
    ).toBeNull();
  });

  it("maps the web composer settings to direct app-server turn parameters", () => {
    expect(
      buildCodexTurnStartParams({
        threadId: "thread-1",
        userInput: [
          { type: "text", text: "Run checks", text_elements: [] },
          {
            type: "localImage",
            path: "C:\\temp\\diagram.png",
            detail: "auto",
          },
          {
            type: "mention",
            name: "notes.txt",
            path: "C:\\temp\\notes.txt",
          },
        ],
        options: {
          accessMode: "full-access",
          customPermissions: null,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          speed: "fast",
          planMode: true,
        },
        currentModel: "gpt-5.4",
        currentReasoningEffort: "medium",
        peerDisplayName: "Owner",
        commandId: "prompt-1",
        ownerAuthored: true,
      }),
    ).toEqual({
      threadId: "thread-1",
      input: [
        { type: "text", text: "Run checks", text_elements: [] },
        {
          type: "localImage",
          path: "C:\\temp\\diagram.png",
          detail: "auto",
        },
        {
          type: "mention",
          name: "notes.txt",
          path: "C:\\temp\\notes.txt",
        },
      ],
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "priority",
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.6-sol",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
      responsesapiClientMetadata: {
        source: "codex-collab",
        collab_member: "Owner",
        collab_command_id: "prompt-1",
      },
    });
  });

  it("maps each custom file scope and approval policy exactly", () => {
    const profiles = [
      ["read-only", ":read-only"],
      ["workspace-write", ":workspace"],
      ["full-access", ":danger-full-access"],
    ] as const;
    for (const [fileAccess, permissions] of profiles) {
      expect(
        buildCodexTurnStartParams({
          threadId: "thread-custom",
          userInput: [{ type: "text", text: "Inspect", text_elements: [] }],
          options: {
            accessMode: "custom",
            customPermissions: { fileAccess, approvalPolicy: "on-request" },
            model: null,
            reasoningEffort: "follow-desktop",
            speed: "follow-desktop",
            planMode: false,
          },
          currentModel: "gpt-5.6-sol",
          currentReasoningEffort: "high",
          peerDisplayName: "Owner",
          ownerAuthored: true,
        }),
      ).toMatchObject({ permissions, approvalPolicy: "on-request" });
    }
    expect(() =>
      buildCodexTurnStartParams({
        threadId: "thread-custom",
        userInput: [{ type: "text", text: "Inspect", text_elements: [] }],
        options: {
          accessMode: "custom",
          customPermissions: null,
          model: null,
          reasoningEffort: "follow-desktop",
          speed: "follow-desktop",
          planMode: false,
        },
        currentModel: "gpt-5.6-sol",
        peerDisplayName: "Owner",
        ownerAuthored: true,
      }),
    ).toThrow(/missing/i);
  });

  it("blocks invalid capabilities after resolving the current task model", () => {
    const base = {
      threadId: "thread-capabilities",
      userInput: [{ type: "text" as const, text: "Run", text_elements: [] as [] }],
      peerDisplayName: "Owner",
      ownerAuthored: true,
    };
    expect(() =>
      buildCodexTurnStartParams({
        ...base,
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: null,
          reasoningEffort: "follow-desktop",
          speed: "fast",
          planMode: false,
        },
        currentModel: "gpt-5.3-codex-spark",
      }),
    ).toThrow(/fast/i);
    expect(() =>
      buildCodexTurnStartParams({
        ...base,
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: "gpt-5.6-luna",
          reasoningEffort: "ultra",
          speed: "standard",
          planMode: false,
        },
        currentModel: "gpt-5.6-sol",
      }),
    ).toThrow(/ultra/i);
    expect(() =>
      buildCodexTurnStartParams({
        ...base,
        attachmentMediaTypes: ["image/png"],
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: null,
          reasoningEffort: "follow-desktop",
          speed: "standard",
          planMode: false,
        },
        currentModel: "gpt-5.3-codex-spark",
      }),
    ).toThrow(/image/i);
  });

  it("omits sticky overrides for owner-authored prompts that follow the selected task", () => {
    expect(
      buildCodexTurnStartParams({
        threadId: "thread-1",
        userInput: [{ type: "text", text: "Continue", text_elements: [] }],
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: null,
          reasoningEffort: "follow-desktop",
          speed: "follow-desktop",
          planMode: false,
        },
        currentModel: "gpt-5.6-sol",
        currentReasoningEffort: "high",
        peerDisplayName: "Owner",
        ownerAuthored: true,
      }),
    ).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
      responsesapiClientMetadata: {
        source: "codex-collab",
        collab_member: "Owner",
      },
    });
  });

  it("forces workspace access and on-request approval for every peer access mode", () => {
    const modes = [
      { accessMode: "follow-desktop", customPermissions: null },
      { accessMode: "auto", customPermissions: null },
      { accessMode: "full-access", customPermissions: null },
      {
        accessMode: "custom",
        customPermissions: { fileAccess: "full-access", approvalPolicy: "never" },
      },
    ] as const;
    for (const mode of modes) {
      expect(
        buildCodexTurnStartParams({
          threadId: "thread-peer",
          userInput: [{ type: "text", text: "Peer request", text_elements: [] }],
          options: {
            ...mode,
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
            speed: "fast",
            planMode: true,
          },
          currentModel: "gpt-5.6-sol",
          currentReasoningEffort: "medium",
          peerDisplayName: "Editor",
          ownerAuthored: false,
        }),
      ).toMatchObject({
        model: "gpt-5.6-sol",
        effort: "high",
        serviceTier: "priority",
        permissions: ":workspace",
        approvalPolicy: "on-request",
        collaborationMode: { mode: "plan" },
      });
    }
  });

  it("aligns the default collaboration mode with web model overrides", () => {
    expect(
      buildCodexTurnStartParams({
        threadId: "thread-1",
        userInput: [{ type: "text", text: "Which model?", text_elements: [] }],
        options: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          speed: "follow-desktop",
          planMode: false,
        },
        currentModel: "gpt-5.6-sol",
        currentReasoningEffort: "xhigh",
        peerDisplayName: "Owner",
        commandId: "prompt-luna",
        ownerAuthored: true,
      }),
    ).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "low",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.6-luna",
          reasoning_effort: "low",
          developer_instructions: null,
        },
      },
    });
  });

  it("sends the resumed task settings and web overrides through Desktop IPC", async () => {
    const startTurn = vi.fn().mockResolvedValue({
      result: { turn: { id: "turn-luna" } },
    });
    const steerTurn = vi.fn();
    const client = new CodexAppServerClient({
      platform: "win32",
      desktopIpc: {
        startTurn,
        steerTurn,
        interruptTurn: vi.fn(),
        close: vi.fn(),
      },
    });
    Object.defineProperty(client, "start", {
      value: async () => undefined,
    });
    Object.defineProperty(client, "getActiveTurnId", {
      value: async () => null,
    });
    Object.defineProperty(client, "request", {
      value: async (method: string) => {
        if (method === "thread/resume") {
          return {
            thread: {},
            model: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
          };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    });

    await expect(
      client.submitPeerPrompt({
        threadId: "thread-1",
        projectRoot: "E:\\Codex-Collab",
        commandId: "prompt-luna",
        requesterMemberId: "owner-1",
        ownerMemberId: "owner-1",
        peerDisplayName: "Owner",
        body: "Which model?",
        attachments: [],
        codexOptions: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          speed: "follow-desktop",
          planMode: false,
        },
      }),
    ).resolves.toEqual({
      status: "submitted",
      mode: "started",
      turnId: "turn-luna",
    });
    expect(steerTurn).not.toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledWith({
      conversationId: "thread-1",
      turnStartParams: {
        input: [{ type: "text", text: "Which model?", text_elements: [] }],
        model: "gpt-5.6-luna",
        effort: "low",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.6-luna",
            reasoning_effort: "low",
            developer_instructions: null,
          },
        },
        responsesapiClientMetadata: {
          source: "codex-collab",
          collab_member: "Owner",
          collab_command_id: "prompt-luna",
        },
        clientUserMessageId: "prompt-luna",
        additionalContext: null,
      },
    });
  });

  it("keeps configured prompts queued while another turn is active", async () => {
    const startTurn = vi.fn();
    const steerTurn = vi.fn();
    const request = vi.fn();
    const client = new CodexAppServerClient({
      platform: "win32",
      desktopIpc: {
        startTurn,
        steerTurn,
        interruptTurn: vi.fn(),
        close: vi.fn(),
      },
    });
    Object.defineProperty(client, "start", {
      value: async () => undefined,
    });
    Object.defineProperty(client, "getActiveTurnId", {
      value: async () => "turn-active",
    });
    Object.defineProperty(client, "request", { value: request });

    await expect(
      client.submitPeerPrompt({
        threadId: "thread-1",
        projectRoot: "E:\\Codex-Collab",
        commandId: "prompt-queued",
        requesterMemberId: "owner-1",
        ownerMemberId: "owner-1",
        peerDisplayName: "Owner",
        body: "Run next",
        attachments: [],
        codexOptions: {
          accessMode: "follow-desktop",
          customPermissions: null,
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          speed: "follow-desktop",
          planMode: false,
        },
      }),
    ).resolves.toEqual({
      status: "deferred",
      reason: "active-turn",
      turnId: "turn-active",
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(steerTurn).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

});
