import { describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  isCredentialRejected,
  requestJson,
} from "./api-client.js";

describe("requestJson", () => {
  it("returns a successful JSON response", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(requestJson<{ ok: boolean }>("/health", undefined, fetcher)).resolves.toEqual({
      ok: true,
    });
  });

  it("preserves the Relay status and error code", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: { code: "unauthorized", message: "Member token is invalid" },
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const error = await requestJson("/v1/sessions/session/me", undefined, fetcher).catch(
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
