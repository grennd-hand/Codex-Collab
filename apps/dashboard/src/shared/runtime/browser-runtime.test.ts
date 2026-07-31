import { describe, expect, it, vi } from "vitest";
import type { Member, Session } from "@codex-collab/protocol";
import {
  bindBrowserFetch,
  createBrowserRuntime,
  type BrowserRuntimeEnvironment,
} from "./browser-runtime.js";

const session: Session = {
  id: "session-1",
  name: "Room",
  ownerMemberId: "member-1",
  roomStatus: "open",
  createdAt: "2026-07-28T00:00:00.000Z",
};
const member: Member = {
  id: "member-1",
  sessionId: session.id,
  displayName: "Owner",
  deviceLabel: "Browser",
  role: "owner",
  status: "approved",
  workspaceFileAccess: "workspace-write",
  createdAt: session.createdAt,
  approvedAt: session.createdAt,
};

function environment(initialCredential?: unknown) {
  const stored = new Map<string, string>();
  if (initialCredential) stored.set("codexCollab", JSON.stringify(initialCredential));
  const fetcher = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const openExternal = vi.fn();
  const notify = vi.fn();
  const value: BrowserRuntimeEnvironment = {
    fetch: fetcher as typeof fetch,
    WebSocket: class {} as unknown as typeof WebSocket,
    location: {
      hash: "#invite=invite-1",
      host: "relay.example.test",
      hostname: "relay.example.test",
      origin: "https://relay.example.test",
      pathname: "/",
      protocol: "https:",
      search: "",
    },
    history: { replaceState: vi.fn() },
    navigator: { platform: "Windows" },
    sessionStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, next) => stored.set(key, next),
      removeItem: (key) => void stored.delete(key),
    },
    openExternal,
    notify,
  };
  return { value, fetcher, stored, openExternal, notify };
}

describe("browser Dashboard runtime", () => {
  it("binds native fetch to the browser Window receiver", async () => {
    const fallback = vi.fn();
    const browserWindow = {
      fetch: vi.fn(function (this: unknown) {
        if (this !== browserWindow) {
          throw new TypeError("Illegal invocation");
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    } as unknown as Pick<Window, "fetch">;

    const fetcher = bindBrowserFetch(browserWindow, fallback as typeof fetch);

    await expect(fetcher("/health")).resolves.toMatchObject({ status: 204 });
    expect(browserWindow.fetch).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("preserves same-origin requests and browser bearer auth", async () => {
    const setup = environment();
    const runtime = createBrowserRuntime(setup.value);

    await runtime.request({
      operation: "session.me.get",
      sessionId: session.id,
      authorization: "member-secret",
    });

    expect(setup.fetcher).toHaveBeenCalledWith(
      "/v1/sessions/session-1/me",
      expect.objectContaining({
        headers: { authorization: "Bearer member-secret" },
      }),
    );
    expect(runtime.inviteToken).toBe("invite-1");
    expect(runtime.publicRelayOrigin).toBe("https://relay.example.test");
    await expect(runtime.host.getStatus()).resolves.toBeNull();
  });

  it("migrates the legacy sessionStorage token shape", async () => {
    const setup = environment({ session, member, token: "legacy-secret" });
    const runtime = createBrowserRuntime(setup.value);

    await expect(runtime.credentials.load()).resolves.toEqual({
      session,
      member,
      authorization: {
        kind: "browser-bearer",
        bearerToken: "legacy-secret",
      },
    });
  });

  it("uses a short-lived ticket rather than a bearer token in the WebSocket URL", async () => {
    const setup = environment();
    let socketUrl = "";
    class FakeWebSocket {
      constructor(url: string | URL) {
        socketUrl = String(url);
      }
      addEventListener() {}
      close() {}
    }
    setup.value.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    setup.fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ticket: "short-lived-ticket",
          expiresAt: "2026-07-28T00:01:00.000Z",
        }),
        { status: 200 },
      ),
    );
    const runtime = createBrowserRuntime(setup.value);

    await runtime.connectRealtime(
      { sessionId: session.id, authorization: "member-secret" },
      { onEvent: vi.fn() },
    );

    expect(setup.fetcher).toHaveBeenCalledWith(
      "/v1/sessions/session-1/realtime-tickets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer member-secret",
        }),
      }),
    );
    expect(socketUrl).toContain("ticket=short-lived-ticket");
    expect(socketUrl).not.toContain("member-secret");
  });

  it("removes damaged saved credentials", async () => {
    const setup = environment({ session, member });
    const runtime = createBrowserRuntime(setup.value);
    await expect(runtime.credentials.load()).resolves.toBeNull();
    expect(setup.stored.has("codexCollab")).toBe(false);
  });

  it("opens only credential-free HTTPS links and delegates notifications", async () => {
    const setup = environment();
    const runtime = createBrowserRuntime(setup.value);

    await runtime.shell.openExternal("https://example.test/docs");
    await runtime.shell.notify({ title: "New message", body: "Open the room." });

    expect(setup.openExternal).toHaveBeenCalledWith("https://example.test/docs");
    expect(setup.notify).toHaveBeenCalledWith({
      title: "New message",
      body: "Open the room.",
    });
    await expect(
      runtime.shell.openExternal("file:///C:/Windows/System32/calc.exe"),
    ).rejects.toThrow("external_url_rejected");
  });
});
