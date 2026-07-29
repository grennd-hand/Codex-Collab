import { describe, expect, it } from "vitest";
import {
  REALTIME_HISTORY_REFRESH_INTERVAL_MS,
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
});
