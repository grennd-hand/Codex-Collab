import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
} from "@fluentui/react-components";

const brand: BrandVariants = {
  10: "#02040C",
  20: "#07102D",
  30: "#0B1C52",
  40: "#11297A",
  50: "#1737A1",
  60: "#2047CB",
  70: "#2E5BFF",
  80: "#5378FF",
  90: "#7896FF",
  100: "#9BB1FF",
  110: "#B8C7FF",
  120: "#CFDAFF",
  130: "#E0E7FF",
  140: "#EDF1FF",
  150: "#F5F7FF",
  160: "#FBFCFF",
};

export const lightTheme = createLightTheme(brand);
export const darkTheme = createDarkTheme(brand);

export type ThemeMode = "light" | "dark";
