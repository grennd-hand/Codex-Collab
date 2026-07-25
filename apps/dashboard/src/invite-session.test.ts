import { describe, expect, it } from "vitest";
import {
  setupSubmissionMode,
  shouldRestoreCredential,
} from "./invite-session.js";

describe("shouldRestoreCredential", () => {
  it("restores the current session when no invitation is present", () => {
    expect(shouldRestoreCredential("")).toBe(true);
    expect(shouldRestoreCredential("   ")).toBe(true);
  });

  it("lets an invitation override an existing browser session", () => {
    expect(shouldRestoreCredential("cci_one-time")).toBe(false);
  });

  it("routes every form submission with an invite token to join", () => {
    expect(setupSubmissionMode("cci_one-time")).toBe("join");
    expect(setupSubmissionMode("  cci_one-time  ")).toBe("join");
  });

  it("routes a form without an invite token to room creation", () => {
    expect(setupSubmissionMode("")).toBe("create");
    expect(setupSubmissionMode("   ")).toBe("create");
  });
});
