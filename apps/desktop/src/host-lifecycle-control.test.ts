import { describe, expect, it, vi } from "vitest";
import { DesktopHostLifecycleControl } from "./host-lifecycle-control.js";

const activeStatus = {
  phase: "active" as const,
  paired: true,
  acceptingWork: true,
  since: "2026-07-28T00:00:00.000Z",
};

describe("DesktopHostLifecycleControl", () => {
  it("shares one client for startup, status, polling, and graceful stop", async () => {
    vi.useFakeTimers();
    const client = {
      status: vi.fn(async () => activeStatus),
      gracefulStop: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    const ensureClient = vi.fn(async () => client);
    const control = new DesktopHostLifecycleControl(ensureClient, 10);
    const listener = vi.fn();
    control.onStatus(listener);

    await control.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(ensureClient).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ version: 1, ...activeStatus });

    await control.drainAndStop();
    expect(client.gracefulStop).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("clears a rejected connect so a later request can retry connect-first", async () => {
    const error = Object.assign(new Error("restart"), {
      code: "host_restart_required",
    });
    const ensureClient = vi.fn(async () => Promise.reject(error));
    const control = new DesktopHostLifecycleControl(ensureClient);

    await expect(control.start()).rejects.toBe(error);
    await expect(control.getStatus()).rejects.toBe(error);
    expect(ensureClient).toHaveBeenCalledTimes(2);
  });

  it("reconnects after a connected transport rejects status", async () => {
    vi.useFakeTimers();
    const first = {
      status: vi.fn(async () => Promise.reject(new Error("pipe closed"))),
      gracefulStop: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    const second = {
      status: vi.fn(async () => activeStatus),
      gracefulStop: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    const ensureClient = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const control = new DesktopHostLifecycleControl(ensureClient, 10);
    const listener = vi.fn();
    control.onStatus(listener);

    await expect(control.start()).rejects.toThrow("pipe closed");
    await vi.advanceTimersByTimeAsync(10);
    expect(first.close).toHaveBeenCalledOnce();
    expect(ensureClient).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith({ version: 1, ...activeStatus });
    await control.drainAndStop();
    vi.useRealTimers();
  });

  it("does not start or connect a Host only to stop it", async () => {
    const ensureClient = vi.fn();
    const control = new DesktopHostLifecycleControl(ensureClient);

    await control.drainAndStop();
    expect(ensureClient).not.toHaveBeenCalled();
  });
});
