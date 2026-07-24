import { describe, expect, it, vi } from "vitest";
import { copyWithFallback } from "./clipboard.js";

describe("copyWithFallback", () => {
  it("prefers the synchronous copy path", async () => {
    const writeClipboard = vi.fn<() => Promise<void>>();

    await expect(
      copyWithFallback("invite", {
        legacyCopy: () => true,
        writeClipboard,
      }),
    ).resolves.toBe(true);
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("uses the Clipboard API when the synchronous path is unavailable", async () => {
    const writeClipboard = vi.fn(async () => undefined);

    await expect(
      copyWithFallback("invite", {
        legacyCopy: () => false,
        writeClipboard,
      }),
    ).resolves.toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith("invite");
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
