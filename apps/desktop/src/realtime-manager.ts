import type { RealtimeEnvelope } from "@codex-collab/protocol";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { DesktopRealtimeEventV1 } from "./ipc-contract.js";
import {
  DesktopRelayTransport,
} from "./relay-http-client.js";
import { RelayTransportError } from "./relay-transport.js";

const MAX_REALTIME_FRAME_BYTES = 64 * 1024;
const REALTIME_TYPES = new Set<RealtimeEnvelope["type"]>([
  "ready",
  "session.updated",
  "member.updated",
  "message.created",
  "workspace.updated",
  "file.operation.updated",
]);

function parseEnvelope(raw: RawData, expectedSessionId: string): RealtimeEnvelope {
  const buffer = Array.isArray(raw)
    ? Buffer.concat(raw)
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw)
      : Buffer.from(raw);
  if (buffer.length > MAX_REALTIME_FRAME_BYTES) {
    throw new Error("realtime_frame_too_large");
  }
  const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("invalid_realtime_event");
  const envelope = parsed as Partial<RealtimeEnvelope>;
  if (
    !envelope.type ||
    !REALTIME_TYPES.has(envelope.type) ||
    envelope.sessionId !== expectedSessionId ||
    typeof envelope.sentAt !== "string"
  ) {
    throw new Error("invalid_realtime_event");
  }
  return envelope as RealtimeEnvelope;
}

export class DesktopRealtimeManager {
  private readonly sockets = new Map<string, WebSocket>();

  constructor(
    private readonly relayOrigin: string,
    private readonly relay: DesktopRelayTransport,
    private readonly publish: (event: DesktopRealtimeEventV1) => void,
  ) {}

  async connect(sessionIdValue: unknown): Promise<{ connectionId: string }> {
    await this.closeAll();
    const { sessionId, ticket } = await this.relay.issueRealtimeTicket(
      sessionIdValue,
    );
    const endpoint = new URL("/v1/realtime", this.relayOrigin);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    endpoint.searchParams.set("sessionId", sessionId);
    endpoint.searchParams.set("ticket", ticket);
    const connectionId = randomUUID();

    return new Promise((resolve, reject) => {
      let opened = false;
      const socket = new WebSocket(endpoint, {
        followRedirects: false,
        handshakeTimeout: 10_000,
        maxPayload: MAX_REALTIME_FRAME_BYTES,
        perMessageDeflate: false,
      });
      this.sockets.set(connectionId, socket);

      socket.once("open", () => {
        opened = true;
        this.publish({ connectionId, event: { type: "open" } });
        resolve({ connectionId });
      });
      socket.on("message", (raw, isBinary) => {
        if (isBinary) {
          socket.close(1003, "Text frames required");
          return;
        }
        try {
          this.publish({
            connectionId,
            event: {
              type: "message",
              envelope: parseEnvelope(raw, sessionId),
            },
          });
        } catch {
          socket.close(1007, "Invalid realtime event");
        }
      });
      socket.once("error", () => {
        this.publish({
          connectionId,
          event: { type: "error" },
        });
        if (!opened) {
          reject(
            new RelayTransportError(
              "realtime_unavailable",
              "Realtime is unavailable.",
              503,
            ),
          );
        }
      });
      socket.once("close", (code) => {
        this.sockets.delete(connectionId);
        this.publish({ connectionId, event: { type: "close", code } });
      });
    });
  }

  async close(connectionId: string): Promise<void> {
    const socket = this.sockets.get(connectionId);
    if (!socket) return;
    this.sockets.delete(connectionId);
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 2_000);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.close(1000, "Desktop closed realtime");
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sockets.keys()].map((id) => this.close(id)));
  }
}
