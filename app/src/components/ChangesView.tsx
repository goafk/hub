// Review what the agents changed in a project, then commit / push / discard — from the phone.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { FileChange, GitStatus } from "../lib/api";
import { useStore } from "../lib/store";
import { mono, ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { CheckIcon, ChevronDown, ChevronLeft, ChevronRight } from "./Icons";
import { UnifiedDiff } from "./UnifiedDiff";
import { KeyboardSafe } from "../lib/keyboard";

const LETTER: Record<FileChange["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" };

export function ChangesView({ cwd, onBack }: { cwd: string; onBack: () => void }) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const insets = useSafeAreaInsets();
  const { api } = useStore();
  const [st, setSt] = useState<GitStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, string | "loading">>({});
  const [picked, setPicked] = useState<Set<string> | null>(null); // null = all files
  const [message, setMessage] = useState("");
  const [andPush, setAndPush] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSt(await api.gitStatus(cwd));
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  }, [api, cwd]);
  useEffect(() => {
    load();
  }, [load]);

  const files = st?.files ?? [];
  const selected = picked ?? new Set(files.map((f) => f.path));
  const toggleFile = (p: string) => {
    const next = new Set(selected);
    next.has(p) ? next.delete(p) : next.add(p);
    setPicked(next);
  };
  const toggleDiff = async (f: FileChange) => {
    if (open[f.path]) return setOpen(({ [f.path]: _, ...rest }) => rest);
    setOpen((o) => ({ ...o, [f.path]: "loading" }));
    try {
      const { diff } = await api.gitDiff(cwd, f.path);
      setOpen((o) => ({ ...o, [f.path]: diff }));
    } catch (e: any) {
      setOpen((o) => ({ ...o, [f.path]: `(${e.message})` }));
    }
  };
  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setNote(null);
    try {
      const msg = await fn();
      if (msg) setNote(msg);
      await load();
      setPicked(null);
      setOpen({});
    } catch (e: any) {
      setNote(`⚠️ ${e.message}`);
    } finally {
      setBusy(null);
      setConfirmDiscard(false);
    }
  };
  const all = picked === null || selected.size === files.length;
  const sel = [...selected];
  const totals = files.filter((f) => selected.has(f.path)).reduce((a, f) => ({ add: a.add + f.added, rem: a.rem + f.removed }), { add: 0, rem: 0 });

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable hitSlop={10} onPress={onBack}>
          <ChevronLeft color={t.muted} size={22} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>Changes · {cwd.split("/").pop()}</Text>
          {st ? (
            <Text style={s.sub}>
              {st.branch}
              {st.ahead ? ` · ↑${st.ahead}` : ""}
              {st.behind ? ` · ↓${st.behind}` : ""}
              {!st.upstream ? " · no upstream" : ""} · {files.length} file{files.length === 1 ? "" : "s"}
            </Text>
          ) : null}
        </View>
        <Pressable hitSlop={8} onPress={() => setPicked(all ? new Set() : null)}>
          <Text style={s.link}>{all ? "None" : "All"}</Text>
        </Pressable>
      </View>
      <KeyboardSafe style={{ flex: 1 }}>
        {err ? <Text style={[s.note, { color: t.error }]}>{err}</Text> : null}
        {!st && !err ? <ActivityIndicator style={{ marginTop: 40 }} color={t.faint} /> : null}
        <FlatList
          data={files}
          keyExtractor={(f) => f.path}
          initialNumToRender={30}
          ListEmptyComponent={st ? <Text style={[s.note, { textAlign: "center", padding: 30 }]}>Working tree clean</Text> : null}
          renderItem={({ item: f }) => {
            const name = f.path.split("/").pop();
            const dir = f.path.split("/").slice(0, -1).join("/");
            const diff = open[f.path];
            return (
              <View style={s.fileWrap}>
                <View style={s.file}>
                  <Pressable hitSlop={6} onPress={() => toggleFile(f.path)} style={[s.box, selected.has(f.path) && s.boxOn]}>
                    {selected.has(f.path) ? <CheckIcon color="#fff" size={12} strokeWidth={2.6} /> : null}
                  </Pressable>
                  <Pressable onPress={() => toggleDiff(f)} style={s.fileMain}>
                    <Text style={[s.letter, { color: letterColor(f.status, t) }]}>{LETTER[f.status]}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.name} numberOfLines={1}>{name}</Text>
                      {dir ? <Text style={s.dir} numberOfLines={1}>{dir}</Text> : null}
                    </View>
                    <Text style={[s.stat, { color: t.success }]}>+{f.added}</Text>
                    <Text style={[s.stat, { color: t.error }]}>−{f.removed}</Text>
                    {diff ? <ChevronDown color={t.faint} size={14} /> : <ChevronRight color={t.faint} size={14} />}
                  </Pressable>
                </View>
                {diff === "loading" ? <ActivityIndicator size="small" color={t.faint} style={{ margin: 8 }} /> : diff ? <UnifiedDiff text={diff} t={t} /> : null}
              </View>
            );
          }}
        />
        {note ? <Text style={s.note}>{note}</Text> : null}
        <View style={[s.footer, { paddingBottom: 12 + insets.bottom }]}>
          {files.length ? (
            <>
              <TextInput value={message} onChangeText={setMessage} placeholder={`Commit message (${sel.length} file${sel.length === 1 ? "" : "s"}, +${totals.add} −${totals.rem})`} placeholderTextColor={t.faint} style={s.input} multiline />
              <View style={s.row}>
                <Text style={s.small}>and push</Text>
                <Switch value={andPush} onValueChange={setAndPush} trackColor={{ false: t.switchOff, true: t.accent }} />
                <View style={{ flex: 1 }} />
                <Pressable
                  // Discard only acts on files you picked yourself — never on the default "all".
                  disabled={!!busy || picked === null || !picked.size}
                  onPress={() => (confirmDiscard ? run("discard", async () => { await api.gitDiscard(cwd, sel); return `Discarded ${sel.length} file(s)`; }) : setConfirmDiscard(true))}
                  style={[s.btn, confirmDiscard && { borderColor: t.error }, (picked === null || !picked.size) && { opacity: 0.45 }]}
                >
                  {busy === "discard" ? <ActivityIndicator size="small" color={t.faint} /> : <Text style={[s.btnText, { color: t.error }]}>{confirmDiscard ? `Discard ${sel.length}?` : "Discard"}</Text>}
                </Pressable>
                <Pressable
                  disabled={!!busy || !sel.length || !message.trim()}
                  onPress={() =>
                    run("commit", async () => {
                      const { hash } = await api.gitCommit(cwd, message.trim(), all ? undefined : sel);
                      setMessage("");
                      if (andPush) await api.gitPush(cwd);
                      return `Committed ${hash}${andPush ? " and pushed" : ""}`;
                    })
                  }
                  style={[s.btn, s.primary, (!sel.length || !message.trim()) && { opacity: 0.5 }]}
                >
                  {busy === "commit" ? <ActivityIndicator size="small" color="#fff" /> : <Text style={[s.btnText, { color: "#fff" }]}>{andPush ? "Commit & push" : "Commit"}</Text>}
                </Pressable>
              </View>
            </>
          ) : st?.ahead ? (
            <Pressable disabled={!!busy} onPress={() => run("push", async () => { await api.gitPush(cwd); return "Pushed"; })} style={[s.btn, s.primary, { alignSelf: "stretch" }]}>
              {busy === "push" ? <ActivityIndicator size="small" color="#fff" /> : <Text style={[s.btnText, { color: "#fff" }]}>Push {st.ahead} commit{st.ahead === 1 ? "" : "s"}</Text>}
            </Pressable>
          ) : null}
        </View>
      </KeyboardSafe>
    </View>
  );
}

function letterColor(status: FileChange["status"], t: Theme): string {
  return status === "deleted" ? t.error : status === "modified" || status === "renamed" ? t.warning : t.success;
}

function styles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.panel },
    header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, minHeight: 56, borderBottomWidth: 1, borderBottomColor: t.border },
    title: { fontSize: 17, color: t.text, fontFamily: ui },
    sub: { fontSize: 13, color: t.muted, fontFamily: ui, marginTop: 1 },
    link: { color: t.accent, fontSize: 14.5, fontFamily: ui },
    fileWrap: { paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: t.border },
    file: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 50 },
    fileMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
    box: { width: 20, height: 20, borderRadius: 4, borderWidth: 1, borderColor: t.borderStrong, alignItems: "center", justifyContent: "center", backgroundColor: t.surface },
    boxOn: { backgroundColor: t.accent, borderColor: t.accent },
    letter: { width: 14, fontFamily: mono, fontSize: 13, fontWeight: "600" },
    name: { fontSize: 15, color: t.text, fontFamily: ui },
    dir: { fontSize: 12.5, color: t.faint, fontFamily: ui },
    stat: { fontFamily: mono, fontSize: 12 },
    note: { color: t.muted, fontSize: 13.5, fontFamily: ui, paddingHorizontal: 16, paddingVertical: 8 },
    footer: { borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface, paddingHorizontal: 14, paddingTop: 12, gap: 10 },
    input: { minHeight: 44, maxHeight: 120, borderWidth: 1, borderColor: t.borderStrong, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: t.text, fontFamily: mono, outlineStyle: "none" } as any,
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    small: { fontSize: 13.5, color: t.muted, fontFamily: ui },
    btn: { height: 38, paddingHorizontal: 14, borderRadius: 7, borderWidth: 1, borderColor: t.borderStrong, alignItems: "center", justifyContent: "center" },
    primary: { backgroundColor: t.accent, borderColor: t.accent },
    btnText: { fontSize: 14.5, fontFamily: ui, fontWeight: "600", color: t.text },
  });
}
