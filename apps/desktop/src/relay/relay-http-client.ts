import type { Member, Session } from "@codex-collab/protocol";
import type { RuntimeErrorV1, RuntimeResponseV1 } from "../ipc/ipc-contract.js";
import {
  type DesktopCredential,
  EncryptedCredentialStore,
} from "../credentials/credential-store.js";
import {
  type BuiltRelayRequest,
  buildRelayRequest,
  exactSession,
  record,
  RelayTransportError,
  sessionPath,
  stringValue,
} from "./relay-transport.js";

const MAX_JSON_RESPONSE_BYTES = 10_000_000;
const MAX_ATTACHMENT_RESPONSE_BYTES = 6_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

async function readLimited(response: Response, maximum: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new RelayTransportError(
      "relay_response_too_large",
      "The Relay response is too large.",
      502,
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new RelayTransportError(
        "relay_response_too_large",
        "The Relay response is too large.",
        502,
      );
    }
    chunks.push(Buffer.from(result.value));
  }
  return Buffer.concat(chunks, size);
}

function parseJson(buffer: Buffer): { body: unknown; json: boolean } {
  if (buffer.length === 0) return { body: null, json: false };
  try {
    return { body: JSON.parse(buffer.toString("utf8")) as unknown, json: true };
  } catch {
    return { body: null, json: false };
  }
}

function setupCredential(
  data: unknown,
  memberField: "owner" | "member",
): DesktopCredential {
  const response = record(data, "invalid_relay_response");
  const session = record(
    response.session,
    "invalid_relay_response",
  ) as unknown as Session;
  const member = record(
    response[memberField],
    "invalid_relay_response",
  ) as unknown as Member;
  const token = stringValue(response.memberToken, "memberToken", 1_000);
  if (
    typeof session.id !== "string" ||
    typeof member.id !== "string" ||
    member.sessionId !== session.id
  ) {
    throw new RelayTransportError(
      "invalid_relay_response",
      "The Relay returned an invalid session.",
      502,
    );
  }
  return { session, member, token };
}

function withoutMemberToken(data: unknown): unknown {
  const response = record(data, "invalid_relay_response");
  const { memberToken: _memberToken, ...safe } = response;
  return safe;
}

export function runtimeError(caught: unknown): RuntimeErrorV1 {
  if (caught instanceof RelayTransportError) {
    return { code: caught.code, message: caught.message, status: caught.status };
  }
  return {
    code: "desktop_transport_failed",
    message: "The desktop request failed.",
    status: 0,
  };
}

export class DesktopRelayTransport {
  constructor(
    private readonly relayOrigin: string,
    private readonly credentials: EncryptedCredentialStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async execute(
    built: BuiltRelayRequest,
    credential: DesktopCredential | null,
    responseLimit = MAX_JSON_RESPONSE_BYTES,
  ): Promise<{ response: Response; body: Buffer }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers = new Headers({ accept: "application/json" });
      if (built.body !== undefined) headers.set("content-type", "application/json");
      if (built.requiresCredential) {
        if (!credential) {
          throw new RelayTransportError(
            "credential_required",
            "Owner authentication is required.",
            401,
          );
        }
        headers.set("authorization", `Bearer ${credential.token}`);
      }
      const response = await this.fetcher(new URL(built.path, this.relayOrigin), {
        method: built.method,
        headers,
        ...(built.body === undefined ? {} : { body: built.body }),
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new RelayTransportError(
          "relay_redirect_rejected",
          "Relay redirects are not allowed.",
          502,
        );
      }
      return { response, body: await readLimited(response, responseLimit) };
    } catch (caught) {
      if (caught instanceof RelayTransportError) throw caught;
      if (caught instanceof DOMException && caught.name === "AbortError") {
        throw new RelayTransportError(
          "relay_timeout",
          "The Relay request timed out.",
          504,
        );
      }
      throw new RelayTransportError(
        "relay_unavailable",
        "The Relay is unavailable.",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async perform(value: unknown): Promise<RuntimeResponseV1> {
    const credential = await this.credentials.load();
    const built = buildRelayRequest(value, credential?.session.id ?? null);
    const { response, body } = await this.execute(built, credential);
    const decoded = parseJson(body);
    let safeBody = decoded.body;

    if (
      response.ok &&
      ["session.create", "session.recover", "invite.join"].includes(
        built.operation,
      )
    ) {
      if (!decoded.json) {
        throw new RelayTransportError(
          "invalid_relay_response",
          "The Relay returned invalid JSON.",
          502,
        );
      }
      const memberField = built.operation === "invite.join" ? "member" : "owner";
      await this.credentials.save(setupCredential(decoded.body, memberField));
      safeBody = withoutMemberToken(decoded.body);
    } else if (
      response.ok &&
      built.operation === "session.me.get" &&
      credential &&
      decoded.json
    ) {
      await this.refreshCredentialSnapshot(decoded.body, credential);
    }
    return { status: response.status, body: safeBody, json: decoded.json };
  }

  private async refreshCredentialSnapshot(
    data: unknown,
    credential: DesktopCredential,
  ): Promise<void> {
    const value = record(data, "invalid_relay_response");
    const updated: DesktopCredential = {
      session: record(value.session, "invalid_relay_response") as unknown as Session,
      member: record(value.member, "invalid_relay_response") as unknown as Member,
      token: credential.token,
    };
    if (
      updated.session.id !== credential.session.id ||
      updated.member.sessionId !== updated.session.id
    ) {
      throw new RelayTransportError(
        "invalid_relay_response",
        "The Relay returned an invalid session.",
        502,
      );
    }
    await this.credentials.save(updated);
  }

  async downloadMessageAttachment(value: unknown): Promise<ArrayBuffer> {
    const input = record(value);
    const credential = await this.credentials.load();
    const sessionId = exactSession(input, credential?.session.id ?? null);
    const path = sessionPath(
      sessionId,
      `/messages/${encodeURIComponent(
        stringValue(input.messageId, "messageId", 100),
      )}/attachments/${encodeURIComponent(
        stringValue(input.attachmentId, "attachmentId", 100),
      )}`,
    );
    const { response, body } = await this.execute(
      {
        operation: "session.messages.list",
        method: "GET",
        path,
        requiresCredential: true,
      },
      credential,
      MAX_ATTACHMENT_RESPONSE_BYTES,
    );
    if (!response.ok) {
      throw new RelayTransportError(
        "attachment_read_failed",
        `Attachment download failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    return body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
  }

  async issueRealtimeTicket(
    sessionIdValue: unknown,
  ): Promise<{ sessionId: string; ticket: string }> {
    const credential = await this.credentials.load();
    const sessionId = exactSession(
      { sessionId: sessionIdValue },
      credential?.session.id ?? null,
    );
    const built: BuiltRelayRequest = {
      operation: "session.me.get",
      method: "POST",
      path: sessionPath(sessionId, "/realtime-tickets"),
      requiresCredential: true,
      body: "{}",
    };
    const { response, body } = await this.execute(built, credential);
    if (!response.ok) {
      throw new RelayTransportError(
        "realtime_ticket_failed",
        "Could not open realtime.",
        response.status,
      );
    }
    const value = record(parseJson(body).body, "invalid_relay_response");
    return { sessionId, ticket: stringValue(value.ticket, "ticket", 1_000) };
  }
}
