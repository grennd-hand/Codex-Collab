import { describe, expect, it } from "vitest";
import {
  clampSplitSize,
  getKeyboardSplitSize,
  getPointerSplitSize,
  getSplitSizeBounds,
  readStoredSplitSize,
  storeSplitSize,
  type SplitStorage,
} from "./split-size.js";

function createStorage(initial: Record<string, string> = {}): SplitStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe("split size rules", () => {
  it("reserves the separator and secondary minimum in a bounded container", () => {
    const bounds = getSplitSizeBounds({
      containerSize: 900,
      separatorSize: 8,
      minPrimarySize: 180,
      maxPrimarySize: 720,
      minSecondarySize: 260,
    });

    expect(bounds).toEqual({ min: 180, max: 632 });
    expect(clampSplitSize(100, bounds)).toBe(180);
    expect(clampSplitSize(800, bounds)).toBe(632);
  });

  it("tracks pointer distance without coupling to a browser event", () => {
    expect(getPointerSplitSize(280, 400, 452)).toBe(332);
    expect(getPointerSplitSize(280, 400, 360)).toBe(240);
  });

  it("maps only the arrow keys for the current orientation", () => {
    const bounds = { min: 160, max: 640 };
    expect(getKeyboardSplitSize("ArrowRight", "horizontal", 280, bounds, 16)).toBe(
      296,
    );
    expect(getKeyboardSplitSize("ArrowDown", "horizontal", 280, bounds, 16)).toBe(
      null,
    );
    expect(getKeyboardSplitSize("ArrowDown", "vertical", 280, bounds, 16)).toBe(
      296,
    );
    expect(getKeyboardSplitSize("Home", "vertical", 280, bounds, 16)).toBe(160);
    expect(getKeyboardSplitSize("End", "horizontal", 280, bounds, 16)).toBe(640);
  });

  it("loads, validates, clamps, and persists a stored pixel size", () => {
    const storage = createStorage({ valid: "420", large: "1200", bad: "wide" });
    const bounds = { min: 160, max: 640 };

    expect(readStoredSplitSize(storage, "valid", bounds)).toBe(420);
    expect(readStoredSplitSize(storage, "large", bounds)).toBe(640);
    expect(readStoredSplitSize(storage, "bad", bounds)).toBeNull();
    expect(storeSplitSize(storage, "saved", 333.7)).toBe(true);
    expect(storage.getItem("saved")).toBe("334");
  });

  it("fails closed when storage access is unavailable", () => {
    const blockedStorage: SplitStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(
      readStoredSplitSize(blockedStorage, "layout", { min: 100, max: 500 }),
    ).toBeNull();
    expect(storeSplitSize(blockedStorage, "layout", 240)).toBe(false);
  });
});
