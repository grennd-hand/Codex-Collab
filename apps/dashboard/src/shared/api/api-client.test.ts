import { describe, expect, it } from "vitest";
import {
  ApiRequestError,
  isCredentialRejected,
  requestJson,
} from "./api-client.js";
import { setDashboardRuntime, type DashboardRuntimeV1 } from "../runtime/index.js";

function responseRuntime(
  status: number,
  body: unknown,
  json = true,
): DashboardRuntimeV1 {
  return {
    request: async () => ({ status, body, json }),
  } as unknown as DashboardRuntimeV1;
}

describe("requestJson", () => {
  it("returns a successful JSON response", async () => {
    setDashboardRuntime(responseRuntime(200, { ok: true }));

    await expect(requestJson<{ ok: boolean }>("/health")).resolves.toEqual({
      ok: true,
    });
  });

  it("preserves the Relay status and error code", async () => {
    setDashboardRuntime(
      responseRuntime(401, {
        error: { code: "unauthorized", message: "Member token is invalid" },
      }),
    );

    const error = await requestJson("/v1/sessions/session/me").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "Member token is invalid",
    });
    expect(isCredentialRejected(error)).toBe(true);
  });

  it("does not treat an approval denial as an expired credential", () => {
    expect(
      isCredentialRejected(
        new ApiRequestError(403, "member_not_approved", "Owner approval is required"),
      ),
    ).toBe(false);
  });
});
