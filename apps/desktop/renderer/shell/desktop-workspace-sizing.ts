export interface DesktopMainSplitSizing {
  defaultPrimarySize: number;
  minPrimarySize: number;
  maxPrimarySize: number;
  minSecondarySize: number;
}

export function desktopMainSplitSizing(
  editorExpanded: boolean,
): DesktopMainSplitSizing {
  return editorExpanded
    ? {
        defaultPrimarySize: 760,
        minPrimarySize: 520,
        maxPrimarySize: 1_120,
        minSecondarySize: 360,
      }
    : {
        defaultPrimarySize: 360,
        minPrimarySize: 260,
        maxPrimarySize: 1_120,
        minSecondarySize: 360,
      };
}
