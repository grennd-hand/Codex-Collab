export const REALTIME_HISTORY_REFRESH_INTERVAL_MS = 750;

export function shouldRefreshRealtimeHistory(
  lastRequestedAt: number,
  now: number,
): boolean {
  return now - lastRequestedAt >= REALTIME_HISTORY_REFRESH_INTERVAL_MS;
}

export function realtimeHistoryRefreshDelay(
  lastRequestedAt: number,
  now: number,
): number {
  return Math.max(
    0,
    REALTIME_HISTORY_REFRESH_INTERVAL_MS - (now - lastRequestedAt),
  );
}
