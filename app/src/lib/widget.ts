// Keeps the Android home-screen widget in sync while the app is running.
import Constants from "expo-constants";
import { Platform } from "react-native";
import type { Project } from "./api";

const enabled = Platform.OS === "android" && Constants.executionEnvironment !== "storeClient";
let last = "";

export function updateWidget(projects: Project[]): void {
  if (!enabled) return;
  try {
    const { requestWidgetUpdate } = require("react-native-android-widget");
    const { WIDGETS } = require("../widget/AgentsWidget");
    const { widgetDataFrom } = require("../widget/data");
    const data = widgetDataFrom(projects);
    const sig = JSON.stringify({ ...data, updatedAt: 0 });
    if (sig === last) return;
    last = sig;
    for (const name of Object.keys(WIDGETS)) {
      requestWidgetUpdate({
        widgetName: name,
        renderWidget: (info: { width: number; height: number }) => {
          const size = { width: info.width, height: info.height };
          return { light: WIDGETS[name](data, false, size), dark: WIDGETS[name](data, true, size) };
        },
        widgetNotFound: () => {},
      });
    }
  } catch {}
}
