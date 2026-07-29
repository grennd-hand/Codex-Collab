import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DESKTOP_TRAY_ICON_DATA_URL } from "./desktop-tray-icon.js";

const PNG_SIGNATURE = "89504e470d0a1a0a";

describe("Desktop tray icon", () => {
  it("contains a complete, decodable 32px RGBA PNG", () => {
    const image = Buffer.from(DESKTOP_TRAY_ICON_DATA_URL.split(",")[1]!, "base64");
    expect(image.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);

    const compressed: Buffer[] = [];
    let offset = 8;
    let sawEnd = false;
    while (offset < image.length) {
      const length = image.readUInt32BE(offset);
      const type = image.toString("ascii", offset + 4, offset + 8);
      const nextOffset = offset + 12 + length;
      expect(nextOffset).toBeLessThanOrEqual(image.length);
      if (type === "IHDR") {
        expect(image.readUInt32BE(offset + 8)).toBe(32);
        expect(image.readUInt32BE(offset + 12)).toBe(32);
        expect(image[offset + 16]).toBe(8);
        expect(image[offset + 17]).toBe(6);
      } else if (type === "IDAT") {
        compressed.push(image.subarray(offset + 8, offset + 8 + length));
      } else if (type === "IEND") {
        expect(length).toBe(0);
        expect(nextOffset).toBe(image.length);
        sawEnd = true;
      }
      offset = nextOffset;
    }

    expect(sawEnd).toBe(true);
    expect(inflateSync(Buffer.concat(compressed))).toHaveLength(32 * (1 + 32 * 4));
  });
});
