import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostService } from "./host-service.js";
import {
  hostRuntimeLockPath,
  readHostRuntimeLock,
} from "./host-runtime-lock.js";
import {
  publishHostIpcEndpoint,
  readHostIpcEndpoint,
} from "./ipc/endpoint.js";

const directories: string[] = [];
const instanceId = "0123456789abcdef0123456789abcdef";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("HostService shutdown", () => {
  it("closes IPC, drains runtime, then removes endpoint and releases the lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-host-service-"));
    directories.push(directory);
    await publishHostIpcEndpoint(
      {
        v: 1,
        instanceId,
        pipePath: `\\\\.\\pipe\\codex-collab-host-${instanceId}`,
        hostPid: process.pid,
        brokerPid: process.pid,
        createdAt: "2026-07-28T00:00:00.000Z",
        capabilities: [
          { clientKind: "mcp", keyId: "mcp", secret: Buffer.alloc(32, 1) },
          { clientKind: "desktop", keyId: "desktop", secret: Buffer.alloc(32, 2) },
        ],
      },
      directory,
    );
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        hostRuntimeLockPath(directory),
        `${JSON.stringify({ pid: process.pid })}\n`,
        "utf8",
      ),
    );

    const brokerStopped = deferred<void>();
    const runtimeStopped = deferred<void>();
    const broker = { stop: vi.fn(() => brokerStopped.promise) };
    const runtime = { stop: vi.fn(() => runtimeStopped.promise) };
    const HostServiceConstructor = HostService as unknown as new (
      runtime: { stop(): Promise<void> },
      broker: { stop(): Promise<void> },
      instanceId: string,
      stateDirectory: string,
    ) => HostService;
    const service = new HostServiceConstructor(runtime, broker, instanceId, directory);

    const stopping = service.stop();
    expect(broker.stop).toHaveBeenCalledTimes(1);
    expect(runtime.stop).not.toHaveBeenCalled();
    await expect(readHostIpcEndpoint("mcp", directory)).resolves.not.toBeNull();
    await expect(readHostRuntimeLock(hostRuntimeLockPath(directory))).resolves.not.toBeNull();

    brokerStopped.resolve();
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledTimes(1));
    await expect(readHostIpcEndpoint("mcp", directory)).resolves.not.toBeNull();
    await expect(readHostRuntimeLock(hostRuntimeLockPath(directory))).resolves.not.toBeNull();

    runtimeStopped.resolve();
    await stopping;
    await expect(readHostIpcEndpoint("mcp", directory)).resolves.toBeNull();
    await expect(readHostRuntimeLock(hostRuntimeLockPath(directory))).resolves.toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
