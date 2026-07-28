import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member, Session } from "@codex-collab/protocol";
import {
  type CredentialEncryption,
  EncryptedCredentialStore,
} from "./credential-store.js";
import {
  buildRelayRequest,
  RelayTransportError,
} from "./relay-transport.js";
import { DesktopRelayTransport } from "./relay-http-client.js";

const directories: string[] = [];
const encryption: CredentialEncryption = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value, "utf8"),
  decrypt: (value) => value.toString("utf8"),
};

const session: Session = {
  id: "session-owner",
  name: "Room",
  ownerMemberId: "member-owner",
  roomStatus: "open",
  createdAt: "2026-07-28T00:00:00.000Z",
};
const owner: Member = {
  id: "member-owner",
  sessionId: session.id,
  displayName: "Owner",
  deviceLabel: "Desktop",
  role: "owner",
  status: "approved",
  workspaceFileAccess: "workspace-write",
  createdAt: session.createdAt,
  approvedAt: session.createdAt,
};

async function store(): Promise<EncryptedCredentialStore> {
  const directory = await mkdtemp(join(tmpdir(), "codex-collab-relay-"));
  directories.push(directory);
  return new EncryptedCredentialStore(directory, encryption);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("desktop Relay request allowlist", () => {
  it("maps typed operations without accepting a URL or headers", () => {
    expect(
      buildRelayRequest(
        { operation: "session.members.approve", sessionId: session.id, memberId: "member/2" },
        session.id,
      ),
    ).toMatchObject({
      method: "POST",
      path: "/v1/sessions/session-owner/members/member%2F2/approve",
      requiresCredential: true,
    });
    expect(() =>
      buildRelayRequest({ operation: "raw.fetch", url: "file:///secret" }, session.id),
    ).toThrow("not allowed");
  });

  it("rejects a request for a room other than the stored credential", () => {
    expect(() =>
      buildRelayRequest(
        { operation: "session.me.get", sessionId: "another-room" },
        session.id,
      ),
    ).toThrowError(RelayTransportError);
  });

  it("requires the selected task on Codex prompts", () => {
    expect(() =>
      buildRelayRequest(
        {
          operation: "session.messages.create",
          sessionId: session.id,
          input: { kind: "codex_prompt", body: "Run this" },
        },
        session.id,
      ),
    ).toThrow("expectedWorkspaceThreadId");
  });
});

describe("desktop Relay credential boundary", () => {
  it("captures setup tokens and never returns them to the renderer", async () => {
    const credentials = await store();
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          session,
          owner,
          memberToken: "test-only-owner-token",
          recoveryKey: "recovery-test-value",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const transport = new DesktopRelayTransport(
      "https://relay.example.com",
      credentials,
      fetcher,
    );

    const response = await transport.perform({
      operation: "session.create",
      input: { name: "Room", ownerDisplayName: "Owner", deviceLabel: "Desktop" },
    });
    expect(response.body).not.toHaveProperty("memberToken");
    await expect(credentials.load()).resolves.toMatchObject({
      token: "test-only-owner-token",
    });
  });

  it("injects the stored bearer token from Main", async () => {
    const credentials = await store();
    await credentials.save({ session, member: owner, token: "main-only-token" });
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer main-only-token",
      );
      return new Response(JSON.stringify({ session, member: owner }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const transport = new DesktopRelayTransport(
      "https://relay.example.com",
      credentials,
      fetcher,
    );
    await transport.perform({ operation: "session.me.get", sessionId: session.id });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
