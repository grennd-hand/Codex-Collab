import { describe, expect, it } from "vitest";
import { shouldRestoreCredential } from "./invite-session.js";

describe("shouldRestoreCredential", () => {
  it("restores the current session when no invitation is present", () => {
    expect(shouldRestoreCredential("")).toBe(true);
    expect(shouldRestoreCredential("   ")).toBe(true);
  });

  it("lets an invitation override an existing browser session", () => {
    expect(shouldRestoreCredential("cci_one-time")).toBe(false);
  });
});
