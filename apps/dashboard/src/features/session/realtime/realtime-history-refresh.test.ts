import { describe, expect, it } from "vitest";
import {
  REALTIME_HISTORY_REFRESH_INTERVAL_MS,
  realtimeHistoryRefreshDelay,
  shouldRefreshRealtimeHistory,
} from "./realtime-history-refresh.js";

describe("realtime history refresh", () => {
  it("follows the host polling cadence without starting duplicate sub-second loads", () => {
    const requestedAt = 10_000;

    expect(
      shouldRefreshRealtimeHistory(
        requestedAt,
        requestedAt + REALTIME_HISTORY_REFRESH_INTERVAL_MS - 1,
      ),
    ).toBe(false);
    expect(
      shouldRefreshRealtimeHistory(
        requestedAt,
        requestedAt + REALTIME_HISTORY_REFRESH_INTERVAL_MS,
      ),
    ).toBe(true);
  });

  it("retains the trailing history refresh instead of dropping the last update", () => {
    const requestedAt = 10_000;

    expect(
      realtimeHistoryRefreshDelay(
        requestedAt,
        requestedAt + REALTIME_HISTORY_REFRESH_INTERVAL_MS - 150,
      ),
    ).toBe(150);
    expect(
      realtimeHistoryRefreshDelay(
        requestedAt,
        requestedAt + REALTIME_HISTORY_REFRESH_INTERVAL_MS,
      ),
    ).toBe(0);
  });
});
