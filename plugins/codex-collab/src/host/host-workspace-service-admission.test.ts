import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../app-server/app-server-client.js";
import { recoverCommandReceipt } from "../persistence/command-outbox.js";
import { DurableRecoveryBlockedError } from "../persistence/durable-recovery.js";
import type { LocalProfile } from "../persistence/local-profile.js";
import type { RelayClient } from "../relay/relay-client.js";
import type { WorkspaceSyncService } from "../sync/workspace-sync-service.js";
import type { HostProfileContext } from "./host-profile-context.js";
import { HostWorkspaceService } from "./host-workspace-service.js";

describe("HostWorkspaceService runtime admission", () => {
  it("does not manually forward a prompt while file recovery is blocked", async () => {
    const profile: LocalProfile = {
      relayUrl: "https://relay.example/",
      sessionId: "session-1",
      memberId: "owner-1",
      displayName: "Owner",
      role: "owner",
      memberToken: "host-token",
      projectRoot: "C:\\project",
      threadId: "thread-1",
    };
    const relay = { listMessages: vi.fn() } as unknown as RelayClient;
    const context = {
      current: vi.fn().mockResolvedValue({ profile, relay }),
    } as unknown as HostProfileContext;
    const workspaceSync = {
      reconcileDurableReceipts: vi.fn().mockRejectedValue(
        new DurableRecoveryBlockedError("ambiguous file execution"),
      ),
    } as unknown as WorkspaceSyncService;
    const service = new HostWorkspaceService(
      context,
      {} as CodexAppServerClient,
      workspaceSync,
    );

    await expect(
      service.callTool("collab_forward_prompt", { messageId: "message-1" }),
    ).rejects.toBeInstanceOf(DurableRecoveryBlockedError);
    expect(relay.listMessages).not.toHaveBeenCalled();
  });

  it("does not manually submit after the room closes during attachment loading", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "codex-collab-admission-"));
    try {
      const profile: LocalProfile = {
        relayUrl: "https://relay.example/",
        sessionId: "session-1",
        memberId: "owner-1",
        displayName: "Owner",
        role: "owner",
        memberToken: "host-token",
        projectRoot,
        threadId: "thread-1",
      };
      let releaseAttachment!: () => void;
      const attachment = new Promise<Uint8Array>((resolve) => {
        releaseAttachment = () => resolve(new Uint8Array([1, 2, 3]));
      });
      const relay = {
        listMessages: vi.fn().mockResolvedValue([{
          id: "message-1",
          kind: "codex_prompt",
          senderMemberId: "editor-1",
          senderDisplayName: "Editor",
          body: "Review this",
          attachments: [{
            id: "attachment-1",
            name: "diagram.png",
            mediaType: "image/png",
            size: 3,
          }],
          codexOptions: null,
        }]),
        readMessageAttachment: vi.fn().mockReturnValue(attachment),
        listMembers: vi.fn().mockResolvedValue([{
          id: "editor-1",
          status: "approved",
        }]),
      } as unknown as RelayClient;
      let currentProfile = profile;
      const context = {
        current: vi.fn().mockResolvedValue({ profile, relay }),
        profiles: {
          read: vi.fn(async () => currentProfile),
          mutate: vi.fn(async (operation: (current: LocalProfile) => LocalProfile) => {
            currentProfile = operation(currentProfile);
            return currentProfile;
          }),
        },
      } as unknown as HostProfileContext;
      const submitPeerPrompt = vi.fn();
      const codex = {
        listThreads: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        submitPeerPrompt,
      } as unknown as CodexAppServerClient;
      const service = new HostWorkspaceService(
        context,
        codex,
        {
          reconcileDurableReceipts: vi.fn().mockResolvedValue(null),
        } as unknown as WorkspaceSyncService,
      );
      let allowed = true;

      const forwarding = service.callTool(
        "collab_forward_prompt",
        { messageId: "message-1" },
        { isAllowed: () => allowed },
      );
      await vi.waitFor(() =>
        expect(relay.readMessageAttachment).toHaveBeenCalledTimes(1),
      );
      allowed = false;
      releaseAttachment();

      await expect(forwarding).rejects.toThrow(
        "Host runtime stopped accepting workspace work",
      );
      expect(submitPeerPrompt).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("recovers a manually forwarded submitted receipt without resubmitting", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "codex-collab-recovery-"));
    try {
      const message = {
        id: "message-recovery",
        kind: "codex_prompt",
        senderMemberId: "editor-1",
        senderDisplayName: "Editor",
        body: "Review this",
        attachments: [],
        codexOptions: null,
      };
      const profile: LocalProfile = {
        relayUrl: "https://relay.example/",
        sessionId: "session-1",
        memberId: "owner-1",
        displayName: "Owner",
        role: "owner",
        memberToken: "host-token",
        projectRoot,
        threadId: "thread-1",
        commandReceipt: {
          messageId: message.id,
          threadId: "thread-1",
          commandKind: "codex_prompt",
          phase: "submitted",
          turnId: "turn-recovery",
          createdAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:01.000Z",
        },
      };
      let currentProfile = profile;
      const profiles = {
        read: vi.fn(async () => currentProfile),
        mutate: vi.fn(async (operation: (current: LocalProfile) => LocalProfile) => {
          currentProfile = operation(currentProfile);
          return currentProfile;
        }),
      };
      const relay = {
        updateMessageDeliveryStatus: vi.fn().mockResolvedValue(message),
        listMessages: vi.fn().mockResolvedValue([message]),
        listMembers: vi.fn(),
        readMessageAttachment: vi.fn(),
      } as unknown as RelayClient;
      const context = {
        current: vi.fn().mockResolvedValue({ profile, relay }),
        profiles,
      } as unknown as HostProfileContext;
      const codex = {
        submitPeerPrompt: vi.fn(),
        stopPeerPrompt: vi.fn(),
        listThreads: vi.fn(),
      } as unknown as CodexAppServerClient;
      const service = new HostWorkspaceService(context, codex, {
        reconcileDurableReceipts: vi.fn().mockImplementation(() =>
          recoverCommandReceipt(profile, relay, codex, profiles)
        ),
      } as unknown as WorkspaceSyncService);

      await expect(
        service.callTool("collab_forward_prompt", { messageId: message.id }),
      ).resolves.toMatchObject({
        recovered: true,
        appServerSubmission: { status: "submitted", turnId: "turn-recovery" },
      });
      expect(relay.updateMessageDeliveryStatus).toHaveBeenCalledOnce();
      expect(codex.submitPeerPrompt).not.toHaveBeenCalled();
      expect(codex.listThreads).not.toHaveBeenCalled();
      expect(currentProfile.commandReceipt).toBeUndefined();
      expect(currentProfile.forwardedMessageIds).toEqual([message.id]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
