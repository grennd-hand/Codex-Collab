import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../app-server-client.js";
import type { LocalProfile } from "../local-profile.js";
import type { RelayClient } from "../relay-client.js";
import type { WorkspaceSyncService } from "../workspace-sync-service.js";
import type { HostProfileContext } from "./host-profile-context.js";
import { HostWorkspaceService } from "./host-workspace-service.js";

describe("HostWorkspaceService runtime admission", () => {
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
      const context = {
        current: vi.fn().mockResolvedValue({ profile, relay }),
        profiles: { update: vi.fn() },
      } as unknown as HostProfileContext;
      const submitPeerPrompt = vi.fn();
      const codex = {
        listThreads: vi.fn().mockResolvedValue([{ id: "thread-1" }]),
        submitPeerPrompt,
      } as unknown as CodexAppServerClient;
      const service = new HostWorkspaceService(
        context,
        codex,
        {} as WorkspaceSyncService,
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
});
