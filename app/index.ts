// App entry: Expo Router, plus the Android home-screen widget's background task handler.
import "expo-router/entry";
import Constants from "expo-constants";
import { Platform } from "react-native";

if (Platform.OS === "android" && Constants.executionEnvironment !== "storeClient") {
  try {
    const { registerWidgetTaskHandler } = require("react-native-android-widget");
    const { widgetTaskHandler } = require("./src/widget/handler");
    registerWidgetTaskHandler(widgetTaskHandler);
  } catch {
    // Widget module not in this build.
  }
}
