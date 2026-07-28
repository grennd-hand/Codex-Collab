import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../shared/api/api-client.js";
import {
  STALE_WORKSPACE_THREAD_MESSAGE,
  expectedWorkspaceThreadForSubmission,
  isStaleWorkspaceThreadError,
} from "../composer/submission-contract.js";

describe("Codex submission task contract", () => {
  it("captures a non-empty expected task only for Codex prompts", () => {
    expect(expectedWorkspaceThreadForSubmission("codex_prompt", " thread-1 ")).toBe(
      "thread-1",
    );
    expect(expectedWorkspaceThreadForSubmission("codex_prompt", null)).toBeNull();
    expect(expectedWorkspaceThreadForSubmission("chat", "thread-1")).toBeNull();
    expect(expectedWorkspaceThreadForSubmission("codex_stop", "thread-1")).toBeNull();
  });

  it("recognizes the Relay stale-task conflict without swallowing other errors", () => {
    expect(
      isStaleWorkspaceThreadError(
        new ApiRequestError(
          409,
          "stale_workspace_thread",
          "The selected Codex task changed before the prompt was submitted",
        ),
      ),
    ).toBe(true);
    expect(
      isStaleWorkspaceThreadError(
        new ApiRequestError(409, "conflict", "Another conflict"),
      ),
    ).toBe(false);
    expect(STALE_WORKSPACE_THREAD_MESSAGE).toContain("重新发送");
  });
});
