import { describe, expect, it, vi } from "vitest";
import { runAdmittedBatch } from "./workspace-sync-admission.js";

describe("workspace sync admission", () => {
  it("finishes one started operation but does not admit the next", async () => {
    let allowed = true;
    const next = vi.fn().mockImplementation(async () => {
      allowed = false;
      return { id: "operation-1" };
    });

    await expect(
      runAdmittedBatch(20, { isAllowed: () => allowed }, next),
    ).resolves.toBe(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
