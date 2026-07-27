export interface HistoryScrollAnchor {
  key: string;
  offset: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface PendingHistoryScrollRestore {
  sessionId: string;
  threadId: string;
  historyEpoch: number;
  requestId: number;
  anchor: HistoryScrollAnchor | null;
}

export interface HistoryScrollIntent {
  pinned: boolean;
  loadOlder: boolean;
}

export function historyScrollIntent(
  stream: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  previousScrollTop: number,
  canLoadOlder: boolean,
): HistoryScrollIntent {
  const distanceFromBottom = Math.max(
    0,
    stream.scrollHeight - stream.scrollTop - stream.clientHeight,
  );
  const pinned = distanceFromBottom < 96;
  return {
    pinned,
    loadOlder:
      canLoadOlder &&
      !pinned &&
      stream.scrollTop < 120 &&
      (stream.scrollTop + 1 < previousScrollTop || stream.scrollTop === 0),
  };
}

export function captureHistoryScrollAnchor(
  stream: HTMLElement | null,
): HistoryScrollAnchor | null {
  if (!stream) return null;
  const streamTop = stream.getBoundingClientRect().top;
  const anchor = Array.from(
    stream.querySelectorAll<HTMLElement>("[data-history-anchor]"),
  ).find((element) => element.getBoundingClientRect().bottom > streamTop + 1);
  const key = anchor?.dataset.historyAnchor;
  return anchor && key
    ? {
        key,
        offset: anchor.getBoundingClientRect().top - streamTop,
        scrollHeight: stream.scrollHeight,
        scrollTop: stream.scrollTop,
      }
    : null;
}

export function restoreHistoryScrollAnchor(
  stream: HTMLElement | null,
  anchor: HistoryScrollAnchor | null,
): void {
  if (!stream || !anchor) return;
  const matching = Array.from(
    stream.querySelectorAll<HTMLElement>("[data-history-anchor]"),
  ).find((element) => element.dataset.historyAnchor === anchor.key);
  if (matching) {
    const currentOffset =
      matching.getBoundingClientRect().top - stream.getBoundingClientRect().top;
    stream.scrollTop += currentOffset - anchor.offset;
    return;
  }
  stream.scrollTop =
    anchor.scrollTop + Math.max(0, stream.scrollHeight - anchor.scrollHeight);
}
