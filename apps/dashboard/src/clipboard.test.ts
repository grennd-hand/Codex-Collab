import { describe, expect, it, vi } from "vitest";
import { copyWithFallback } from "./clipboard.js";

describe("copyWithFallback", () => {
  it("prefers the Clipboard API", async () => {
    const writeClipboard = vi.fn(async () => undefined);
    const legacyCopy = vi.fn(() => true);

    await expect(
      copyWithFallback("invite", {
        legacyCopy,
        writeClipboard,
      }),
    ).resolves.toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith("invite");
    expect(legacyCopy).not.toHaveBeenCalled();
  });

  it("uses the synchronous path when the Clipboard API is unavailable", async () => {
    const legacyCopy = vi.fn(() => true);

    await expect(
      copyWithFallback("invite", {
        legacyCopy,
      }),
    ).resolves.toBe(true);
    expect(legacyCopy).toHaveBeenCalledWith("invite");
  });

  it("falls back when Clipboard API access is denied", async () => {
    const legacyCopy = vi.fn(() => true);

    await expect(
      copyWithFallback("invite", {
        legacyCopy,
        writeClipboard: async () => {
          throw new Error("denied");
        },
      }),
    ).resolves.toBe(true);
    expect(legacyCopy).toHaveBeenCalledWith("invite");
  });

  it("reports failure when both copy paths fail", async () => {
    await expect(
      copyWithFallback("invite", {
        legacyCopy: () => {
          throw new Error("blocked");
        },
        writeClipboard: async () => {
          throw new Error("denied");
        },
      }),
    ).resolves.toBe(false);
  });
});
