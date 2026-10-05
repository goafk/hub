// "Share to AFK" from any app: text, links and screenshots go to a new or existing thread.
import { router } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentIcon, CheckIcon, ChevronLeft } from "../components/Icons";
import type { Agent, Project, SidebarThread } from "../lib/api";
import { shrinkUri } from "../lib/images";
import { shareModule } from "../lib/share";
import { useStore } from "../lib/store";
import { mono, ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";

type Shared = { text?: string | null; webUrl?: string | null; files?: Array<{ path: string; mimeType: string; width?: number | null; height?: number | null }> | null };

export default function ShareScreen() {
  const mod = shareModule();
  const ctx = mod?.useShareIntentContext?.();
  const shared: Shared = ctx?.shareIntent ?? {};
  return <ShareForm shared={shared} onDone={() => { ctx?.resetShareIntent?.(); router.replace("/"); }} />;
}

function ShareForm({ shared, onDone }: { shared: Shared; onDone: () => void }) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const insets = useSafeAreaInsets();
  const { projects, api, select } = useStore();
  const [project, setProject] = useState<Project | null>(null);
  const [target, setTarget] = useState<"new" | string>("new");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const images = (shared.files ?? []).filter((f) => f.mimeType?.startsWith("image/"));
  const text = [shared.text, shared.webUrl && shared.webUrl !== shared.text ? shared.webUrl : null].filter(Boolean).join("\n");

  useEffect(() => {
    api.agents().then((a) => {
      setAgents(a);
      setAgentId(a.find((x) => x.agentId.includes("claude"))?.agentId ?? a[0]?.agentId ?? null);
    }, () => {});
  }, [api]);
  useEffect(() => {
    if (!project && projects.length) setProject(projects.find((p) => p.expanded) ?? projects[0]);
  }, [projects, project]);

  const recent: SidebarThread[] = (project?.threads ?? []).filter((x) => !x.archived && x.synced).slice(0, 6);

  const send = async () => {
    if (!project) return;
    setBusy(true);
    setErr(null);
    try {
      const attachments = await Promise.all(images.map((f) => shrinkUri(f.path, f.width ?? undefined, f.height ?? undefined)));
      const prompt = [note.trim(), text].filter(Boolean).join("\n\n") || "Take a look at this.";
      let id: string;
      if (target === "new") {
        if (!agentId) throw new Error("Pick an agent");
        id = (await api.newThread(project.path, agentId)).id;
      } else {
        id = target;
        const th = await api.thread(id);
        if (!th.online) await api.resume(id);
      }
      await api.prompt(id, prompt, [], attachments.map((a) => ({ mimeType: a.mimeType, data: a.data })));
      select(id);
      onDone();
      setTimeout(() => router.push(`/thread/${encodeURIComponent(id)}`), 50);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable hitSlop={10} onPress={onDone}>
          <ChevronLeft color={t.muted} size={22} />
        </Pressable>
        <Text style={s.title}>Send to an agent</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <View style={s.preview}>
          {text ? <Text style={s.previewText} numberOfLines={8}>{text}</Text> : null}
          {images.length ? (
            <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
              {images.map((f) => <Image key={f.path} source={{ uri: f.path }} style={s.thumb} />)}
            </ScrollView>
          ) : null}
          {!text && !images.length ? <Text style={s.muted}>Nothing was shared.</Text> : null}
        </View>
        <TextInput value={note} onChangeText={setNote} placeholder="Add an instruction (optional)" placeholderTextColor={t.faint} multiline style={s.input} />

        <Text style={s.label}>Project</Text>
        <View style={s.chips}>
          {projects.map((p) => (
            <Pressable key={p.path} onPress={() => { setProject(p); setTarget("new"); }} style={[s.chip, project?.path === p.path && s.chipOn]}>
              <Text style={[s.chipText, project?.path === p.path && { color: "#fff" }]}>{p.name}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={s.label}>Thread</Text>
        <Pressable onPress={() => setTarget("new")} style={[s.row, target === "new" && s.rowOn]}>
          <Text style={s.rowText}>New thread</Text>
          {target === "new" ? <CheckIcon color={t.accent} size={16} /> : null}
        </Pressable>
        {target === "new" ? (
          <View style={s.chips}>
            {agents.map((a) => (
              <Pressable key={a.agentId} onPress={() => setAgentId(a.agentId)} style={[s.chip, agentId === a.agentId && s.chipOn]}>
                <Text style={[s.chipText, agentId === a.agentId && { color: "#fff" }]}>{a.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {recent.map((th) => (
          <Pressable key={th.id} onPress={() => setTarget(th.id)} style={[s.row, target === th.id && s.rowOn]}>
            <AgentIcon kind={th.kind} color={t.muted} size={16} />
            <Text style={s.rowText} numberOfLines={1}>{th.title}</Text>
            {target === th.id ? <CheckIcon color={t.accent} size={16} /> : null}
          </Pressable>
        ))}

        {err ? <Text style={[s.muted, { color: t.error }]}>{err}</Text> : null}
        <Pressable onPress={send} disabled={busy || !project} style={[s.primary, (busy || !project) && { opacity: 0.6 }]}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>Send</Text>}
        </Pressable>
      </ScrollView>
    </View>
  );
}

function styles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.panel },
    header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, height: 52, borderBottomWidth: 1, borderBottomColor: t.border },
    title: { fontSize: 17, color: t.text, fontFamily: ui },
    preview: { borderWidth: 1, borderColor: t.borderStrong, borderRadius: 8, backgroundColor: t.surface, padding: 12, gap: 10 },
    previewText: { fontFamily: mono, fontSize: 13.5, lineHeight: 20, color: t.text },
    thumb: { width: 90, height: 90, borderRadius: 6 },
    muted: { color: t.muted, fontSize: 14, fontFamily: ui },
    input: { minHeight: 60, borderWidth: 1, borderColor: t.borderStrong, borderRadius: 8, padding: 12, fontSize: 15, color: t.text, fontFamily: ui, outlineStyle: "none" } as any,
    label: { color: t.muted, fontSize: 13, fontFamily: ui, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: { borderWidth: 1, borderColor: t.borderStrong, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
    chipOn: { backgroundColor: t.accent, borderColor: t.accent },
    chipText: { fontSize: 14, color: t.text, fontFamily: ui },
    row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 11, borderRadius: 8, borderWidth: 1, borderColor: t.border },
    rowOn: { borderColor: t.accent },
    rowText: { flex: 1, fontSize: 15, color: t.text, fontFamily: ui },
    primary: { height: 46, borderRadius: 8, backgroundColor: t.accent, alignItems: "center", justifyContent: "center", marginTop: 6 },
    primaryText: { color: "#fff", fontSize: 16, fontFamily: ui, fontWeight: "600" },
  });
}
