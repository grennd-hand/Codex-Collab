import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IdeExplorer } from "./IdeExplorer.js";

function renderExplorer(readOnly: boolean): string {
  return renderToStaticMarkup(
    createElement(IdeExplorer, {
      fileCount: 0,
      directoryCount: 0,
      loading: false,
      query: "",
      visibleTree: [],
      activePath: null,
      expandedDirectories: new Set<string>(),
      fileChanges: [],
      forceExpanded: false,
      readOnly,
      onQueryChange: vi.fn(),
      onToggleDirectory: vi.fn(),
      onExpandDirectory: vi.fn(),
      onOpenFile: vi.fn(),
      onCreateFile: vi.fn(),
      onCreateDirectory: vi.fn(),
    }),
  );
}

describe("IdeExplorer", () => {
  it("shows create actions for writable approved members", () => {
    const markup = renderExplorer(false);
    expect(markup).toContain('aria-label="新建文件"');
    expect(markup).toContain('aria-label="新建文件夹"');
    expect(markup).not.toContain('role="dialog"');
  });

  it("hides create actions for read-only workspace access", () => {
    const markup = renderExplorer(true);
    expect(markup).not.toContain('aria-label="新建文件"');
    expect(markup).not.toContain('aria-label="新建文件夹"');
  });
});
