import { HostIpcRemoteError, type McpHostIpcClient } from "./transport.js";
import type { HostIpcArguments, HostToolMethod } from "./protocol.js";

export type ConnectMcpHostIpcClient = () => Promise<McpHostIpcClient>;

/**
 * Keeps one authenticated MCP connection while it is healthy. A failed transport is never
 * retried in-place because the Host may already have accepted a mutating operation; the next
 * MCP request establishes a fresh connection through the connect-first controller instead.
 */
export class McpHostIpcClientManager {
  private clientPromise: Promise<McpHostIpcClient> | null = null;
  private closed = false;

  constructor(private readonly connect: ConnectMcpHostIpcClient) {}

  async callTool(
    method: HostToolMethod,
    params: HostIpcArguments,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.closed) throw new Error("MCP Host IPC client manager is closed");
    const clientPromise = this.clientPromise ??= this.connect();
    try {
      const client = await clientPromise;
      return await client.callTool(method, params, timeoutMs);
    } catch (error) {
      if (!(error instanceof HostIpcRemoteError)) this.invalidate(clientPromise);
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const clientPromise = this.clientPromise;
    this.clientPromise = null;
    if (clientPromise) void clientPromise.then((client) => client.close()).catch(() => undefined);
  }

  private invalidate(clientPromise: Promise<McpHostIpcClient>): void {
    if (this.clientPromise !== clientPromise) return;
    this.clientPromise = null;
    void clientPromise.then((client) => client.close()).catch(() => undefined);
  }
}
