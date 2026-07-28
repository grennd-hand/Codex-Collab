import { describe, expect, it, vi } from "vitest";
import { McpHostIpcClientManager } from "./mcp-client-manager.js";
import { HostIpcRemoteError, type McpHostIpcClient } from "./transport.js";

function client(result: unknown): McpHostIpcClient {
  return {
    callTool: vi.fn().mockImplementation(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    ),
    status: vi.fn(),
    close: vi.fn(),
  };
}

describe("McpHostIpcClientManager", () => {
  it("reuses a healthy connection", async () => {
    const connected = client({ ok: true });
    const connect = vi.fn().mockResolvedValue(connected);
    const manager = new McpHostIpcClientManager(connect);

    await expect(manager.callTool("collab_status", {})).resolves.toEqual({ ok: true });
    await expect(manager.callTool("collab_status", {})).resolves.toEqual({ ok: true });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not retry an uncertain operation and reconnects on the next request", async () => {
    const disconnected = client(new Error("broker pipe closed"));
    const recovered = client({ generation: "replacement" });
    const connect = vi.fn()
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce(recovered);
    const manager = new McpHostIpcClientManager(connect);

    await expect(manager.callTool("collab_status", {})).rejects.toThrow("broker pipe closed");
    expect(disconnected.callTool).toHaveBeenCalledTimes(1);
    await expect(manager.callTool("collab_status", {})).resolves.toEqual({
      generation: "replacement",
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(disconnected.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the connection for an authenticated Host tool error", async () => {
    const remoteError = new HostIpcRemoteError({
      code: "host_error",
      message: "No active session",
    });
    const connected = client(remoteError);
    const connect = vi.fn().mockResolvedValue(connected);
    const manager = new McpHostIpcClientManager(connect);

    await expect(manager.callTool("collab_status", {})).rejects.toBe(remoteError);
    await expect(manager.callTool("collab_status", {})).rejects.toBe(remoteError);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connected.close).not.toHaveBeenCalled();
  });

  it("closes without stopping the Host and rejects future requests", async () => {
    const connected = client({ ok: true });
    const manager = new McpHostIpcClientManager(() => Promise.resolve(connected));
    await manager.callTool("collab_status", {});

    manager.close();
    await vi.waitFor(() => expect(connected.close).toHaveBeenCalledTimes(1));
    await expect(manager.callTool("collab_status", {})).rejects.toThrow("manager is closed");
  });
});
