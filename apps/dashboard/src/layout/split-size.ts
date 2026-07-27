export type SplitOrientation = "horizontal" | "vertical";

export interface SplitSizeBounds {
  min: number;
  max: number;
}

export interface SplitConstraintOptions {
  containerSize?: number;
  separatorSize?: number;
  minPrimarySize?: number;
  maxPrimarySize?: number;
  minSecondarySize?: number;
}

export interface SplitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, value ?? fallback) : fallback;
}

export function getSplitSizeBounds({
  containerSize,
  separatorSize = 8,
  minPrimarySize = 0,
  maxPrimarySize = Number.POSITIVE_INFINITY,
  minSecondarySize = 0,
}: SplitConstraintOptions): SplitSizeBounds {
  const configuredMin = nonNegative(minPrimarySize, 0);
  const configuredMax = nonNegative(maxPrimarySize, Number.POSITIVE_INFINITY);
  let effectiveMax = Math.max(configuredMin, configuredMax);

  if (Number.isFinite(containerSize) && (containerSize ?? 0) > 0) {
    const availablePrimarySize = Math.max(
      0,
      (containerSize ?? 0) -
        nonNegative(separatorSize, 0) -
        nonNegative(minSecondarySize, 0),
    );
    effectiveMax = Math.min(effectiveMax, availablePrimarySize);
  }

  const effectiveMin = Math.min(configuredMin, effectiveMax);
  return { min: effectiveMin, max: effectiveMax };
}

export function clampSplitSize(value: number, bounds: SplitSizeBounds): number {
  const safeValue = Number.isFinite(value) ? value : bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, safeValue));
}

export function getPointerSplitSize(
  originSize: number,
  originCoordinate: number,
  currentCoordinate: number,
): number {
  return originSize + currentCoordinate - originCoordinate;
}

export function getKeyboardSplitSize(
  key: string,
  orientation: SplitOrientation,
  currentSize: number,
  bounds: SplitSizeBounds,
  step: number,
): number | null {
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;

  const safeStep = Math.max(1, Math.abs(step));
  if (orientation === "horizontal") {
    if (key === "ArrowLeft") {
      return clampSplitSize(currentSize - safeStep, bounds);
    }
    if (key === "ArrowRight") {
      return clampSplitSize(currentSize + safeStep, bounds);
    }
    return null;
  }

  if (key === "ArrowUp") {
    return clampSplitSize(currentSize - safeStep, bounds);
  }
  if (key === "ArrowDown") {
    return clampSplitSize(currentSize + safeStep, bounds);
  }
  return null;
}

export function readStoredSplitSize(
  storage: Pick<SplitStorage, "getItem">,
  key: string,
  bounds: SplitSizeBounds,
): number | null {
  try {
    const storedValue = storage.getItem(key);
    if (storedValue === null || storedValue.trim() === "") return null;
    const parsedValue = Number(storedValue);
    if (!Number.isFinite(parsedValue)) return null;
    return clampSplitSize(parsedValue, bounds);
  } catch {
    return null;
  }
}

export function storeSplitSize(
  storage: Pick<SplitStorage, "setItem">,
  key: string,
  value: number,
): boolean {
  try {
    storage.setItem(key, String(Math.round(value)));
    return true;
  } catch {
    return false;
  }
}
