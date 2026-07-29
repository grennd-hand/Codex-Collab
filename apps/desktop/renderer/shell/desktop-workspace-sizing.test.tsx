import { describe, expect, it } from "vitest";
import {
  clampSplitSize,
  getPointerSplitSize,
  getSplitSizeBounds,
} from "../../../dashboard/src/layout/split-pane/split-size.js";
import { desktopMainSplitSizing } from "./desktop-workspace-sizing.js";

describe("desktop main workspace sizing", () => {
  it("lets an explorer-only pane grow and then shrink below the old 440px floor", () => {
    const sizing = desktopMainSplitSizing(false);
    const bounds = getSplitSizeBounds({
      ...sizing,
      containerSize: 1_440,
      separatorSize: 12,
    });
    const enlarged = clampSplitSize(
      getPointerSplitSize(sizing.defaultPrimarySize, 400, 620),
      bounds,
    );
    const reduced = clampSplitSize(
      getPointerSplitSize(enlarged, 620, 200),
      bounds,
    );

    expect(enlarged).toBe(580);
    expect(reduced).toBe(260);
    expect(bounds.min).toBeLessThan(440);
  });

  it("keeps enough room for both Explorer and Monaco when the editor is open", () => {
    expect(desktopMainSplitSizing(true)).toEqual({
      defaultPrimarySize: 760,
      minPrimarySize: 520,
      maxPrimarySize: 1_120,
      minSecondarySize: 360,
    });
  });
});
