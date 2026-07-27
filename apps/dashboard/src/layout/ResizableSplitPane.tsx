import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
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
import "./resizable-split-pane.css";

export interface ResizableSplitPaneHandle {
  getPrimarySize(): number;
  reset(): void;
  setPrimarySize(size: number): void;
}

export interface ResizableSplitPaneProps {
  primary: ReactNode;
  secondary: ReactNode;
  defaultPrimarySize: number;
  orientation?: SplitOrientation;
  minPrimarySize?: number;
  maxPrimarySize?: number;
  minSecondarySize?: number;
  separatorSize?: number;
  keyboardStep?: number;
  storageKey?: string;
  separatorLabel?: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  disabled?: boolean;
  className?: string;
  primaryClassName?: string;
  secondaryClassName?: string;
  style?: CSSProperties;
  onPrimarySizeChange?: (size: number) => void;
}

interface PointerResizeSession {
  pointerId: number;
  originCoordinate: number;
  originSize: number;
}

type SplitPaneStyle = CSSProperties & {
  "--split-primary-size": string;
  "--split-separator-size": string;
};

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

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
    <div
      ref={containerRef}
      className={classNames("resizable-split-pane", className)}
      data-orientation={orientation}
      style={splitStyle}
    >
      <div
        id={primaryId}
        className={classNames(
          "resizable-split-pane__pane",
          "resizable-split-pane__primary",
          primaryClassName,
        )}
        aria-label={primaryLabel}
      >
        {primary}
      </div>
      <div
        ref={separatorRef}
        className="resizable-split-pane__separator"
        role="separator"
        tabIndex={disabled ? -1 : 0}
        aria-label={separatorLabel}
        aria-controls={`${primaryId} ${secondaryId}`}
        aria-disabled={disabled || undefined}
        aria-orientation={orientation === "horizontal" ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(bounds.min)}
        aria-valuemax={Number.isFinite(bounds.max) ? Math.round(bounds.max) : undefined}
        aria-valuenow={Math.round(primarySize)}
        aria-valuetext={`${Math.round(primarySize)} 像素`}
        title="拖动调整大小，双击恢复默认"
        onDoubleClick={reset}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerResize}
        onPointerCancel={finishPointerResize}
      />
      <div
        id={secondaryId}
        className={classNames(
          "resizable-split-pane__pane",
          "resizable-split-pane__secondary",
          secondaryClassName,
        )}
        aria-label={secondaryLabel}
      >
        {secondary}
      </div>
    </div>
  );
});
