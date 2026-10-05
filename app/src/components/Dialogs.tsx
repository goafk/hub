// New-thread picker and hub connection settings.
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { Agent, SidebarThread } from "../lib/api";
import { makeApi } from "../lib/api";
import { loadPushPrefs, useStore } from "../lib/store";
import type { PushPrefs } from "../lib/store";
import { mono, ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { AgentIcon, CheckIcon } from "./Icons";
import { LOCK_AFTER_OPTIONS, useLock } from "./LockGate";
import { useUpdates } from "../lib/updates";
import { Sheet } from "./Sheet";

const kindOf = (id: string) => (id.includes("claude") ? "claude" : id.includes("codex") ? "codex" : "other");

export function NewThreadSheet({ cwd, onClose, onCreated }: { cwd: string | null; onClose: () => void; onCreated: (t: SidebarThread) => void }) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const { api } = useStore();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) return;
    setErr(null);
    setPrompt("");
    api.agents().then(
      (a) => {
        setAgents(a);
        setAgentId((cur) => cur ?? a.find((x) => x.agentId.includes("claude"))?.agentId ?? a[0]?.agentId ?? null);
      },
      (e) => setErr(e.message),
    );
  }, [cwd, api]);

  const start = async () => {
    if (!cwd || !agentId) return;
    setBusy(true);
    setErr(null);
    try {
      const th = await api.newThread(cwd, agentId, prompt.trim() || undefined);
      onCreated(th);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={!!cwd} onClose={onClose} title={`New thread · ${cwd?.split("/").pop() ?? ""}`}>
      {agents === null && !err ? <ActivityIndicator style={{ margin: 20 }} color={t.faint} /> : null}
      {(agents ?? []).map((a) => (
        <Pressable key={a.agentId} onPress={() => setAgentId(a.agentId)} style={({ pressed }) => [s.row, pressed && { backgroundColor: t.hover }]}>
          <AgentIcon kind={kindOf(a.agentId)} color={t.muted} size={18} />
          <Text style={[s.rowText, agentId === a.agentId && { color: t.accent }]}>{a.zedName}</Text>
          {agentId === a.agentId ? <CheckIcon color={t.accent} size={16} /> : null}
        </Pressable>
      ))}
      <View style={s.box}>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="First message (optional)"
          placeholderTextColor={t.faint}
          multiline
          style={s.input}
        />
      </View>
      {err ? <Text style={s.err}>{err}</Text> : null}
      <Text style={s.hint}>Zed opens the project and starts the thread on your Mac.</Text>
      <Pressable onPress={start} disabled={busy || !agentId} style={[s.primary, (busy || !agentId) && { opacity: 0.5 }]}>
        {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.primaryText}>Start thread</Text>}
      </Pressable>
    </Sheet>
  );
}

export function SettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const { conn, setConn, push, setPushPrefs } = useStore();
  const lock = useLock();
  const updates = useUpdates();
  const [prefs, setPrefs] = useState<PushPrefs>({ finished: true, input: true });
  useEffect(() => {
    loadPushPrefs().then(setPrefs);
  }, []);
  const togglePref = (k: keyof PushPrefs) => {
    const next = { ...prefs, [k]: !prefs[k] };
    setPrefs(next);
    setPushPrefs(next);
  };
  const [url, setUrl] = useState(conn.url);
  const [token, setToken] = useState(conn.token);
  const [state, setState] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setUrl(conn.url);
      setToken(conn.token);
      setState(null);
    }
  }, [visible, conn]);

  const save = async () => {
    const clean = url.trim().replace(/\/$/, "");
    const withScheme = /^https?:\/\//.test(clean) ? clean : clean ? `http://${clean}${/:\d+$/.test(clean) ? "" : ":47321"}` : "";
    setState("Checking…");
    try {
      await makeApi({ url: withScheme, token: token.trim() }).sidebar();
      await setConn({ url: withScheme, token: token.trim() });
      setState("Connected");
      setTimeout(onClose, 400);
    } catch (e: any) {
      setState(e.message);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Hub connection">
      <View style={{ paddingHorizontal: 18, gap: 10 }}>
        <Text style={s.label}>Hub address</Text>
        <TextInput value={url} onChangeText={setUrl} placeholder="192.168.1.20:47321 or https://<mac>.<tailnet>.ts.net:8443" placeholderTextColor={t.faint} autoCapitalize="none" autoCorrect={false} style={s.field} />
        <Text style={s.label}>Key</Text>
        <TextInput value={token} onChangeText={setToken} placeholder="from ~/.afk/config.json" placeholderTextColor={t.faint} autoCapitalize="none" autoCorrect={false} secureTextEntry style={s.field} />
        <Text style={s.hint2}>
          Easiest: run "afk pair" on the Mac and scan the code (Add a Mac). Use this form only to type an address and key by hand.
        </Text>
        {state ? <Text style={[s.hint2, { color: state === "Connected" ? t.success : state === "Checking…" ? t.muted : t.error }]}>{state}</Text> : null}
      </View>
      <Pressable onPress={save} style={s.primary}>
        <Text style={s.primaryText}>Save</Text>
      </Pressable>
      <Text style={[s.label, { paddingHorizontal: 18, marginTop: 4 }]}>Notifications</Text>
      {(["input", "finished"] as const).map((k) => (
        <View key={k} style={s.prefRow}>
          <Text style={s.rowText}>{k === "input" ? "When a thread needs your input" : "When a thread finishes"}</Text>
          <Switch value={prefs[k]} onValueChange={() => togglePref(k)} trackColor={{ false: t.switchOff, true: t.accent }} />
        </View>
      ))}
      {lock.supported ? (
        <>
          <Text style={[s.label, { paddingHorizontal: 18, marginTop: 8 }]}>Security</Text>
          <View style={s.prefRow}>
            <Text style={s.rowText}>Require fingerprint / Face ID</Text>
            <Switch value={lock.enabled} onValueChange={(v) => lock.setEnabled(v)} trackColor={{ false: t.switchOff, true: t.accent }} />
          </View>
          {lock.enabled ? (
            <>
              <Text style={[s.hint2, { paddingHorizontal: 18 }]}>Ask again after the app hasn't been used for</Text>
              <View style={s.chips}>
                {LOCK_AFTER_OPTIONS.map((o) => {
                  const on = lock.after === o.ms;
                  return (
                    <Pressable
                      key={o.ms}
                      onPress={() => lock.setAfter(o.ms)}
                      style={[s.chip, { backgroundColor: on ? t.accent : "transparent", borderColor: on ? t.accent : t.borderStrong }]}
                    >
                      <Text style={[s.chipText, { color: on ? "#fff" : t.text }]}>{o.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}
        </>
      ) : null}
      <Text style={[s.label, { paddingHorizontal: 18, marginTop: 8 }]}>App</Text>
      <View style={s.prefRow}>
        <Text style={[s.hint2, { flex: 1 }]}>{updates.info}</Text>
        <Pressable onPress={updates.state === "ready" ? updates.restart : updates.check} hitSlop={8} style={s.linkBtn}>
          <Text style={[s.rowText, { color: t.accent, flex: 0, fontSize: 15 }]}>
            {updates.state === "ready"
              ? "Restart to update"
              : updates.state === "checking"
                ? "Checking…"
                : updates.state === "downloading"
                  ? "Downloading…"
                  : updates.state === "latest"
                    ? "Up to date ✓"
                    : "Check for updates"}
          </Text>
        </Pressable>
      </View>
      {updates.error ? <Text style={[s.err, { paddingTop: 0 }]}>{updates.error}</Text> : null}
      <Text style={[s.hint2, { paddingHorizontal: 18, paddingBottom: 8, color: push?.status === "registered" ? t.success : t.faint }]}>
        {push?.status === "registered" ? "This phone is registered for notifications." : push?.detail ?? "Checking…"}
      </Text>
    </Sheet>
  );
}

function styles(t: Theme) {
  return StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingVertical: 12 },
    linkBtn: { minHeight: 44, justifyContent: "center", paddingLeft: 12 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 6 },
    chip: { minHeight: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, alignItems: "center", justifyContent: "center" },
    chipText: { fontSize: 14.5, fontFamily: ui, fontWeight: "500" },
    rowText: { flex: 1, fontSize: 16, color: t.text, fontFamily: ui },
    box: { marginHorizontal: 18, marginTop: 8, borderWidth: 1, borderColor: t.borderStrong, borderRadius: 8, padding: 12 },
    input: { minHeight: 70, fontFamily: mono, fontSize: 14.5, color: t.text, outlineStyle: "none" } as any,
    err: { color: t.error, fontSize: 13.5, fontFamily: ui, paddingHorizontal: 18, paddingTop: 8 },
    hint: { color: t.faint, fontSize: 13, fontFamily: ui, paddingHorizontal: 18, paddingTop: 8 },
    hint2: { color: t.faint, fontSize: 13, lineHeight: 18, fontFamily: ui },
    primary: { margin: 18, marginTop: 14, height: 44, borderRadius: 8, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" },
    primaryText: { color: "#fff", fontSize: 16, fontFamily: ui, fontWeight: "600" },
    prefRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingVertical: 8 },
    label: { color: t.muted, fontSize: 13, fontFamily: ui },
    field: { borderWidth: 1, borderColor: t.borderStrong, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: t.text, fontFamily: mono, outlineStyle: "none" } as any,
  });
}
