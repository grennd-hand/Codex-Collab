import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  defaultDesktopPanelLayout,
  fitDesktopPanelWidths,
  maximumDesktopPanelWidth,
  minimumDesktopPanelWidth,
  persistDesktopPanelLayout,
  readDesktopPanelLayout,
  resizeDesktopPanelPair,
  type DesktopPanelId,
  type DesktopPanelLayoutV1,
  type DesktopPanelWidths,
} from "./desktop-panel-arrangement.js";
import { DesktopPanelSeparator } from "./DesktopPanelSeparator.js";
import { DesktopPanelToolbar } from "./DesktopPanelToolbar.js";
import { useDesktopPanelReorder } from "./useDesktopPanelReorder.js";

const COMPACT_WIDTH = 1_180;
const SEPARATOR_SIZE = 12;

export interface DesktopPanelDefinition {
  content: ReactNode;
  label: string;
}

interface DesktopPanelStripProps {
  editorExpanded: boolean;
  panels: Partial<Record<DesktopPanelId, DesktopPanelDefinition>>;
  storageKey: string;
}

interface ResizeSession {
  leftId: DesktopPanelId;
  originWidths: DesktopPanelWidths;
  originX: number;
  pointerId: number;
  rightId: DesktopPanelId;
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function DesktopPanelStrip({
  editorExpanded,
  panels,
  storageKey,
}: DesktopPanelStripProps) {
  const storage = localStorageOrNull();
  const [layout, setLayout] = useState(() =>
    readDesktopPanelLayout(storage, storageKey, editorExpanded),
  );
  const [compact, setCompact] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef(new Map<DesktopPanelId, HTMLElement>());
  const layoutRef = useRef(layout);
  const visualWidthsRef = useRef(layout.widths);
  const resizeRef = useRef<ResizeSession | null>(null);

  const visibleOrder = useMemo(
    () => layout.order.filter((panelId) => Boolean(panels[panelId])),
    [layout.order, panels],
  );
  const flowOrder = useMemo(
    () => compact ? visibleOrder.filter((panelId) => panelId !== "sidebar") : visibleOrder,
    [compact, visibleOrder],
  );

  const applyWidths = useCallback((preferred: DesktopPanelWidths) => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const available = containerWidth - Math.max(0, flowOrder.length - 1) * SEPARATOR_SIZE;
    const fitted = fitDesktopPanelWidths(
      flowOrder,
      preferred,
      available,
      editorExpanded,
    );
    for (const panelId of flowOrder) {
      slotRefs.current.get(panelId)?.style.setProperty(
        "--desktop-panel-width",
        `${fitted[panelId]}px`,
      );
    }
    visualWidthsRef.current = fitted;
  }, [editorExpanded, flowOrder]);

  const commitLayout = useCallback((next: DesktopPanelLayoutV1) => {
    layoutRef.current = next;
    setLayout(next);
    persistDesktopPanelLayout(storage, storageKey, next);
  }, [storage, storageKey]);

  useEffect(() => {
    const next = readDesktopPanelLayout(storage, storageKey, editorExpanded);
    layoutRef.current = next;
    visualWidthsRef.current = next.widths;
    setLayout(next);
  }, [editorExpanded, storage, storageKey]);

  useLayoutEffect(() => applyWidths(layout.widths), [applyWidths, layout.widths]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const nextCompact = entry.contentRect.width < COMPACT_WIDTH;
      setCompact((current) => current === nextCompact ? current : nextCompact);
      if (nextCompact === compact) applyWidths(layoutRef.current.widths);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyWidths, compact]);

  const reorder = useDesktopPanelReorder({
    compact,
    commitLayout,
    containerRef,
    labelFor: (panelId) => panels[panelId]?.label ?? panelId,
    layoutRef,
    visibleOrder,
  });

  const resetLayout = () => {
    const next = defaultDesktopPanelLayout(editorExpanded);
    commitLayout(next);
    setAnnouncement("已恢复默认面板布局");
  };

  const beginResize = (
    leftId: DesktopPanelId,
    rightId: DesktopPanelId,
    event: PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.resizing = "true";
    resizeRef.current = {
      leftId,
      rightId,
      originX: event.clientX,
      originWidths: visualWidthsRef.current,
      pointerId: event.pointerId,
    };
  };

  const updateResize = (event: PointerEvent<HTMLDivElement>) => {
    const session = resizeRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const widths = resizeDesktopPanelPair(
      session.originWidths,
      session.leftId,
      session.rightId,
      event.clientX - session.originX,
      editorExpanded,
    );
    applyWidths(widths);
    event.currentTarget.setAttribute(
      "aria-valuenow",
      String(Math.round(widths[session.leftId])),
    );
    event.currentTarget.setAttribute(
      "aria-valuetext",
      `${Math.round(widths[session.leftId])} 像素`,
    );
  };

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    const session = resizeRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.currentTarget.removeAttribute("data-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeRef.current = null;
    commitLayout({ ...layoutRef.current, widths: visualWidthsRef.current });
  };

  const resizeByKeyboard = (
    leftId: DesktopPanelId,
    rightId: DesktopPanelId,
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const delta = direction * (event.shiftKey ? 64 : 16);
    const widths = resizeDesktopPanelPair(
      visualWidthsRef.current,
      leftId,
      rightId,
      delta,
      editorExpanded,
    );
    applyWidths(widths);
    commitLayout({ ...layoutRef.current, widths });
  };

  return (
    <div ref={containerRef} className="desktop-panel-strip" data-compact={compact}>
      {visibleOrder.map((panelId, index) => {
        const panel = panels[panelId];
        if (!panel) return null;
        const flowIndex = flowOrder.indexOf(panelId);
        const nextId = flowOrder[flowIndex + 1];
        return (
          <div key={panelId} className="desktop-panel-fragment">
            <section
              ref={(node) => {
                if (node) slotRefs.current.set(panelId, node);
                else slotRefs.current.delete(panelId);
              }}
              id={`desktop-panel-${panelId}`}
              className="desktop-panel-slot"
              data-desktop-panel-id={panelId}
              data-drop-position={
                reorder.dropTarget?.panelId === panelId
                  ? reorder.dropTarget.placement
                  : undefined
              }
              style={{ "--desktop-panel-width": `${layout.widths[panelId]}px` } as CSSProperties}
            >
              <DesktopPanelToolbar
                label={panel.label}
                dragDisabled={compact}
                canMoveLeft={index > 0}
                canMoveRight={index < visibleOrder.length - 1}
                showReset={index === visibleOrder.length - 1}
                onMoveLeft={() => setAnnouncement(reorder.moveByStep(panelId, -1))}
                onMoveRight={() => setAnnouncement(reorder.moveByStep(panelId, 1))}
                onReset={resetLayout}
                onPointerDown={(event) => reorder.startDrag(panelId, event)}
                onPointerMove={reorder.updateDrag}
                onPointerUp={(event) => {
                  const message = reorder.finishDrag(event);
                  if (message) setAnnouncement(message);
                }}
                onPointerCancel={(event) => {
                  const message = reorder.finishDrag(event);
                  if (message) setAnnouncement(message);
                }}
              />
              <div className="desktop-panel-content">{panel.content}</div>
            </section>
            {nextId ? (
              <DesktopPanelSeparator
                controls={`desktop-panel-${panelId} desktop-panel-${nextId}`}
                leftLabel={panel.label}
                leftWidth={visualWidthsRef.current[panelId]}
                minimum={minimumDesktopPanelWidth(panelId, editorExpanded)}
                maximum={maximumDesktopPanelWidth(panelId)}
                onPointerDown={(event) => beginResize(panelId, nextId, event)}
                onPointerMove={updateResize}
                onPointerUp={finishResize}
                onPointerCancel={finishResize}
                onKeyDown={(event) => resizeByKeyboard(panelId, nextId, event)}
                onDoubleClick={() => {
                  const widths = defaultDesktopPanelLayout(editorExpanded).widths;
                  applyWidths(widths);
                  commitLayout({ ...layoutRef.current, widths });
                }}
              />
            ) : null}
          </div>
        );
      })}
      <span className="desktop-panel-live-region" aria-live="polite">{announcement}</span>
    </div>
  );
}
