import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Member } from "@codex-collab/protocol";
import { AppHeader } from "./AppHeader.js";
import { hostStatusPresentation } from "./HostStatusBadge.js";
import { HeaderIdentity } from "./HeaderIdentity.js";
import type { HostStatusV1 } from "../../shared/runtime/index.js";

const member: Member = {
  id: "member-1",
  sessionId: "session-1",
  displayName: "小米",
  deviceLabel: null,
  role: "owner",
  status: "approved",
  workspaceFileAccess: "workspace-write",
  createdAt: "2026-07-28T00:00:00.000Z",
  approvedAt: "2026-07-28T00:00:00.000Z",
};

describe("HeaderIdentity", () => {
  it("shows an anonymous room member and role without a login action", () => {
    const markup = renderToStaticMarkup(createElement(HeaderIdentity, {
      member,
    }));

    expect(markup).toContain("小米");
    expect(markup).toContain("房主");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("登录");
  });

  it("does not expose an account action before entering a room", () => {
    const markup = renderToStaticMarkup(createElement(HeaderIdentity, {
      member: null,
    }));

    expect(markup).toBe("");
  });
});

describe("desktop Host status", () => {
  const status = (
    phase: HostStatusV1["phase"],
    acceptingWork = false,
  ): HostStatusV1 => ({
    version: 1,
    phase,
    paired: phase !== "unpaired",
    acceptingWork,
    since: "2026-07-28T00:00:00.000Z",
  });

  it("maps every Host lifecycle phase to compact semantic text", () => {
    expect(hostStatusPresentation(status("unpaired"))).toEqual({
      label: "Host 未配对",
      color: "informative",
    });
    expect(hostStatusPresentation(status("active", true))).toEqual({
      label: "Host 工作中",
      color: "success",
    });
    expect(hostStatusPresentation(status("draining"))).toMatchObject({
      label: "Host 正在暂停",
      color: "warning",
    });
    expect(hostStatusPresentation(status("suspended"))).toMatchObject({
      label: "Host 已休眠",
    });
    expect(hostStatusPresentation(status("catching-up"))).toMatchObject({
      label: "Host 正在同步",
    });
    expect(hostStatusPresentation(status("failed"))).toMatchObject({
      label: "Host 异常",
      color: "danger",
    });
  });

  it("renders the Host badge only when the desktop runtime supplies status", () => {
    const renderHeader = (hostStatus: HostStatusV1 | null) =>
      renderToStaticMarkup(
        createElement(AppHeader, {
          member,
          approved: true,
          workspaceSummary: null,
          workspaceLoading: false,
          roomOpen: true,
          roomStatusUpdating: false,
          themeMode: "dark",
          hasSession: true,
          connectionStatus: { label: "实时", color: "success" },
          hostStatus,
          collaborationPanelVisible: true,
          directoryPanelVisible: false,
          onSelectThread() {},
          onToggleCollaborationPanel() {},
          onToggleDirectoryPanel() {},
          onUpdateRoomStatus() {},
          onOpenWorkspace() {},
          onCreateInvite() {},
          onToggleTheme() {},
          onResetSession() {},
        }),
      );

    expect(renderHeader(null)).not.toContain("Host 已休眠");
    expect(renderHeader({ ...status("suspended"), detail: "房间已关闭" })).toContain(
      "Host 已休眠",
    );
    expect(renderHeader({ ...status("suspended"), detail: "房间已关闭" })).toContain(
      "Host 已休眠：房间已关闭",
    );
  });
});
