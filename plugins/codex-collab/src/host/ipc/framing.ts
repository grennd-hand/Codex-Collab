import {
  HOST_IPC_AUTHENTICATED_FRAME_LIMIT,
  HOST_IPC_PROTOCOL_VERSION,
  HOST_IPC_UNAUTHENTICATED_FRAME_LIMIT,
  HostIpcProtocolError,
} from "./protocol.js";

const headerSize = 4;

export function encodeHostIpcFrame(value: unknown, authenticated: boolean): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const limit = frameLimit(authenticated);
  if (payload.byteLength > limit) {
    throw new HostIpcProtocolError(`IPC frame exceeds ${limit} byte limit`);
  }
  const frame = Buffer.allocUnsafe(headerSize + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, headerSize);
  return frame;
}

export class HostIpcFrameDecoder {
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private expectedPayloadBytes: number | undefined;
  private authenticated = false;

  setAuthenticated(): void {
    this.authenticated = true;
  }

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    this.chunks.push(Buffer.from(chunk));
    this.bufferedBytes += chunk.byteLength;
    const frames: unknown[] = [];
    while (true) {
      if (this.expectedPayloadBytes === undefined) {
        if (this.bufferedBytes < headerSize) break;
        const length = this.consume(headerSize).readUInt32LE(0);
        const limit = frameLimit(this.authenticated);
        if (length === 0 || length > limit) {
          this.reset();
          throw new HostIpcProtocolError(
            length === 0 ? "IPC frame cannot be empty" : `IPC frame exceeds ${limit} byte limit`,
          );
        }
        this.expectedPayloadBytes = length;
      }
      if (this.bufferedBytes < this.expectedPayloadBytes) break;
      const payload = this.consume(this.expectedPayloadBytes);
      this.expectedPayloadBytes = undefined;
      try {
        frames.push(decodePayload(payload));
      } catch (error) {
        this.reset();
        throw error;
      }
    }
    return frames;
  }

  private consume(size: number): Buffer {
    if (this.chunks[0]!.byteLength === size) {
      this.bufferedBytes -= size;
      return this.chunks.shift()!;
    }
    const result = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      const current = this.chunks[0]!;
      const count = Math.min(current.byteLength, size - written);
      current.copy(result, written, 0, count);
      written += count;
      if (count === current.byteLength) this.chunks.shift();
      else this.chunks[0] = current.subarray(count);
    }
    this.bufferedBytes -= size;
    return result;
  }

  private reset(): void {
    this.chunks.length = 0;
    this.bufferedBytes = 0;
    this.expectedPayloadBytes = undefined;
  }
}

function decodePayload(payload: Uint8Array): unknown {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    throw new HostIpcProtocolError("IPC frame is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostIpcProtocolError("IPC frame must be an object");
  }
  if ((value as { v?: unknown }).v !== HOST_IPC_PROTOCOL_VERSION) {
    throw new HostIpcProtocolError(
      `Unsupported IPC protocol version: ${String((value as { v?: unknown }).v)}`,
    );
  }
  return value;
}

function frameLimit(authenticated: boolean): number {
  return authenticated
    ? HOST_IPC_AUTHENTICATED_FRAME_LIMIT
    : HOST_IPC_UNAUTHENTICATED_FRAME_LIMIT;
}
