// Push notifications (native builds): ask permission, register the Expo push token with the hub,
// and open the thread when a notification is tapped.
import Constants from "expo-constants";
import * as Device from "expo-device";
import { router } from "expo-router";
import { Platform } from "react-native";
import type { Api } from "./api";

type N = typeof import("expo-notifications");

// expo-notifications has no web implementation; load it only on native.
const Notifications: N | null = Platform.OS === "web" ? null : require("expo-notifications");

let handlerSet = false;
let hostSwitcher: ((hubId: string) => void) | null = null;

/** The store registers how to switch Macs, so a tapped notification opens the right one. */
export function setHostSwitcher(fn: ((hubId: string) => void) | null): void {
  hostSwitcher = fn;
}

export function setupNotificationHandling(): () => void {
  if (!Notifications) return () => {};
  if (!handlerSet) {
    handlerSet = true;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
    });
  }
  const open = (data: any) => {
    // From another Mac: switch to it first, so the thread loads from the right hub.
    if (data?.hubId) hostSwitcher?.(String(data.hubId));
    // Defer so a cold start has mounted the navigator before we push.
    if (data?.threadId) setTimeout(() => router.push(`/thread/${encodeURIComponent(String(data.threadId))}`), data?.hubId ? 600 : 300);
  };
  // Cold start from a tapped notification.
  const last = Notifications.getLastNotificationResponse();
  if (last) open(last.notification.request.content.data);
  const sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data));
  return () => sub.remove();
}

export type PushState = { status: "unsupported" | "denied" | "registered" | "error"; detail?: string };

/** Registers this phone with the hub. Safe to call repeatedly (the hub dedupes tokens). */
export async function registerForPush(api: Api, prefs?: { finished?: boolean; input?: boolean }, showHub = false): Promise<PushState> {
  if (!Notifications) return { status: "unsupported", detail: "Notifications need the installed app (not the browser)." };
  if (!Device.isDevice) return { status: "unsupported", detail: "Push needs a physical device." };
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", { name: "Finished", importance: Notifications.AndroidImportance.DEFAULT });
    await Notifications.setNotificationChannelAsync("input", { name: "Needs your input", importance: Notifications.AndroidImportance.MAX, vibrationPattern: [0, 250, 250, 250] });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return { status: "denied", detail: "Allow notifications for afk in system settings." };
  const projectId = Constants?.expoConfig?.extra?.eas?.projectId ?? (Constants as any)?.easConfig?.projectId;
  if (!projectId) return { status: "error", detail: "Missing EAS project id in app config." };
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api.registerDevice({ token, platform: Platform.OS, name: Device.deviceName ?? Device.modelName ?? undefined, prefs, showHub });
    return { status: "registered", detail: token };
  } catch (e: any) {
    return { status: "error", detail: e?.message ?? String(e) };
  }
}
