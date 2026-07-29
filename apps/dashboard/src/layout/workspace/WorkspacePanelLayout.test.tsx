import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspacePanelLayout } from "./WorkspacePanelLayout.js";

function renderLayout({
  showFiles = true,
  showPeople = true,
  withFiles = true,
}: {
  showFiles?: boolean;
  showPeople?: boolean;
  withFiles?: boolean;
} = {}) {
  const child = (name: string, label: string): ReactNode =>
    createElement("div", { "data-workspace-panel": name, key: name }, label);

  return renderToStaticMarkup(
    createElement(
      WorkspacePanelLayout,
      {
        className: "workspace",
        children: [
          child("files", "FILES"),
          child("people", "PEOPLE"),
          child("chat", "TIMELINE"),
          child("activity", "ACTIVITY"),
        ],
        editorExpanded: false,
        showFiles,
        showPeople,
        storageScope: "room:task",
        withFiles,
      },
    ),
  );
}

describe("WorkspacePanelLayout", () => {
  it("keeps marked file, collaboration, and timeline panels", () => {
    const markup = renderLayout();

    expect(markup).toContain("FILES");
    expect(markup).toContain("PEOPLE");
    expect(markup).toContain("TIMELINE");
  });

  it("removes only the panels the user collapsed", () => {
    const markup = renderLayout({ showFiles: false, showPeople: false });

    expect(markup).not.toContain("FILES");
    expect(markup).not.toContain("PEOPLE");
    expect(markup).toContain("TIMELINE");
    expect(markup).not.toContain("ACTIVITY");
  });

  it("keeps task activity only when no host workspace is connected", () => {
    const markup = renderLayout({ showFiles: false, showPeople: false, withFiles: false });

    expect(markup).toContain("TIMELINE");
    expect(markup).toContain("ACTIVITY");
  });
});
