import { FiraCode_400Regular, FiraCode_500Medium, useFonts } from "@expo-google-fonts/fira-code";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardRoot } from "../lib/keyboard";
import { StoreProvider } from "../lib/store";
import { useTheme } from "../lib/theme";
import { setupNotificationHandling } from "../lib/push";
import { LockGate } from "../components/LockGate";
import { UpdatesProvider } from "../lib/updates";
import React, { useEffect } from "react";
import { shareModule } from "../lib/share";

/** Wraps the app in the share-intent provider where the native module exists (installed app). */
function ShareProvider({ children }: { children: React.ReactNode }) {
  const mod = shareModule();
  if (!mod) return <>{children}</>;
  const P = mod.ShareIntentProvider;
  return <P options={{ resetOnBackground: true }}>{children}</P>;
}

export default function RootLayout() {
  const [loaded] = useFonts({ FiraCode_400Regular, FiraCode_500Medium });
  const t = useTheme();
  useEffect(() => setupNotificationHandling(), []);
  if (!loaded) return null;
  return (
    <ShareProvider>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardRoot>
    <SafeAreaProvider>
      <StoreProvider>
        <StatusBar style={t.dark ? "light" : "dark"} />
        <LockGate>
          <UpdatesProvider>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.panel } }} />
          </UpdatesProvider>
        </LockGate>
      </StoreProvider>
    </SafeAreaProvider>
      </KeyboardRoot>
    </GestureHandlerRootView>
    </ShareProvider>
  );
}
