import { describe, expect, it } from "vitest";
import {
  DESKTOP_CSP,
  resolveDesktopAsset,
  validatedExternalUrl,
  validatedNotification,
} from "./security-policy.js";

describe("desktop custom protocol policy", () => {
  it("serves only the entry point and one-level Vite assets", () => {
    expect(
      resolveDesktopAsset("codex-collab://app/index.html", "GET", "C:/app/renderer"),
    ).toMatchObject({
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-store",
    });
    expect(
      resolveDesktopAsset(
        "codex-collab://app/assets/ts.worker-A1b2.js",
        "GET",
        "C:/app/renderer",
      ),
    ).toMatchObject({
      contentType: "text/javascript; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(
      resolveDesktopAsset(
        "codex-collab://app/assets/codicon-1.ttf",
        "GET",
        "C:/app/renderer",
      ).contentType,
    ).toBe("font/ttf");
  });

  it.each([
    "codex-collab://other/index.html",
    "codex-collab://app/../package.json",
    "codex-collab://app/%2e%2e/package.json",
    "codex-collab://app/%252e%252e/package.json",
    "codex-collab://app/assets/nested/file.js",
    "codex-collab://app/assets/file.exe",
    "codex-collab://app/index.html?debug=1",
  ])("rejects %s", (url) => {
    expect(() => resolveDesktopAsset(url, "GET", "C:/app/renderer")).toThrow();
  });

  it("rejects non-GET protocol methods", () => {
    expect(() =>
      resolveDesktopAsset("codex-collab://app/index.html", "POST", "C:/app/renderer"),
    ).toThrow("desktop_asset_method_rejected");
  });

  it("uses a renderer CSP with no network or eval escape", () => {
    expect(DESKTOP_CSP).toContain("connect-src 'none'");
    expect(DESKTOP_CSP).toContain("object-src 'none'");
    expect(DESKTOP_CSP).not.toContain("unsafe-eval");
  });
});

describe("external URL policy", () => {
  it("allows credential-free HTTPS links", () => {
    expect(validatedExternalUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
  });

  it.each([
    "http://example.com",
    "file:///C:/Windows/System32/calc.exe",
    "https://user:password@example.com",
    "javascript:alert(1)",
  ])("rejects %s", (url) => {
    expect(() => validatedExternalUrl(url)).toThrow("external_url_rejected");
  });
});

describe("desktop notification policy", () => {
  it("accepts a small exact title and body object", () => {
    expect(
      validatedNotification({ title: "Codex Collab", body: "有新消息。" }),
    ).toEqual({ title: "Codex Collab", body: "有新消息。" });
  });

  it.each([
    null,
    { title: "", body: "body" },
    { title: "title", body: " line" },
    { title: "title\nspoofed", body: "body" },
    { title: "title", body: "body", token: "secret" },
    { title: "x".repeat(81), body: "body" },
    { title: "title", body: "x".repeat(161) },
  ])("rejects invalid notification input %#", (input) => {
    expect(() => validatedNotification(input)).toThrow("notification_rejected");
  });
});
