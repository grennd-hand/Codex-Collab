import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResizableSplitPane } from "./ResizableSplitPane.js";

describe("ResizableSplitPane", () => {
  it("renders an accessible vertical separator for side-by-side panes", () => {
    const markup = renderToStaticMarkup(
      createElement(ResizableSplitPane, {
        primary: createElement("nav", null, "Files"),
        secondary: createElement("main", null, "Editor"),
        defaultPrimarySize: 280,
        minPrimarySize: 180,
        maxPrimarySize: 520,
        primaryLabel: "项目目录",
        secondaryLabel: "代码编辑器",
        separatorLabel: "调整目录宽度",
      }),
    );

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-label="调整目录宽度"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('aria-valuemin="180"');
    expect(markup).toContain('aria-valuemax="520"');
    expect(markup).toContain('aria-valuenow="280"');
    expect(markup).toContain('title="拖动调整大小，双击恢复默认"');
    expect(markup).toContain("--split-primary-size:280px");
  });

  it("uses a horizontal separator for stacked panes and removes disabled focus", () => {
    const markup = renderToStaticMarkup(
      createElement(ResizableSplitPane, {
        primary: "Timeline",
        secondary: "Composer",
        defaultPrimarySize: 480,
        orientation: "vertical",
        disabled: true,
      }),
    );

    expect(markup).toContain('aria-orientation="horizontal"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('tabindex="-1"');
  });
});
