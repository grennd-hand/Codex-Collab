import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PanelVisibilityControls } from "./PanelVisibilityControls.js";

describe("PanelVisibilityControls", () => {
  it("exposes the current panel state and workspace switch action", () => {
    const markup = renderToStaticMarkup(
      createElement(PanelVisibilityControls, {
        collaborationVisible: true,
        filesAvailable: true,
        filesVisible: false,
        owner: true,
        onOpenWorkspace: vi.fn(),
        onToggleCollaboration: vi.fn(),
        onToggleFiles: vi.fn(),
      }),
    );

    expect(markup).toContain("收起协作聊天");
    expect(markup).toContain("打开项目目录");
    expect(markup).toContain("切换配对工作区");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it("disables directory access before a host is paired", () => {
    const markup = renderToStaticMarkup(
      createElement(PanelVisibilityControls, {
        collaborationVisible: true,
        filesAvailable: false,
        filesVisible: false,
        owner: false,
        onOpenWorkspace: vi.fn(),
        onToggleCollaboration: vi.fn(),
        onToggleFiles: vi.fn(),
      }),
    );

    expect(markup).toContain("连接工作区");
    expect(markup).toContain("disabled");
  });
});
