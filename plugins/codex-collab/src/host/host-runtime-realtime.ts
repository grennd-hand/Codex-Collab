import type { LocalProfile } from "../persistence/local-profile.js";

export interface RealtimeSocket {
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  close(): void;
}

export interface RealtimeTicketClient {
  createRealtimeTicket(sessionId: string, memberToken: string): Promise<{ ticket: string }>;
}

export function hostRealtimeProfileKey(profile: LocalProfile): string {
  return `${profile.relayUrl}\n${profile.sessionId}\n${profile.memberToken}`;
}

export function reportHostRuntimeError(scope: string, error: unknown): void {
  console.error(scope, error instanceof Error ? error.message : String(error));
}
