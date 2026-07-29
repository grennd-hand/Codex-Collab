import { describe, expect, it } from "vitest";
import { normalizeRelayOrigin, resolveDesktopConfig } from "./desktop-config.js";

describe("desktop Relay configuration", () => {
  it("defaults only to the Primary Relay", () => {
    expect(resolveDesktopConfig({}, true).publicRelayOrigin).toBe(
      "https://codex-collab.217.194.133.194.sslip.io",
    );
  });

  it("allows loopback HTTP only for unpackaged development", () => {
    expect(normalizeRelayOrigin("http://127.0.0.1:4178", true)).toBe(
      "http://127.0.0.1:4178",
    );
    expect(() => normalizeRelayOrigin("http://127.0.0.1:4178", false)).toThrow();
  });

  it.each([
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/?token=value",
    "http://relay.example.com",
  ])("rejects unsafe origin %s", (origin) => {
    expect(() => normalizeRelayOrigin(origin, true)).toThrow();
  });
});
