// zedthreads://pair?h=<hub id>&n=<name>&c=<one-time code>&u=<address>&u=<address>
// Opened by scanning the QR from `afk setup` / `afk pair` (phone camera or the in-app
// scanner). Finds an address that answers, trades the code for this phone's own key, adds the Mac.
import * as Device from "expo-device";
import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { listening, parsePairLink } from "../lib/hosts";
import { useStore } from "../lib/store";
import { ui, useTheme } from "../lib/theme";

export default function Pair() {
  const params = useLocalSearchParams();
  const { addHost, hosts } = useStore();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<{ step: "working" | "done" | "error"; text: string }>({ step: "working", text: "Finding your Mac…" });
  const started = useRef(false);
  const link = parsePairLink(params as Record<string, string | string[]>);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      if (!link) return setState({ step: "error", text: "This pairing code is incomplete. Run `afk pair` on your Mac for a new one." });
      // First address that answers at all (the code is single-use, so redeem it exactly once).
      const results = await Promise.all(link.urls.map(async (u) => ((await listening(u)) ? u : null)));
      const url = results.find(Boolean);
      if (!url) {
        return setState({
          step: "error",
          text: `Can't reach ${link.name}. Make sure this phone is on the same Wi-Fi, or that Tailscale is on, then scan again.`,
        });
      }
      setState({ step: "working", text: `Pairing with ${link.name}…` });
      try {
        const r = await fetch(`${url}/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: link.code, name: Device.deviceName ?? Device.modelName ?? "Phone" }),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok || !j.key) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
        const existing = hosts.find((h) => h.id === j.hub?.id);
        await addHost({
          id: j.hub?.id || link.hubId || `mac-${Date.now()}`,
          name: existing?.customName ? existing.name : j.hub?.name || link.name,
          customName: existing?.customName,
          urls: link.urls,
          lastUrl: url,
          key: j.key,
          addedAt: existing?.addedAt ?? Date.now(),
        });
        setState({ step: "done", text: `Connected to ${j.hub?.name || link.name}` });
        setTimeout(() => router.replace("/"), 700);
      } catch (e: any) {
        setState({ step: "error", text: e.message });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[st.root, { backgroundColor: t.panel, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {state.step === "working" ? <ActivityIndicator color={t.accent} /> : <Text style={[st.big, { color: state.step === "done" ? t.success : t.warning }]}>{state.step === "done" ? "✓" : "!"}</Text>}
      <Text style={[st.text, { color: t.text }]}>{state.text}</Text>
      {state.step === "error" ? (
        <View style={st.row}>
          <Pressable onPress={() => router.replace("/scan")} style={[st.btn, { backgroundColor: t.accent }]}>
            <Text style={st.btnText}>Scan again</Text>
          </Pressable>
          <Pressable onPress={() => router.replace("/")} style={[st.btn, { backgroundColor: t.hover }]}>
            <Text style={[st.btnText, { color: t.text }]}>Close</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, paddingHorizontal: 32 },
  big: { fontSize: 36, fontWeight: "700" },
  text: { fontSize: 17, lineHeight: 24, fontFamily: ui, textAlign: "center" },
  row: { flexDirection: "row", gap: 12, marginTop: 8 },
  btn: { minHeight: 44, paddingHorizontal: 22, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  btnText: { color: "#fff", fontSize: 16, fontFamily: ui, fontWeight: "600" },
});
