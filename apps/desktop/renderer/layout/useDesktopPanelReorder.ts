import {
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  moveDesktopPanel,
  moveDesktopPanelByStep,
  type DesktopPanelId,
  type DesktopPanelLayoutV1,
  type DesktopPanelPlacement,
} from "./desktop-panel-arrangement.js";

interface ReorderControllerOptions {
  compact: boolean;
  commitLayout(next: DesktopPanelLayoutV1): void;
  containerRef: RefObject<HTMLDivElement | null>;
  labelFor(panelId: DesktopPanelId): string;
  layoutRef: MutableRefObject<DesktopPanelLayoutV1>;
  visibleOrder: DesktopPanelId[];
}

interface DragSession {
  panelId: DesktopPanelId;
  pointerId: number;
}

export function useDesktopPanelReorder({
  compact,
  commitLayout,
  containerRef,
  labelFor,
  layoutRef,
  visibleOrder,
}: ReorderControllerOptions) {
  const [dropTarget, setDropTarget] = useState<{
    panelId: DesktopPanelId;
    placement: DesktopPanelPlacement;
  } | null>(null);
  const dropTargetRef = useRef(dropTarget);
  const dragRef = useRef<DragSession | null>(null);

  const announceMove = (panelId: DesktopPanelId) =>
    `${labelFor(panelId)}已移动`;

  const moveByStep = (panelId: DesktopPanelId, direction: -1 | 1) => {
    commitLayout({
      ...layoutRef.current,
      order: moveDesktopPanelByStep(
        layoutRef.current.order,
        visibleOrder,
        panelId,
        direction,
      ),
    });
    return announceMove(panelId);
  };

  const startDrag = (
    panelId: DesktopPanelId,
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    if (compact || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { panelId, pointerId: event.pointerId };
    containerRef.current?.setAttribute("data-dragging", panelId);
  };

  const updateDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-desktop-panel-id]");
    const targetId = target?.dataset.desktopPanelId as DesktopPanelId | undefined;
    let nextTarget: typeof dropTarget = null;
    if (target && targetId && targetId !== session.panelId && visibleOrder.includes(targetId)) {
      const bounds = target.getBoundingClientRect();
      nextTarget = {
        panelId: targetId,
        placement: event.clientX < bounds.left + bounds.width / 2
          ? "before"
          : "after",
      };
    }
    dropTargetRef.current = nextTarget;
    setDropTarget(nextTarget);
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>): string | null => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (dropTargetRef.current) {
      commitLayout({
        ...layoutRef.current,
        order: moveDesktopPanel(
          layoutRef.current.order,
          session.panelId,
          dropTargetRef.current.panelId,
          dropTargetRef.current.placement,
        ),
      });
    }
    const announcement = dropTargetRef.current
      ? announceMove(session.panelId)
      : null;
    dragRef.current = null;
    dropTargetRef.current = null;
    setDropTarget(null);
    containerRef.current?.removeAttribute("data-dragging");
    return announcement;
  };

  return { dropTarget, finishDrag, moveByStep, startDrag, updateDrag };
}
