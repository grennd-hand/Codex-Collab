import { describe, expect, it } from "vitest";
import type { Member, Session } from "@codex-collab/protocol";
import { RealtimeTicketStore } from "./realtime-tickets.js";

const session: Session = {
  id: "session-1",
  name: "Room",
  ownerMemberId: "member-1",
  roomStatus: "open",
  createdAt: "2026-07-26T00:00:00.000Z",
};

const member: Member = {
  id: "member-1",
  sessionId: session.id,
  displayName: "Owner",
  deviceLabel: null,
  role: "owner",
  status: "approved",
  workspaceFileAccess: "workspace-write",
  createdAt: session.createdAt,
  approvedAt: session.createdAt,
};

describe("RealtimeTicketStore", () => {
  it("issues a short-lived ticket that can be consumed only once", () => {
    let currentTime = Date.parse("2026-07-26T00:00:00.000Z");
    const store = new RealtimeTicketStore(30_000, 10, () => currentTime);
    const issued = store.issue({
      sessionId: session.id,
      member,
      session,
      accountSessionId: "account-session-1",
    });

    expect(issued.ticket).toMatch(/^ccr_[A-Za-z0-9_-]+$/);
    expect(issued.expiresAt).toBe("2026-07-26T00:00:30.000Z");
    expect(store.consume(issued.ticket)).toEqual({
      sessionId: session.id,
      member,
      session,
      accountSessionId: "account-session-1",
    });
    expect(() => store.consume(issued.ticket)).toThrowError(/already used|invalid/i);

    const expired = store.issue({
      sessionId: session.id,
      member,
      session,
      accountSessionId: null,
    });
    currentTime += 30_001;
    expect(() => store.consume(expired.ticket)).toThrowError(/expired|invalid/i);
  });

  it("keeps the in-memory ticket set bounded", () => {
    const store = new RealtimeTicketStore(30_000, 2, () => 1_000);
    const identity = { sessionId: session.id, member, session, accountSessionId: null };
    const first = store.issue(identity);
    store.issue(identity);
    const third = store.issue(identity);

    expect(() => store.consume(first.ticket)).toThrowError(/invalid/i);
    expect(store.consume(third.ticket).sessionId).toBe(session.id);
  });
});
