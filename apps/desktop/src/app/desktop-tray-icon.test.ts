import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_ICON_FILE_NAME,
  resolveDesktopDevelopmentIconPath,
} from "./desktop-tray-icon.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Desktop tray icon", () => {
  it("contains the required 32-bit Windows icon frames", async () => {
    const image = await readFile(
      join(desktopRoot, "assets", DESKTOP_ICON_FILE_NAME),
    );
    expect(image.readUInt16LE(0)).toBe(0);
    expect(image.readUInt16LE(2)).toBe(1);
    const count = image.readUInt16LE(4);
    const frames = Array.from({ length: count }, (_, index) => {
      const offset = 6 + index * 16;
      return {
        width: image[offset] || 256,
        height: image[offset + 1] || 256,
        bitsPerPixel: image.readUInt16LE(offset + 6),
      };
    });
    expect(frames.map((frame) => frame.width)).toEqual([
      16, 20, 24, 32, 40, 48, 64, 128, 256,
    ]);
    expect(frames.every((frame) => frame.width === frame.height)).toBe(true);
    expect(frames.every((frame) => frame.bitsPerPixel === 32)).toBe(true);
  });

  it("resolves the development icon outside dist/main", () => {
    expect(resolveDesktopDevelopmentIconPath(join(desktopRoot, "dist", "main"))).toBe(
      join(desktopRoot, "assets", DESKTOP_ICON_FILE_NAME),
    );
  });
});
