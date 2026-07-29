import { describe, expect, it, vi } from "vitest";
import { DesktopQuitCoordinator } from "./app-lifecycle.js";

describe("desktop quit lifecycle", () => {
  it("drains realtime, credentials and Host exactly once", async () => {
    const quit = vi.fn();
    const closeAll = vi.fn(async () => undefined);
    const flush = vi.fn(async () => undefined);
    const drainAndStop = vi.fn(async () => undefined);
    const coordinator = new DesktopQuitCoordinator(
      { quit } as never,
      { closeAll } as never,
      { flush } as never,
      { drainAndStop },
    );

    expect(coordinator.isQuitting).toBe(false);
    await Promise.all([coordinator.requestQuit(), coordinator.requestQuit()]);
    expect(coordinator.isQuitting).toBe(true);
    expect(closeAll).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(drainAndStop).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });
});
