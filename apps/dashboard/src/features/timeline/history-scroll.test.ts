import { describe, expect, it } from "vitest";
import {
  captureHistoryScrollAnchor,
  historyScrollIntent,
  restoreHistoryScrollAnchor,
} from "./history-scroll.js";

function rect(top: number, bottom = top + 20): DOMRect {
  return { top, bottom } as DOMRect;
}

describe("history scroll anchors", () => {
  it("loads older records only for a real upward scroll near the top", () => {
    const stream = { clientHeight: 500, scrollHeight: 1_500, scrollTop: 80 };
    expect(historyScrollIntent(stream, 160, true)).toEqual({
      pinned: false,
      loadOlder: true,
    });
    expect(historyScrollIntent(stream, 40, true).loadOlder).toBe(false);
  });

  it("does not auto-load older records while the short timeline is pinned", () => {
    expect(
      historyScrollIntent(
        { clientHeight: 600, scrollHeight: 600, scrollTop: 0 },
        0,
        true,
      ),
    ).toEqual({ pinned: true, loadOlder: false });
  });

  it("restores the same visible message after the surrounding layout reflows", () => {
    const anchor = {
      dataset: { historyAnchor: "message-42" },
      getBoundingClientRect: () => rect(120),
    } as unknown as HTMLElement;
    const stream = {
      scrollTop: 240,
      scrollHeight: 1_000,
      getBoundingClientRect: () => rect(100, 600),
      querySelectorAll: () => [anchor],
    } as unknown as HTMLElement;

    const captured = captureHistoryScrollAnchor(stream);
    expect(captured).toMatchObject({
      key: "message-42",
      offset: 20,
      scrollTop: 240,
    });

    anchor.getBoundingClientRect = () => rect(154);
    restoreHistoryScrollAnchor(stream, captured);
    expect(stream.scrollTop).toBe(274);
  });

  it("falls back to the captured scroll delta when an anchor is no longer rendered", () => {
    const stream = {
      scrollTop: 0,
      scrollHeight: 1_240,
      getBoundingClientRect: () => rect(100, 600),
      querySelectorAll: () => [],
    } as unknown as HTMLElement;

    restoreHistoryScrollAnchor(stream, {
      key: "removed-message",
      offset: 0,
      scrollHeight: 1_000,
      scrollTop: 200,
    });

    expect(stream.scrollTop).toBe(440);
  });
});
