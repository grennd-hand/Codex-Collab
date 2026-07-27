import { describe, expect, it } from "vitest";
import { shouldApplyWorkspaceResponse } from "./workspace-refresh.js";

describe("shouldApplyWorkspaceResponse", () => {
  it("applies the first completed response even when newer requests already started", () => {
    expect(shouldApplyWorkspaceResponse(1, 0)).toBe(true);
  });

  it("applies a newer completed response", () => {
    expect(shouldApplyWorkspaceResponse(4, 2)).toBe(true);
  });

  it("rejects a response older than the newest result already applied", () => {
    expect(shouldApplyWorkspaceResponse(3, 4)).toBe(false);
  });
});
