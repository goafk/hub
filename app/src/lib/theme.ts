// Zed's look: the user's themes are Catppuccin Latte (light) and One Dark (dark).
import { Platform, useColorScheme } from "react-native";

export type Theme = {
  dark: boolean;
  panel: string; // thread area
  sidebar: string;
  surface: string; // composer / raised areas
  selected: string;
  hover: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  link: string;
  codeBg: string;
  tableHead: string;
  warning: string;
  error: string;
  success: string;
  switchOff: string;
};

export const latte: Theme = {
  dark: false,
  panel: "#E6E9EF",
  sidebar: "#E1E4EB",
  surface: "#EFF1F5",
  selected: "#D3D7E0",
  hover: "#DADEE6",
  border: "#CCD0DA",
  borderStrong: "#BCC0CC",
  text: "#4C4F69",
  muted: "#6C6F85",
  faint: "#9CA0B0",
  accent: "#8839EF",
  link: "#8839EF",
  codeBg: "#DCE0E8",
  tableHead: "#DCE0E8",
  warning: "#DF8E1D",
  error: "#D20F39",
  success: "#40A02B",
  switchOff: "#9CA0B0",
};

export const oneDark: Theme = {
  dark: true,
  panel: "#282C34",
  sidebar: "#21252B",
  surface: "#2C313A",
  selected: "#2F343E",
  hover: "#2A2F37",
  border: "#181A1F",
  borderStrong: "#3E4451",
  text: "#ABB2BF",
  muted: "#7F848E",
  faint: "#5C6370",
  accent: "#C678DD",
  link: "#61AFEF",
  codeBg: "#21252B",
  tableHead: "#2C313A",
  warning: "#E5C07B",
  error: "#E06C75",
  success: "#98C379",
  switchOff: "#5C6370",
};

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? oneDark : latte;
}

export const mono = Platform.select({ web: "FiraCode_400Regular, Menlo, monospace", default: "FiraCode_400Regular" });
export const monoMedium = Platform.select({ web: "FiraCode_500Medium, Menlo, monospace", default: "FiraCode_500Medium" });
export const ui = Platform.select({ ios: "System", web: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif", default: undefined });
