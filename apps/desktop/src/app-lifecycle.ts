import type { App } from "electron";
import type { EncryptedCredentialStore } from "./credential-store.js";
import type { HostLifecycleControl } from "./host-lifecycle-control.js";
import type { DesktopRealtimeManager } from "./realtime-manager.js";

const SHUTDOWN_DEADLINE_MS = 8_000;

async function withDeadline(task: Promise<unknown>, milliseconds: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      task,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("desktop_shutdown_timeout")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class DesktopQuitCoordinator {
  private quitPromise: Promise<void> | null = null;
  private quitting = false;

  constructor(
    private readonly electronApp: App,
    private readonly realtime: DesktopRealtimeManager,
    private readonly credentials: EncryptedCredentialStore,
    private readonly host: HostLifecycleControl,
  ) {}

  get isQuitting(): boolean {
    return this.quitting;
  }

  requestQuit(): Promise<void> {
    if (this.quitPromise) return this.quitPromise;
    this.quitting = true;
    this.quitPromise = (async () => {
      const results = await Promise.allSettled([
        withDeadline(this.realtime.closeAll(), SHUTDOWN_DEADLINE_MS),
        withDeadline(this.credentials.flush(), SHUTDOWN_DEADLINE_MS),
        withDeadline(this.host.drainAndStop(), SHUTDOWN_DEADLINE_MS),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Desktop shutdown step failed.");
        }
      }
      this.electronApp.quit();
    })();
    return this.quitPromise;
  }
}
