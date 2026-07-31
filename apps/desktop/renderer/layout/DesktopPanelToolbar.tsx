import { Button } from "@fluentui/react-components";
import {
  ArrowLeft16Regular,
  ArrowReset20Regular,
  ArrowRight16Regular,
  ReOrderDotsVertical20Regular,
} from "@fluentui/react-icons";
import type { PointerEventHandler } from "react";

interface DesktopPanelToolbarProps {
  canMoveLeft: boolean;
  canMoveRight: boolean;
  dragDisabled: boolean;
  label: string;
  onMoveLeft(): void;
  onMoveRight(): void;
  onPointerCancel: PointerEventHandler<HTMLButtonElement>;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
  onPointerMove: PointerEventHandler<HTMLButtonElement>;
  onPointerUp: PointerEventHandler<HTMLButtonElement>;
  onReset(): void;
  showReset: boolean;
}

export function DesktopPanelToolbar({
  canMoveLeft,
  canMoveRight,
  dragDisabled,
  label,
  onMoveLeft,
  onMoveRight,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onReset,
  showReset,
}: DesktopPanelToolbarProps) {
  const dragLabel = dragDisabled
    ? `窗口较窄，放大窗口后可拖动${label}`
    : `拖动移动${label}`;
  return (
    <div className="desktop-panel-toolbar" role="toolbar" aria-label={`${label}布局`}>
      <Button
        appearance="subtle"
        size="small"
        className="desktop-panel-drag-handle"
        icon={<ReOrderDotsVertical20Regular />}
        aria-label={dragLabel}
        title={dragLabel}
        disabled={dragDisabled}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <span className="desktop-panel-toolbar-label">{label}</span>
      <div className="desktop-panel-toolbar-actions">
        <Button
          appearance="subtle"
          size="small"
          icon={<ArrowLeft16Regular />}
          aria-label={`向左移动${label}`}
          title={`向左移动${label}`}
          disabled={dragDisabled || !canMoveLeft}
          onClick={onMoveLeft}
        />
        <Button
          appearance="subtle"
          size="small"
          icon={<ArrowRight16Regular />}
          aria-label={`向右移动${label}`}
          title={`向右移动${label}`}
          disabled={dragDisabled || !canMoveRight}
          onClick={onMoveRight}
        />
        {showReset ? (
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowReset20Regular />}
            aria-label="恢复默认面板布局"
            title="恢复默认面板布局"
            onClick={onReset}
          />
        ) : null}
      </div>
    </div>
  );
}
