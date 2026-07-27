import type {
  KeyboardEventHandler,
  PointerEventHandler,
  RefObject,
} from "react";
import type { SplitOrientation, SplitSizeBounds } from "./split-size.js";
import {
  classNames,
  type ResizableSplitPaneProps,
  type SplitPaneStyle,
} from "./resizable-split-pane-types.js";

type ResizableSplitPaneViewProps = Pick<
  ResizableSplitPaneProps,
  | "className"
  | "disabled"
  | "primary"
  | "primaryClassName"
  | "primaryLabel"
  | "secondary"
  | "secondaryClassName"
  | "secondaryLabel"
  | "separatorLabel"
> & {
  bounds: SplitSizeBounds;
  containerRef: RefObject<HTMLDivElement | null>;
  onDoubleClick: () => void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  orientation: SplitOrientation;
  primaryId: string;
  primarySize: number;
  secondaryId: string;
  separatorRef: RefObject<HTMLDivElement | null>;
  splitStyle: SplitPaneStyle;
};

export function ResizableSplitPaneView({
  bounds,
  className,
  containerRef,
  disabled,
  onDoubleClick,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  orientation,
  primary,
  primaryClassName,
  primaryId,
  primaryLabel,
  primarySize,
  secondary,
  secondaryClassName,
  secondaryId,
  secondaryLabel,
  separatorLabel,
  separatorRef,
  splitStyle,
}: ResizableSplitPaneViewProps) {
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
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
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
}
