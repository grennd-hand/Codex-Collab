import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopActivityRail } from "./DesktopActivityRail.js";

describe("DesktopActivityRail", () => {
  it("exposes compact keyboard-accessible workspace destinations", () => {
    const markup = renderToStaticMarkup(
      createElement(DesktopActivityRail, {
        activeSidebar: "collaboration",
        filesVisible: true,
        pendingMemberCount: 2,
        workspaceAvailable: true,
        workspaceConfigurable: true,
        onSelectSidebar: vi.fn(),
        onShowFiles: vi.fn(),
        onOpenWorkspace: vi.fn(),
      }),
    );
    expect(markup).toContain('aria-label="桌面工作区导航"');
    expect(markup).toContain('aria-label="协作成员与聊天"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="2 位成员等待批准"');
    expect(markup).toContain('aria-label="显示项目 IDE"');
    expect(markup).toContain('aria-label="最近活动"');
    expect(markup).toContain('aria-label="切换工作区"');
  });
});
