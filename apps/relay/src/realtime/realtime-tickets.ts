import type { Member, Session } from "@codex-collab/protocol";
import { ProtocolError } from "@codex-collab/protocol";
import { hashToken, issueToken } from "../security/token.js";

export interface RealtimeTicketIdentity {
  sessionId: string;
  member: Member;
  session: Session;
  accountSessionId: string | null;
}

interface StoredRealtimeTicket extends RealtimeTicketIdentity {
  expiresAtMs: number;
}

export class RealtimeTicketStore {
  private readonly tickets = new Map<string, StoredRealtimeTicket>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly maxTickets = 10_000,
    private readonly currentTime: () => number = Date.now,
  ) {}

  issue(identity: RealtimeTicketIdentity): { ticket: string; expiresAt: string } {
    const issuedAt = this.currentTime();
    this.removeExpired(issuedAt);
    while (this.tickets.size >= this.maxTickets) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tickets.delete(oldest);
    }

    const ticket = issueToken("ccr");
    const expiresAtMs = issuedAt + this.ttlMs;
    this.tickets.set(hashToken(ticket), { ...identity, expiresAtMs });
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(ticket: string): RealtimeTicketIdentity {
    const ticketHash = hashToken(ticket);
    const stored = this.tickets.get(ticketHash);
    this.tickets.delete(ticketHash);
    if (!stored || stored.expiresAtMs <= this.currentTime()) {
      throw new ProtocolError(
        401,
        "realtime_ticket_invalid",
        "Realtime ticket is invalid, expired, or already used",
      );
    }
    const { expiresAtMs: _expiresAtMs, ...identity } = stored;
    return identity;
  }

  private removeExpired(currentTime: number): void {
    for (const [ticketHash, ticket] of this.tickets) {
      if (ticket.expiresAtMs <= currentTime) {
        this.tickets.delete(ticketHash);
      }
    }
  }
}
