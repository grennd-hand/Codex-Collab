export const DESKTOP_PANEL_IDS = ["sidebar", "files", "codex"] as const;

export type DesktopPanelId = (typeof DESKTOP_PANEL_IDS)[number];
export type DesktopPanelPlacement = "before" | "after";
export type DesktopPanelWidths = Record<DesktopPanelId, number>;

export interface DesktopPanelLayoutV1 {
  version: 1;
  order: DesktopPanelId[];
  widths: DesktopPanelWidths;
}

const DEFAULT_ORDER: DesktopPanelId[] = ["sidebar", "files", "codex"];

export function desktopPanelStorageKey(taskScope: string): string {
  return `codex-collab:desktop:panel-layout:v1:${taskScope}`;
}

export function minimumDesktopPanelWidth(
  panelId: DesktopPanelId,
  editorExpanded: boolean,
): number {
  if (panelId === "sidebar") return 248;
  if (panelId === "files") return editorExpanded ? 520 : 260;
  return 360;
}

export function maximumDesktopPanelWidth(panelId: DesktopPanelId): number {
  if (panelId === "sidebar") return 420;
  if (panelId === "files") return 1_120;
  return Number.POSITIVE_INFINITY;
}

export function defaultDesktopPanelLayout(
  editorExpanded: boolean,
): DesktopPanelLayoutV1 {
  return {
    version: 1,
    order: [...DEFAULT_ORDER],
    widths: {
      sidebar: 300,
      files: editorExpanded ? 760 : 360,
      codex: 720,
    },
  };
}

function isPanelId(value: unknown): value is DesktopPanelId {
  return DESKTOP_PANEL_IDS.includes(value as DesktopPanelId);
}

export function normalizeDesktopPanelOrder(value: unknown): DesktopPanelId[] {
  const normalized: DesktopPanelId[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isPanelId(item) && !normalized.includes(item)) normalized.push(item);
    }
  }
  for (const panelId of DEFAULT_ORDER) {
    if (!normalized.includes(panelId)) normalized.push(panelId);
  }
  return normalized;
}

function normalizedWidth(
  value: unknown,
  panelId: DesktopPanelId,
  editorExpanded: boolean,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(
    maximumDesktopPanelWidth(panelId),
    Math.max(minimumDesktopPanelWidth(panelId, editorExpanded), value),
  );
}

export function parseDesktopPanelLayout(
  rawValue: string | null,
  editorExpanded: boolean,
): DesktopPanelLayoutV1 {
  const fallback = defaultDesktopPanelLayout(editorExpanded);
  if (!rawValue) return fallback;
  try {
    const value = JSON.parse(rawValue) as {
      version?: unknown;
      order?: unknown;
      widths?: Partial<Record<DesktopPanelId, unknown>>;
    };
    if (value.version !== 1 || !value.widths) return fallback;
    return {
      version: 1,
      order: normalizeDesktopPanelOrder(value.order),
      widths: {
        sidebar: normalizedWidth(
          value.widths.sidebar,
          "sidebar",
          editorExpanded,
          fallback.widths.sidebar,
        ),
        files: normalizedWidth(
          value.widths.files,
          "files",
          editorExpanded,
          fallback.widths.files,
        ),
        codex: normalizedWidth(
          value.widths.codex,
          "codex",
          editorExpanded,
          fallback.widths.codex,
        ),
      },
    };
  } catch {
    return fallback;
  }
}

export function readDesktopPanelLayout(
  storage: Pick<Storage, "getItem"> | null,
  key: string,
  editorExpanded: boolean,
): DesktopPanelLayoutV1 {
  try {
    return parseDesktopPanelLayout(storage?.getItem(key) ?? null, editorExpanded);
  } catch {
    return defaultDesktopPanelLayout(editorExpanded);
  }
}

export function persistDesktopPanelLayout(
  storage: Pick<Storage, "setItem"> | null,
  key: string,
  layout: DesktopPanelLayoutV1,
): void {
  try {
    storage?.setItem(key, JSON.stringify(layout));
  } catch {
    // Layout preferences are optional when local storage is unavailable.
  }
}

export function moveDesktopPanel(
  order: readonly DesktopPanelId[],
  panelId: DesktopPanelId,
  targetId: DesktopPanelId,
  placement: DesktopPanelPlacement,
): DesktopPanelId[] {
  if (panelId === targetId || !order.includes(panelId) || !order.includes(targetId)) {
    return [...order];
  }
  const next = order.filter((candidate) => candidate !== panelId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, panelId);
  return next;
}

export function moveDesktopPanelByStep(
  order: readonly DesktopPanelId[],
  visibleOrder: readonly DesktopPanelId[],
  panelId: DesktopPanelId,
  direction: -1 | 1,
): DesktopPanelId[] {
  const currentIndex = visibleOrder.indexOf(panelId);
  const targetId = visibleOrder[currentIndex + direction];
  if (currentIndex < 0 || !targetId) return [...order];
  return moveDesktopPanel(
    order,
    panelId,
    targetId,
    direction < 0 ? "before" : "after",
  );
}

export function fitDesktopPanelWidths(
  order: readonly DesktopPanelId[],
  preferred: DesktopPanelWidths,
  availableSize: number,
  editorExpanded: boolean,
): DesktopPanelWidths {
  const result = { ...preferred };
  for (const panelId of order) {
    result[panelId] = normalizedWidth(
      preferred[panelId],
      panelId,
      editorExpanded,
      minimumDesktopPanelWidth(panelId, editorExpanded),
    );
  }
  let remaining = Math.max(0, availableSize) -
    order.reduce((total, panelId) => total + result[panelId], 0);
  if (remaining > 0) {
    const growPanel = order.includes("codex") ? "codex" : order.at(-1);
    if (growPanel) result[growPanel] += remaining;
    return result;
  }
  for (const panelId of [...order].reverse()) {
    if (remaining >= 0) break;
    const minimum = minimumDesktopPanelWidth(panelId, editorExpanded);
    const shrink = Math.min(result[panelId] - minimum, -remaining);
    result[panelId] -= shrink;
    remaining += shrink;
  }
  return result;
}

export function resizeDesktopPanelPair(
  widths: DesktopPanelWidths,
  leftId: DesktopPanelId,
  rightId: DesktopPanelId,
  requestedDelta: number,
  editorExpanded: boolean,
): DesktopPanelWidths {
  const minimumDelta = Math.max(
    minimumDesktopPanelWidth(leftId, editorExpanded) - widths[leftId],
    widths[rightId] - maximumDesktopPanelWidth(rightId),
  );
  const maximumDelta = Math.min(
    widths[rightId] - minimumDesktopPanelWidth(rightId, editorExpanded),
    maximumDesktopPanelWidth(leftId) - widths[leftId],
  );
  const delta = Math.min(maximumDelta, Math.max(minimumDelta, requestedDelta));
  return {
    ...widths,
    [leftId]: widths[leftId] + delta,
    [rightId]: widths[rightId] - delta,
  };
}
