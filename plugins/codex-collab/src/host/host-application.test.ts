import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../app-server-client.js";
import type { LocalProfileStore } from "../local-profile.js";
import type { WorkspaceSyncService } from "../workspace-sync-service.js";
import { HostApplication } from "./host-application.js";
import { publicHostProfile } from "./host-profile-context.js";

function createApplication() {
  const profiles = {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn(),
    update: vi.fn(),
  } as unknown as LocalProfileStore;
  const codex = {
    listThreads: vi.fn().mockResolvedValue([]),
    submitPeerPrompt: vi.fn(),
    stopPeerPrompt: vi.fn().mockResolvedValue({ status: "submitted" }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as CodexAppServerClient;
  const workspaceSync = {
    processPendingFileOperations: vi.fn().mockResolvedValue(0),
    sync: vi.fn().mockResolvedValue({}),
    forwardPendingCommand: vi.fn().mockResolvedValue("message-1"),
  } as unknown as WorkspaceSyncService;
  return {
    application: new HostApplication(profiles, codex, workspaceSync),
    profiles,
    codex,
    workspaceSync,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HostApplication", () => {
  it("routes session tools through the shared profile context", async () => {
    const fixture = createApplication();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fixture.application.callTool("collab_health", {
        relayUrl: "https://relay.example/",
      }),
    ).resolves.toEqual({ status: "ok" });

    expect(fixture.profiles.read).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://relay.example/health"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("routes Codex calls without exposing the Codex client to the MCP adapter", async () => {
    const fixture = createApplication();

    await expect(
      fixture.application.callTool("collab_list_codex_threads", {}),
    ).resolves.toEqual([]);

    expect(fixture.codex.listThreads).toHaveBeenCalledWith(undefined);
  });

  it("keeps argument validation and unknown-tool rejection inside the Host boundary", async () => {
    const fixture = createApplication();

    await expect(
      fixture.application.callTool("collab_list_codex_threads", { cwd: 42 }),
    ).rejects.toThrow("cwd must be a non-empty string");
    await expect(fixture.application.callTool("unknown", {})).rejects.toThrow(
      "Unknown tool: unknown",
    );
  });

  it("removes the durable bearer from profiles returned to adapters", () => {
    expect(
      publicHostProfile({
        relayUrl: "https://relay.example/",
        sessionId: "session-1",
        memberId: "owner-1",
        displayName: "Owner",
        role: "owner",
        memberToken: "secret-token",
        projectRoot: "C:\\project",
      }),
    ).toEqual({
      relayUrl: "https://relay.example/",
      sessionId: "session-1",
      memberId: "owner-1",
      displayName: "Owner",
      role: "owner",
      projectRoot: "C:\\project",
    });
  });

  it("closes the single Codex resource it owns", async () => {
    const fixture = createApplication();

    await fixture.application.close();

    expect(fixture.codex.close).toHaveBeenCalledTimes(1);
  });

  it("keeps background work behind the same application boundary", async () => {
    const fixture = createApplication();

    await fixture.application.runBackgroundCycle();
    await expect(fixture.application.forwardPendingCommand()).resolves.toBe("message-1");

    expect(fixture.workspaceSync.processPendingFileOperations).toHaveBeenCalledTimes(1);
    expect(fixture.workspaceSync.sync).toHaveBeenCalledTimes(1);
    expect(fixture.workspaceSync.forwardPendingCommand).toHaveBeenCalledTimes(1);
  });

  it("reconciles before resume without claiming files or forwarding new prompts", async () => {
    const fixture = createApplication();

    await fixture.application.reconcileAfterResume();

    expect(
      fixture.workspaceSync.processPendingFileOperations,
    ).not.toHaveBeenCalled();
    expect(fixture.workspaceSync.forwardPendingCommand).not.toHaveBeenCalled();
    expect(fixture.workspaceSync.sync).toHaveBeenCalledWith(true, {
      allowNewWork: false,
    });
  });

  it("cancels the selected owner turn before room suspension", async () => {
    const fixture = createApplication();
    vi.mocked(fixture.profiles.read).mockResolvedValue({
      relayUrl: "https://relay.example/",
      sessionId: "session-1",
      memberId: "owner-1",
      displayName: "Owner",
      role: "owner",
      memberToken: "host-token",
      projectRoot: "C:\\project",
      threadId: "thread-1",
    });

    await fixture.application.cancelActiveWork();

    expect(fixture.codex.stopPeerPrompt).toHaveBeenCalledWith({ threadId: "thread-1" });
  });
});
