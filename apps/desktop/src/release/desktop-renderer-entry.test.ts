import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function source(relativePath: string): string {
  return readFileSync(join(desktopRoot, relativePath), "utf8");
}

describe("desktop renderer entry boundary", () => {
  it("builds from the dedicated Desktop renderer root", () => {
    const vite = source("vite.config.ts");
    expect(vite).toContain('new URL("./renderer", import.meta.url)');
    expect(vite).not.toContain('new URL("../dashboard", import.meta.url)');
    expect(source("renderer/index.html")).toContain('src="/main.tsx"');
  });

  it("composes the shared controller with a Desktop-only view", () => {
    const entry = source("renderer/main.tsx");
    expect(entry).toContain("DashboardController");
    expect(entry).toContain("DesktopView");
    expect(entry).not.toContain('from "../../dashboard/src/App');
    expect(entry).not.toContain("DashboardWorkspaceView");
  });

  it("uses a full-window workbench instead of the browser page frame", () => {
    const facade = source("renderer/styles/desktop.css");
    expect(facade).toContain('@import "../app/desktop-app.css";');
    expect(facade).toContain('@import "../shell/desktop-shell.css";');
    expect(facade).toContain('@import "../layout/desktop-panel-strip.css";');
    expect(facade).toContain('@import "../panes/desktop-panes.css";');
    const css = [
      source("renderer/app/desktop-app.css"),
      source("renderer/shell/desktop-shell.css"),
      source("renderer/layout/desktop-panel-strip.css"),
      source("renderer/panes/desktop-panes.css"),
    ].join("\n");
    expect(css).toContain(".desktop-workbench");
    expect(css).toContain("height: 100dvh");
    expect(css).not.toContain(".app-frame");
  });

  it("keeps reorderable Desktop panels accessible and status groups collision-free", () => {
    const shell = source("renderer/shell/DesktopWorkspaceShell.tsx");
    const shellCss = source("renderer/shell/desktop-shell.css");
    const panelCss = source("renderer/layout/desktop-panel-strip.css");
    const panelStrip = source("renderer/layout/DesktopPanelStrip.tsx");
    const panelReorder = source("renderer/layout/useDesktopPanelReorder.ts");

    expect(shell).toContain("DesktopPanelStrip");
    expect(panelStrip).toContain('data-desktop-panel-id={panelId}');
    expect(panelReorder).toContain("moveDesktopPanelByStep");
    expect(panelStrip).toContain("persistDesktopPanelLayout");
    expect(shell).toContain('className="desktop-statusbar-live"');
    expect(shell).toContain('className="desktop-statusbar-context"');
    expect(shell).toContain('className="desktop-statusbar-trailing"');
    expect(shell).not.toContain("desktop-statusbar-spacer");
    expect(shellCss).toContain(
      "grid-template-columns: auto minmax(0, 1fr) auto;",
    );
    expect(shellCss).toContain(".desktop-statusbar-context");
    expect(panelCss).toContain(".desktop-panel-separator::after");
    expect(panelCss).toContain('.desktop-panel-slot[data-drop-position="before"]');
  });
});
