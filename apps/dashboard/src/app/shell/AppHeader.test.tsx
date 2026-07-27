import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Member } from "@codex-collab/protocol";
import { HeaderIdentity } from "./HeaderIdentity.js";

const member: Member = {
  id: "member-1",
  sessionId: "session-1",
  displayName: "小米",
  deviceLabel: null,
  role: "owner",
  status: "approved",
  workspaceFileAccess: "workspace-write",
  createdAt: "2026-07-28T00:00:00.000Z",
  approvedAt: "2026-07-28T00:00:00.000Z",
};

describe("HeaderIdentity", () => {
  it("shows an anonymous room member and role without a login action", () => {
    const markup = renderToStaticMarkup(createElement(HeaderIdentity, {
      member,
      accountDisplayName: null,
      onOpenAccount: () => undefined,
    }));

    expect(markup).toContain("小米");
    expect(markup).toContain("房主");
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("登录");
  });

  it("opens saved rooms only when the member has an account", () => {
    const markup = renderToStaticMarkup(createElement(HeaderIdentity, {
      member,
      accountDisplayName: "小米账号",
      onOpenAccount: () => undefined,
    }));

    expect(markup).toContain("打开我的房间");
    expect(markup).not.toContain("登录账号");
  });

  it("keeps account login available before entering a room", () => {
    const markup = renderToStaticMarkup(createElement(HeaderIdentity, {
      member: null,
      accountDisplayName: null,
      onOpenAccount: () => undefined,
    }));

    expect(markup).toContain("登录账号");
  });
});
