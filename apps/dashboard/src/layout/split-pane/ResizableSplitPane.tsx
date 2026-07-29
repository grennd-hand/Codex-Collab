import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  clampSplitSize,
  getKeyboardSplitSize,
  getPointerSplitSize,
  getSplitSizeBounds,
  readStoredSplitSize,
  storeSplitSize,
  type SplitOrientation,
  type SplitSizeBounds,
} from "./split-size.js";
import {
  getLocalStorage,
  type PointerResizeSession,
  type ResizableSplitPaneHandle,
  type ResizableSplitPaneProps,
  type SplitPaneStyle,
} from "./resizable-split-pane-types.js";
import { ResizableSplitPaneView } from "./ResizableSplitPaneView.js";
import "./resizable-split-pane.css";

export type { ResizableSplitPaneHandle, ResizableSplitPaneProps } from "./resizable-split-pane-types.js";

export const ResizableSplitPane = forwardRef<
  ResizableSplitPaneHandle,
  ResizableSplitPaneProps
>(function ResizableSplitPane(
  {
    primary,
    secondary,
    defaultPrimarySize,
    orientation = "horizontal",
    minPrimarySize = 160,
    maxPrimarySize = Number.POSITIVE_INFINITY,
    minSecondarySize = 160,
    separatorSize = 8,
    keyboardStep = 16,
    storageKey,
    separatorLabel = "调整面板大小",
    primaryLabel,
    secondaryLabel,
    disabled = false,
    className,
    primaryClassName,
    secondaryClassName,
    style,
    onPrimarySizeChange,
  },
  forwardedRef,
) {
  const initialBounds = getSplitSizeBounds({
    separatorSize,
    minPrimarySize,
    maxPrimarySize,
    minSecondarySize,
  });
  const initialSize = clampSplitSize(defaultPrimarySize, initialBounds);
  const [primarySize, setPrimarySize] = useState(initialSize);
  const primarySizeRef = useRef(initialSize);
  const containerRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const pointerSessionRef = useRef<PointerResizeSession | null>(null);
  const generatedId = useId().replace(/:/g, "");
  const primaryId = `split-primary-${generatedId}`;
  const secondaryId = `split-secondary-${generatedId}`;

  const getBounds = useCallback((): SplitSizeBounds => {
    const container = containerRef.current;
    const containerSize = container
      ? orientation === "horizontal"
        ? container.getBoundingClientRect().width
        : container.getBoundingClientRect().height
      : undefined;
    return getSplitSizeBounds({
      containerSize,
      separatorSize,
      minPrimarySize,
      maxPrimarySize,
      minSecondarySize,
    });
  }, [
    maxPrimarySize,
    minPrimarySize,
    minSecondarySize,
    orientation,
    separatorSize,
  ]);

  const applyVisualSize = useCallback(
    (size: number, bounds?: SplitSizeBounds) => {
      primarySizeRef.current = size;
      containerRef.current?.style.setProperty(
        "--split-primary-size",
        `${size}px`,
      );
      const separator = separatorRef.current;
      separator?.setAttribute("aria-valuenow", String(Math.round(size)));
      separator?.setAttribute("aria-valuetext", `${Math.round(size)} 像素`);
      if (bounds) {
        separator?.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
        if (Number.isFinite(bounds.max)) {
          separator?.setAttribute(
            "aria-valuemax",
            String(Math.round(bounds.max)),
          );
        } else {
          separator?.removeAttribute("aria-valuemax");
        }
      }
    },
    [],
  );

  const persistSize = useCallback(
    (size: number) => {
      if (!storageKey) return;
      const storage = getLocalStorage();
      if (storage) storeSplitSize(storage, storageKey, size);
    },
    [storageKey],
  );

  const commitSize = useCallback(
    (requestedSize: number) => {
      const bounds = getBounds();
      const nextSize = clampSplitSize(requestedSize, bounds);
      applyVisualSize(nextSize, bounds);
      setPrimarySize(nextSize);
      persistSize(nextSize);
      onPrimarySizeChange?.(nextSize);
      return nextSize;
    },
    [applyVisualSize, getBounds, onPrimarySizeChange, persistSize],
  );

  const reset = useCallback(() => {
    commitSize(defaultPrimarySize);
    separatorRef.current?.focus();
  }, [commitSize, defaultPrimarySize]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      getPrimarySize: () => primarySizeRef.current,
      reset,
      setPrimarySize: commitSize,
    }),
    [commitSize, reset],
  );

  useEffect(() => {
    const bounds = getBounds();
    const storage = storageKey ? getLocalStorage() : null;
    const storedSize =
      storage && storageKey
        ? readStoredSplitSize(storage, storageKey, bounds)
        : null;
    const nextSize = clampSplitSize(
      storedSize ?? primarySizeRef.current,
      bounds,
    );
    applyVisualSize(nextSize, bounds);
    setPrimarySize(nextSize);
  }, [applyVisualSize, getBounds, storageKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const bounds = getBounds();
      const previousSize = primarySizeRef.current;
      const nextSize = clampSplitSize(previousSize, bounds);
      applyVisualSize(nextSize, bounds);
      if (nextSize !== previousSize) {
        setPrimarySize(nextSize);
        onPrimarySizeChange?.(nextSize);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [applyVisualSize, getBounds, onPrimarySizeChange]);

  const finishPointerResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const session = pointerSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;

      pointerSessionRef.current = null;
      const separator = event.currentTarget;
      if (separator.hasPointerCapture(event.pointerId)) {
        separator.releasePointerCapture(event.pointerId);
      }
      delete containerRef.current?.dataset.resizing;
      delete separator.dataset.resizing;
      commitSize(primarySizeRef.current);
    },
    [commitSize],
  );

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.resizing = "true";
    if (containerRef.current) containerRef.current.dataset.resizing = "true";
    pointerSessionRef.current = {
      pointerId: event.pointerId,
      originCoordinate:
        orientation === "horizontal" ? event.clientX : event.clientY,
      originSize: primarySizeRef.current,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    const coordinate =
      orientation === "horizontal" ? event.clientX : event.clientY;
    const bounds = getBounds();
    const nextSize = clampSplitSize(
      getPointerSplitSize(
        session.originSize,
        session.originCoordinate,
        coordinate,
      ),
      bounds,
    );
    applyVisualSize(nextSize, bounds);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const bounds = getBounds();
    const step = keyboardStep * (event.shiftKey ? 4 : 1);
    const nextSize = getKeyboardSplitSize(
      event.key,
      orientation,
      primarySizeRef.current,
      bounds,
      step,
    );
    if (nextSize === null) return;
    event.preventDefault();
    commitSize(nextSize);
  };

  const bounds = getSplitSizeBounds({
    separatorSize,
    minPrimarySize,
    maxPrimarySize,
    minSecondarySize,
  });
  const splitStyle: SplitPaneStyle = {
    ...style,
    "--split-primary-size": `${primarySize}px`,
    "--split-separator-size": `${Math.max(1, separatorSize)}px`,
  };

  return (
    <ResizableSplitPaneView
      bounds={bounds}
      className={className}
      containerRef={containerRef}
      disabled={disabled}
      onDoubleClick={reset}
      onKeyDown={handleKeyDown}
      onPointerCancel={finishPointerResize}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerResize}
      orientation={orientation}
      primary={primary}
      primaryClassName={primaryClassName}
      primaryId={primaryId}
      primaryLabel={primaryLabel}
      primarySize={primarySize}
      secondary={secondary}
      secondaryClassName={secondaryClassName}
      secondaryId={secondaryId}
      secondaryLabel={secondaryLabel}
      separatorLabel={separatorLabel}
      separatorRef={separatorRef}
      splitStyle={splitStyle}
    />
  );
});
