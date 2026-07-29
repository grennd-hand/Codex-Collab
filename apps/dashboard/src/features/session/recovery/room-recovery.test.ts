import { describe, expect, it } from "vitest";
import { recoveryBundleText } from "./room-recovery.js";

describe("recoveryBundleText", () => {
  it("keeps the room id and owner recovery key together for safe storage", () => {
    expect(recoveryBundleText("room-123", "ccr_secret")).toBe(
      "房间 ID: room-123\n房主密钥: ccr_secret",
    );
  });
});
