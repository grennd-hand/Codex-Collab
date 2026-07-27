import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import type { RealtimeEnvelope } from "@codex-collab/protocol";
import type {
  AccountAuthService,
  PasskeyRequestConfig,
} from "../account-auth.js";
import type {
  AccountSessionIdentity,
  SessionStore,
} from "../session-store.js";
import type { RealtimeTicketStore } from "../realtime-tickets.js";

export interface RelayRouteContext {
  store: SessionStore;
  accountAuth: AccountAuthService;
  realtimeTickets: RealtimeTicketStore;
  configuredPublicUrl: string | undefined;
  host: string;
  port: number;
  trustProxy: boolean;
  sendJson(
    response: ServerResponse,
    statusCode: number,
    body: unknown,
    headers?: OutgoingHttpHeaders,
  ): void;
  sendAttachment(
    response: ServerResponse,
    attachment: {
      name: string;
      media_type: string;
      size: number;
      content: Uint8Array;
    },
  ): void;
  readJson(
    request: IncomingMessage,
    maxBytes?: number,
  ): Promise<Record<string, unknown>>;
  bearerToken(request: IncomingMessage): string;
  prefersMinimalResponse(request: IncomingMessage): boolean;
  passkeyConfig(request: IncomingMessage): PasskeyRequestConfig;
  cookieName(kind: "account" | "ceremony", secure: boolean): string;
  cookieValue(request: IncomingMessage, name: string): string | null;
  setCookie(
    kind: "account" | "ceremony",
    value: string,
    config: PasskeyRequestConfig,
    maxAgeSeconds: number,
  ): string;
  clearCookie(
    kind: "account" | "ceremony",
    config: PasskeyRequestConfig,
  ): string;
  assertAccountRequestOrigin(
    request: IncomingMessage,
    config: PasskeyRequestConfig,
  ): void;
  enforceRateLimit(
    request: IncomingMessage,
    scope: string,
    limit?: number,
    windowMs?: number,
  ): void;
  optionalAccountForWrite(
    request: IncomingMessage,
    config: PasskeyRequestConfig,
  ): AccountSessionIdentity | null;
  requireAccountForWrite(
    request: IncomingMessage,
    config: PasskeyRequestConfig,
  ): AccountSessionIdentity;
  requireCsrfToken(request: IncomingMessage): string;
  optionalConfiguredAccountForWrite(
    request: IncomingMessage,
  ): AccountSessionIdentity | null;
  broadcast(
    sessionId: string,
    type: RealtimeEnvelope["type"],
    payload: unknown,
  ): void;
  closeAccountSessionSockets(accountSessionId: string): void;
}
