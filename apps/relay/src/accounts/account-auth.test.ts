import { afterEach, describe, expect, it } from "vitest";
import { AccountAuthService, resolvePasskeyConfig } from "./account-auth.js";
import { SessionStore } from "../application/session-store.js";

const stores: SessionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("resolvePasskeyConfig", () => {
  it("uses one exact HTTPS origin and RP ID", () => {
    expect(
      resolvePasskeyConfig({
        configuredOrigin: "https://collab.example.com",
        configuredRpId: "collab.example.com",
      }),
    ).toMatchObject({
      origin: "https://collab.example.com",
      rpId: "collab.example.com",
      secureCookies: true,
    });
  });

  it("allows an explicit loopback development origin", () => {
    expect(resolvePasskeyConfig({ requestHost: "127.0.0.1:4177" })).toMatchObject({
      origin: "http://127.0.0.1:4177",
      rpId: "127.0.0.1",
      secureCookies: false,
    });
  });

  it("fails closed for non-loopback Host headers and mismatched RP IDs", () => {
    expect(() =>
      resolvePasskeyConfig({ requestHost: "evil.example.com" }),
    ).toThrowError(/configured/i);
    expect(() =>
      resolvePasskeyConfig({
        configuredOrigin: "https://collab.example.com",
        configuredRpId: "example.com",
      }),
    ).toThrowError(/exactly match/i);
  });

  it("creates server-side, user-verifying, discoverable Passkey challenges", async () => {
    const store = new SessionStore();
    stores.push(store);
    const service = new AccountAuthService(store);
    const config = resolvePasskeyConfig({
      configuredOrigin: "https://collab.example.com",
    });

    const registration = await service.beginRegistration("Owner", config);
    expect(registration.options.rp.id).toBe("collab.example.com");
    expect(registration.options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
    const stored = store.consumeAccountChallenge(
      registration.ceremonyToken,
      "registration",
    );
    expect(stored.expectedOrigin).toBe("https://collab.example.com");
    expect(stored.displayName).toBe("Owner");

    const authentication = await service.beginAuthentication(config);
    expect(authentication.options.rpId).toBe("collab.example.com");
    expect(authentication.options.userVerification).toBe("required");
    expect(authentication.options.allowCredentials).toBeUndefined();

    const storedTokens = store.db
      .prepare("SELECT token_hash FROM account_challenges")
      .all() as unknown as Array<{ token_hash: string }>;
    expect(
      storedTokens.some((row) => row.token_hash.includes(authentication.ceremonyToken)),
    ).toBe(false);
  });
});
