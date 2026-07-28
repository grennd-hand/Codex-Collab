import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC,
  type RuntimeResultV1,
} from "./ipc-contract.js";
import {
  registerDesktopIpc,
  type DesktopIpcDependencies,
} from "./ipc-handlers.js";

type RegisteredHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function trustedEvent(): unknown {
  const frame: { url: string; top?: unknown } = {
    url: "codex-collab://app/index.html",
  };
  frame.top = frame;
  return { senderFrame: frame, sender: { mainFrame: frame } };
}

function fixture() {
  const handlers = new Map<string, RegisteredHandler>();
  const openExternal = vi.fn(async () => undefined);
  const notify = vi.fn();
  const dependencies = {
    app: { getVersion: () => "0.1.0-beta.1" },
    ipcMain: {
      handle(channel: string, handler: RegisteredHandler) {
        handlers.set(channel, handler);
      },
    },
    relayOrigin: "https://relay.example.test",
    credentials: {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    },
    relay: {
      perform: vi.fn(),
      downloadMessageAttachment: vi.fn(),
    },
    realtime: {
      connect: vi.fn(),
      close: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined),
    },
    host: { getStatus: vi.fn() },
    shell: { openExternal, notify },
  } as unknown as DesktopIpcDependencies;
  registerDesktopIpc(dependencies);
  return { handlers, notify, openExternal };
}

describe("desktop IPC shell boundary", () => {
  it("applies trusted-frame validation to every invoke handler", async () => {
    const { handlers } = fixture();
    const eventChannels = new Set([
      DESKTOP_IPC.realtimeEvent,
      DESKTOP_IPC.hostStatusEvent,
    ]);
    const invokeChannels = Object.values(DESKTOP_IPC).filter(
      (channel) => !eventChannels.has(channel),
    );
    expect([...handlers.keys()].sort()).toEqual([...invokeChannels].sort());

    for (const handler of handlers.values()) {
      await expect(
        handler({ senderFrame: null, sender: { mainFrame: null } }),
      ).rejects.toThrow("desktop_ipc_sender_rejected");
    }
  });

  it("revalidates HTTPS URLs and notification text in Main", async () => {
    const { handlers, notify, openExternal } = fixture();
    const event = trustedEvent();

    await expect(
      handlers.get(DESKTOP_IPC.shellOpenExternal)?.(
        event,
        "https://example.test/docs",
      ),
    ).resolves.toEqual({ ok: true, value: null });
    expect(openExternal).toHaveBeenCalledWith("https://example.test/docs");

    const rejectedUrl = await handlers.get(DESKTOP_IPC.shellOpenExternal)?.(
      event,
      "file:///C:/Windows/System32/calc.exe",
    ) as RuntimeResultV1<null>;
    expect(rejectedUrl.ok).toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);

    await expect(
      handlers.get(DESKTOP_IPC.shellNotify)?.(event, {
        title: "Codex Collab",
        body: "有新消息。",
      }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(notify).toHaveBeenCalledWith({
      title: "Codex Collab",
      body: "有新消息。",
    });

    const rejectedNotification = await handlers.get(DESKTOP_IPC.shellNotify)?.(
      event,
      { title: "Codex Collab", body: "secret\nspoof" },
    ) as RuntimeResultV1<null>;
    expect(rejectedNotification.ok).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
