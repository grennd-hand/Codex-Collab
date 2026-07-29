import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IdeTitlebar } from "./IdeTitlebar.js";

function renderTitlebar(showEditor: boolean): string {
  return renderToStaticMarkup(
    createElement(IdeTitlebar, {
      showEditor,
      rootLabel: "Codex-Collab",
      selectedThreadLabel: "IDE 稳定性",
      hostDeviceLabel: "Owner PC",
      syncedAt: "2026-07-27T07:30:00.000Z",
      loading: false,
      embedded: true,
      mobileExplorerOpen: false,
      onToggleMobileExplorer: vi.fn(),
      onRefresh: vi.fn(),
      onToggleEditor: vi.fn(),
    }),
  );
}

describe("IdeTitlebar", () => {
  it("uses stable native titles instead of animated tooltip portals", () => {
    const markup = renderTitlebar(true);

    expect(markup).toContain('title="刷新项目文件"');
    expect(markup).toContain('title="收起编辑器，只显示目录"');
    expect(markup).toContain("ide-toolbar-button");
    expect(markup).not.toContain('role="tooltip"');
  });

  it("keeps the compact editor action accessible", () => {
    const markup = renderTitlebar(false);

    expect(markup).toContain('aria-label="展开代码编辑器"');
    expect(markup).toContain('title="展开代码编辑器"');
  });
});
