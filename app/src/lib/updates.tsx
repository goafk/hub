// Over-the-air updates you can see: check when the app opens or comes back to the foreground,
// download in the background, then offer a one-tap restart. (Relying on the default "applies on the
// next cold start" doesn't work on phones that keep apps alive after you swipe them away.)
import * as Updates from "expo-updates";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { ui, useTheme } from "./theme";

type State = "idle" | "checking" | "downloading" | "ready" | "latest" | "error";
type Ctx = { state: State; error?: string; check: () => Promise<void>; restart: () => void; info: string };
const UpdatesCtx = createContext<Ctx>({ state: "idle", check: async () => {}, restart: () => {}, info: "" });
export const useUpdates = () => useContext(UpdatesCtx);

const enabled = Platform.OS !== "web" && !__DEV__ && Updates.isEnabled;

function describe(): string {
  const version = Constants.expoConfig?.version ?? "?";
  if (!enabled) return `Version ${version}`;
  const id = Updates.updateId ? Updates.updateId.slice(0, 8) : "built-in";
  const when = Updates.createdAt ? ` · ${Updates.createdAt.toLocaleString()}` : "";
  return `Version ${version} · ${Updates.isEmbeddedLaunch ? "built-in code" : `update ${id}`}${when}`;
}

export function UpdatesProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string>();
  const last = useRef(0);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (!enabled || busy.current) return;
    busy.current = true;
    last.current = Date.now();
    setError(undefined);
    try {
      setState((s) => (s === "ready" ? s : "checking"));
      const r = await Updates.checkForUpdateAsync();
      if (!r.isAvailable) {
        setState((s) => (s === "ready" ? s : "latest"));
        return;
      }
      setState("downloading");
      await Updates.fetchUpdateAsync();
      setState("ready");
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setState("error");
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && Date.now() - last.current > 60_000) check();
    });
    return () => sub.remove();
  }, [check]);

  const restart = useCallback(() => {
    Updates.reloadAsync().catch(() => {});
  }, []);

  return (
    <UpdatesCtx.Provider value={{ state, error, check, restart, info: describe() }}>
      {children}
      {state === "ready" ? <Banner onRestart={restart} /> : null}
    </UpdatesCtx.Provider>
  );
}

function Banner({ onRestart }: { onRestart: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { justifyContent: "flex-start", paddingTop: insets.top + 8, alignItems: "center" }]}>
      <View style={[st.banner, { backgroundColor: t.surface, borderColor: t.borderStrong }]}>
        <Text style={[st.text, { color: t.text }]}>Update ready</Text>
        <Pressable onPress={onRestart} style={({ pressed }) => [st.btn, { backgroundColor: t.accent }, pressed && { transform: [{ scale: 0.96 }] }]}>
          <Text style={st.btnText}>Restart</Text>
        </Pressable>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 26,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  text: { fontSize: 15, fontFamily: ui, fontWeight: "500" },
  btn: { minHeight: 40, paddingHorizontal: 16, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  btnText: { color: "#fff", fontSize: 15, fontFamily: ui, fontWeight: "600" },
});
