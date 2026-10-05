// Share-sheet support exists only in the installed app (not Expo Go or web).
import Constants from "expo-constants";
import { Platform } from "react-native";

export const shareSupported = Platform.OS !== "web" && Constants.executionEnvironment !== "storeClient";

/** The native module, or null where it isn't available. */
export function shareModule(): typeof import("expo-share-intent") | null {
  if (!shareSupported) return null;
  try {
    return require("expo-share-intent");
  } catch {
    return null;
  }
}
