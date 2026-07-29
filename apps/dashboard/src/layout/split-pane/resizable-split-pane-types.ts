import type { CSSProperties, ReactNode } from "react";
import type { SplitOrientation } from "./split-size.js";

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

export interface PointerResizeSession {
  pointerId: number;
  originCoordinate: number;
  originSize: number;
}

export type SplitPaneStyle = CSSProperties & {
  "--split-primary-size": string;
  "--split-separator-size": string;
};

export function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function getLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
