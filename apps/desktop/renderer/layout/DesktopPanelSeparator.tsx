import type {
  KeyboardEventHandler,
  PointerEventHandler,
} from "react";

interface DesktopPanelSeparatorProps {
  controls: string;
  leftLabel: string;
  leftWidth: number;
  maximum: number;
  minimum: number;
  onDoubleClick(): void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
}

export function DesktopPanelSeparator({
  controls,
  leftLabel,
  leftWidth,
  maximum,
  minimum,
  onDoubleClick,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: DesktopPanelSeparatorProps) {
  return (
    <div
      className="desktop-panel-separator"
      role="separator"
      tabIndex={0}
      aria-label={`调整${leftLabel}宽度`}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={Math.round(minimum)}
      aria-valuemax={Number.isFinite(maximum) ? Math.round(maximum) : undefined}
      aria-valuenow={Math.round(leftWidth)}
      aria-valuetext={`${Math.round(leftWidth)} 像素`}
      title="拖动调整大小，双击恢复默认"
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}
