import { describe, expect, it } from "vitest";
import {
  defaultDesktopPanelLayout,
  fitDesktopPanelWidths,
  moveDesktopPanel,
  moveDesktopPanelByStep,
  normalizeDesktopPanelOrder,
  parseDesktopPanelLayout,
  resizeDesktopPanelPair,
  type DesktopPanelId,
} from "./desktop-panel-arrangement.js";

describe("desktop panel arrangement", () => {
  it("supports every three-panel ordering without losing a panel", () => {
    const permutations: DesktopPanelId[][] = [
      ["sidebar", "files", "codex"],
      ["sidebar", "codex", "files"],
      ["files", "sidebar", "codex"],
      ["files", "codex", "sidebar"],
      ["codex", "sidebar", "files"],
      ["codex", "files", "sidebar"],
    ];
    for (const order of permutations) {
      expect(normalizeDesktopPanelOrder(order)).toEqual(order);
    }
  });

  it("repairs duplicate, unknown and missing stored panel ids", () => {
    expect(normalizeDesktopPanelOrder(["codex", "codex", "unknown"])).toEqual([
      "codex",
      "sidebar",
      "files",
    ]);
    expect(parseDesktopPanelLayout("not-json", false)).toEqual(
      defaultDesktopPanelLayout(false),
    );
    expect(parseDesktopPanelLayout(JSON.stringify({ version: 2 }), false)).toEqual(
      defaultDesktopPanelLayout(false),
    );
  });

  it("moves panels by drop position and keyboard step", () => {
    const order: DesktopPanelId[] = ["sidebar", "files", "codex"];
    expect(moveDesktopPanel(order, "codex", "sidebar", "before")).toEqual([
      "codex",
      "sidebar",
      "files",
    ]);
    expect(moveDesktopPanelByStep(order, order, "files", 1)).toEqual([
      "sidebar",
      "codex",
      "files",
    ]);
    expect(moveDesktopPanelByStep(order, order, "sidebar", -1)).toEqual(order);
  });

  it("fits visible widths and preserves the adjacent pair total while resizing", () => {
    const defaults = defaultDesktopPanelLayout(false).widths;
    const fitted = fitDesktopPanelWidths(
      ["sidebar", "files", "codex"],
      defaults,
      1_100,
      false,
    );
    expect(fitted.sidebar).toBeGreaterThanOrEqual(248);
    expect(fitted.files).toBeGreaterThanOrEqual(260);
    expect(fitted.codex).toBeGreaterThanOrEqual(360);
    expect(fitted.sidebar + fitted.files + fitted.codex).toBe(1_100);

    const resized = resizeDesktopPanelPair(
      defaults,
      "files",
      "codex",
      -1_000,
      false,
    );
    expect(resized.files).toBe(260);
    expect(resized.files + resized.codex).toBe(
      defaults.files + defaults.codex,
    );
  });

  it("raises the files minimum while the Monaco editor is expanded", () => {
    const parsed = parseDesktopPanelLayout(
      JSON.stringify({
        version: 1,
        order: ["files", "codex", "sidebar"],
        widths: { sidebar: 1, files: 1, codex: 1 },
      }),
      true,
    );
    expect(parsed.order).toEqual(["files", "codex", "sidebar"]);
    expect(parsed.widths).toEqual({ sidebar: 248, files: 520, codex: 360 });
  });
});
