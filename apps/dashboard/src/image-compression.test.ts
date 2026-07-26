import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compressImageFile,
  compressedImageName,
  scaledImageDimensions,
  shouldCompressImage,
} from "./image-compression.js";

describe("chat image compression", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("compresses ordinary raster images but preserves animated and vector images", () => {
    expect(shouldCompressImage({ type: "image/jpeg", size: 5_000_000 })).toBe(true);
    expect(shouldCompressImage({ type: "image/png", size: 500_000 })).toBe(true);
    expect(shouldCompressImage({ type: "image/heic", size: 5_000_000 })).toBe(true);
    expect(
      shouldCompressImage({ name: "clipboard.PNG", type: "", size: 500_000 }),
    ).toBe(true);
    expect(shouldCompressImage({ type: "image/gif", size: 5_000_000 })).toBe(false);
    expect(shouldCompressImage({ type: "image/apng", size: 5_000_000 })).toBe(false);
    expect(shouldCompressImage({ type: "image/svg+xml", size: 5_000_000 })).toBe(false);
    expect(shouldCompressImage({ type: "application/pdf", size: 5_000_000 })).toBe(false);
  });

  it("fits the longest edge within the chat image limit without changing aspect ratio", () => {
    expect(scaledImageDimensions(4_000, 3_000)).toEqual({ width: 1_920, height: 1_440 });
    expect(scaledImageDimensions(900, 1_200)).toEqual({ width: 900, height: 1_200 });
    expect(scaledImageDimensions(1, 9_000)).toEqual({ width: 1, height: 1_920 });
  });

  it("renames converted images without leaving a misleading extension", () => {
    expect(compressedImageName("photo.HEIC", "image/webp")).toBe("photo.webp");
    expect(compressedImageName("screen.capture.png", "image/jpeg")).toBe(
      "screen.capture.jpg",
    );
    expect(compressedImageName("image", "image/png")).toBe("image.png");
  });

  it("decodes, resizes and returns the smaller browser-generated image", async () => {
    const close = vi.fn();
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
      })),
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob([new Uint8Array(320_000)], { type: "image/webp" }));
      }),
    };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 4_000, height: 3_000, close })),
    );
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });

    const original = new File([new Uint8Array(2_000_000)], "camera.jpg", {
      type: "image/jpeg",
      lastModified: 123,
    });
    const result = await compressImageFile(original);

    expect(result.compressed).toBe(true);
    expect(result.originalSize).toBe(2_000_000);
    expect(result.file.name).toBe("camera.webp");
    expect(result.file.size).toBe(320_000);
    expect(result.file.lastModified).toBe(123);
    expect(canvas.width).toBe(1_920);
    expect(canvas.height).toBe(1_440);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
