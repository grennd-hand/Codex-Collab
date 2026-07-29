import { describe, expect, it } from "vitest";
import { buildInviteLink, resolveInviteOrigin } from "./invite-link.js";

describe("invite links", () => {
  it("puts the one-time token in a browser fragment", () => {
    const link = buildInviteLink("https://collab.example.com", "cci_one-time");
    const url = new URL(link);

    expect(url.origin).toBe("https://collab.example.com");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("invite")).toBe("cci_one-time");
    expect(link.slice(0, link.indexOf("#"))).not.toContain("cci_one-time");
  });

  it("uses the configured public URL instead of an untrusted request host", () => {
    expect(
      resolveInviteOrigin({
        configuredPublicUrl: "https://team.example.com/dashboard",
        forwardedProto: "http",
        hostHeader: "attacker.example",
        listenHost: "127.0.0.1",
        listenPort: 4177,
        trustProxy: true,
      }),
    ).toBe("https://team.example.com");
  });

  it("trusts forwarded protocol only when explicitly enabled", () => {
    const base = {
      forwardedProto: "https",
      hostHeader: "relay.example.com",
      listenHost: "127.0.0.1",
      listenPort: 4177,
    };

    expect(resolveInviteOrigin({ ...base, trustProxy: false })).toBe(
      "http://relay.example.com",
    );
    expect(resolveInviteOrigin({ ...base, trustProxy: true })).toBe(
      "https://relay.example.com",
    );
  });
});
