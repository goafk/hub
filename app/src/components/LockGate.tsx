// Optional fingerprint / Face ID lock, only after a real gap: the app must have been out of use for
// the chosen time (default 15 min). The last-used time is persisted, so Android killing the app in the
// background, or opening it from a notification / widget, doesn't force a scan.
// The app can run code on your Mac, so it shouldn't be one unlocked phone away from that.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ui, useTheme } from "../lib/theme";

const KEY = "acp-sync.lock";
const AFTER_KEY = "acp-sync.lock.after";
const LAST_KEY = "acp-sync.lock.lastUsed";
export const LOCK_AFTER_OPTIONS = [
  { ms: 0, label: "Always" },
  { ms: 5 * 60_000, label: "5 min" },
  { ms: 15 * 60_000, label: "15 min" },
  { ms: 60 * 60_000, label: "1 hour" },
  { ms: 4 * 60 * 60_000, label: "4 hours" },
] as const;
const DEFAULT_AFTER = 15 * 60_000;

type Lock = {
  supported: boolean;
  enabled: boolean;
  setEnabled: (on: boolean) => Promise<void>;
  after: number;
  setAfter: (ms: number) => Promise<void>;
};
const Ctx = createContext<Lock>({ supported: false, enabled: false, setEnabled: async () => {}, after: DEFAULT_AFTER, setAfter: async () => {} });
export const useLock = () => useContext(Ctx);

export function LockGate({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [locked, setLocked] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [after, setAfterState] = useState(DEFAULT_AFTER);
  const awayAt = useRef<number | null>(null);
  // The system fingerprint sheet itself backgrounds the app on some phones; don't count that as leaving.
  const authenticating = useRef(false);

  const markUsed = useCallback(() => {
    AsyncStorage.setItem(LAST_KEY, String(Date.now())).catch(() => {});
  }, []);

  const unlock = useCallback(async () => {
    setErr(null);
    authenticating.current = true;
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock afk", cancelLabel: "Cancel" });
    authenticating.current = false;
    if (r.success) {
      setLocked(false);
      markUsed();
    } else setErr(r.error === "user_cancel" ? null : "Couldn't verify — try again");
  }, [markUsed]);

  useEffect(() => {
    (async () => {
      if (Platform.OS === "web") return;
      const ok = (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
      setSupported(ok);
      const on = ok && (await AsyncStorage.getItem(KEY)) === "1";
      const a = Number((await AsyncStorage.getItem(AFTER_KEY)) ?? DEFAULT_AFTER);
      const ms = Number.isFinite(a) ? a : DEFAULT_AFTER;
      setAfterState(ms);
      setEnabledState(on);
      // Cold start: only lock if the app hasn't been used within the window.
      const last = Number((await AsyncStorage.getItem(LAST_KEY)) ?? 0);
      if (on && Date.now() - last >= ms) setLocked(true);
      else markUsed();
    })();
  }, [markUsed]);

  useEffect(() => {
    if (locked) unlock();
  }, [locked, unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (authenticating.current) return;
      if (state === "background") {
        awayAt.current = Date.now();
        markUsed();
      }
      if (state === "active") {
        if (enabled && awayAt.current && Date.now() - awayAt.current >= after) setLocked(true);
        else markUsed();
        awayAt.current = null;
      }
    });
    return () => sub.remove();
  }, [enabled, after, markUsed]);

  const setAfter = useCallback(async (ms: number) => {
    await AsyncStorage.setItem(AFTER_KEY, String(ms));
    setAfterState(ms);
  }, []);

  const setEnabled = useCallback(async (on: boolean) => {
    if (on) {
      authenticating.current = true;
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Turn on app lock" });
      authenticating.current = false;
      if (!r.success) return;
      markUsed();
    }
    await AsyncStorage.setItem(KEY, on ? "1" : "0");
    setEnabledState(on);
  }, [markUsed]);

  return (
    <Ctx.Provider value={{ supported, enabled, setEnabled, after, setAfter }}>
      {children}
      {locked ? (
        <View style={[StyleSheet.absoluteFill, st.cover, { backgroundColor: t.panel }]}>
          <Text style={[st.title, { color: t.text }]}>afk is locked</Text>
          {err ? <Text style={[st.err, { color: t.error }]}>{err}</Text> : null}
          <Pressable onPress={unlock} style={[st.btn, { backgroundColor: t.accent }]}>
            <Text style={st.btnText}>Unlock</Text>
          </Pressable>
        </View>
      ) : null}
    </Ctx.Provider>
  );
}

const st = StyleSheet.create({
  cover: { alignItems: "center", justifyContent: "center", gap: 16, zIndex: 1000 },
  title: { fontSize: 18, fontFamily: ui },
  err: { fontSize: 14, fontFamily: ui },
  btn: { paddingHorizontal: 28, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  btnText: { color: "#fff", fontSize: 16, fontFamily: ui, fontWeight: "600" },
});
