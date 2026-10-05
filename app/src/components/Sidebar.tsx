// Zed's Threads sidebar: search, project groups (collapsible), threads with agent icon + age.
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Project, SidebarThread } from "../lib/api";
import { useStore } from "../lib/store";
import { ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { BellIcon, GitIcon, ClockIcon, GearIcon, PlusIcon, SearchIcon, SidebarIcon, WarningIcon } from "./Icons";
import { MacSwitcher } from "./MacSwitcher";
import { Sheet } from "./Sheet";
import { ThreadRow } from "./ThreadRow";

type Row =
  | { type: "project"; key: string; project: Project; open: boolean }
  | { type: "thread"; key: string; thread: SidebarThread; project: Project }
  | { type: "empty"; key: string };

type Props = {
  onOpen: (t: SidebarThread) => void;
  onNewThread: (p: Project) => void;
  onSettings: () => void;
  onToggleSidebar?: () => void;
  onReviewChanges?: (p: Project) => void;
  initialMode?: "projects" | "history" | "inbox";
};

export function Sidebar({ onOpen, onNewThread, onSettings, onToggleSidebar, onReviewChanges, initialMode }: Props) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const insets = useSafeAreaInsets();
  const { projects, expanded, toggle, selected, error, live, refresh, api } = useStore();
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"projects" | "history" | "inbox">(initialMode ?? "projects");
  useEffect(() => {
    if (initialMode) setMode(initialMode);
  }, [initialMode]);
  const history = mode === "history";
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<SidebarThread | null>(null);
  const [renaming, setRenaming] = useState<SidebarThread | null>(null);
  const [newTitle, setNewTitle] = useState("");

  const needsYou = (th: SidebarThread) => !th.archived && (th.status === "needs_permission" || !!th.unread);
  const inboxCount = useMemo(() => projects.reduce((n, p) => n + p.threads.filter(needsYou).length, 0), [projects]);
  const setMeta = async (th: SidebarThread, patch: { title?: string; archived?: boolean }) => {
    try {
      await api.setMeta(th.id, patch);
      await refresh();
    } catch {}
  };

  const rows = useMemo<Row[]>(() => {
    const needle = q.trim().toLowerCase();
    const out: Row[] = [];
    if (mode !== "projects") {
      const all = projects.flatMap((p) => p.threads.map((th) => ({ th, p })));
      all.sort((a, b) => Number(b.th.status === "needs_permission") - Number(a.th.status === "needs_permission") || b.th.updatedAt - a.th.updatedAt);
      for (const { th, p } of all) {
        if (needle && !th.title.toLowerCase().includes(needle)) continue;
        if (mode === "inbox" && !needsYou(th)) continue;
        // History shows archived threads too (so they can be found and unarchived).
        out.push({ type: "thread", key: `h:${th.id}`, thread: th, project: p });
      }
      return out;
    }
    for (const p of projects) {
      const visible = p.threads.filter((th) => !th.archived);
      const matches = needle ? visible.filter((th) => th.title.toLowerCase().includes(needle)) : visible;
      if (needle && !matches.length) continue;
      const open = needle ? true : !!expanded[p.path];
      out.push({ type: "project", key: `p:${p.path}`, project: p, open });
      if (!open) continue;
      if (!matches.length) out.push({ type: "empty", key: `e:${p.path}` });
      for (const th of matches) out.push({ type: "thread", key: `t:${th.id}`, thread: th, project: p });
    }
    return out;
  }, [projects, expanded, q, mode]);

  const now = Date.now();

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <MacSwitcher />
      <View style={s.searchBar}>
        <SearchIcon color={t.faint} size={17} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search threads..."
          placeholderTextColor={t.faint}
          style={s.search}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>
      {error ? (
        <Pressable onPress={onSettings} style={s.error}>
          <WarningIcon color={t.warning} size={15} />
          <Text style={s.errorText} numberOfLines={2}>{error} — tap to set up the connection</Text>
        </Pressable>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        refreshing={refreshing}
        onRefresh={async () => {
          setRefreshing(true);
          await refresh();
          setRefreshing(false);
        }}
        initialNumToRender={30}
        renderItem={({ item, index }) => {
          if (item.type === "project") {
            const afterThread = rows[index - 1]?.type === "thread";
            // Collapsed projects still say what's going on inside: needs you > working > unread.
            const live = item.project.threads.filter((x) => !x.archived);
            const collapsed = !q.trim() && !expanded[item.project.path];
            const waiting = collapsed && live.some((x) => x.status === "needs_permission");
            const working = collapsed && !waiting && live.some((x) => x.status === "running");
            const unread = collapsed && !waiting && !working && live.some((x) => x.unread);
            return (
              <Pressable
                onPress={() => toggle(item.project.path)}
                onLongPress={() => onReviewChanges?.(item.project)}
                style={({ pressed }) => [s.project, afterThread && s.projectTop, pressed && { backgroundColor: t.hover }]}
              >
                <Text style={s.projectName} numberOfLines={1}>{item.project.name}</Text>
                {waiting ? <WarningIcon color={t.warning} size={15} /> : null}
                {working ? <ActivityIndicator size="small" color={t.muted} style={{ transform: [{ scale: 0.75 }] }} /> : null}
                {unread ? <View style={[s.projectDot, { backgroundColor: t.accent }]} /> : null}
                {onReviewChanges ? (
                  <Pressable hitSlop={10} onPress={() => onReviewChanges(item.project)} style={s.projectPlus}>
                    <GitIcon color={t.faint} size={16} />
                  </Pressable>
                ) : null}
                <Pressable hitSlop={10} onPress={() => onNewThread(item.project)} style={s.projectPlus}>
                  <PlusIcon color={t.faint} size={16} />
                </Pressable>
              </Pressable>
            );
          }
          if (item.type === "empty") {
            return (
              <View style={s.empty}>
                <View style={s.emptyDot} />
                <Text style={s.emptyText}>No threads yet</Text>
              </View>
            );
          }
          const th = item.thread;
          return (
            <ThreadRow
              th={th}
              t={t}
              now={now}
              selected={selected === th.id}
              subtitle={mode !== "projects" ? item.project.name : undefined}
              preview={mode === "inbox"}
              onOpen={() => onOpen(th)}
              onMenu={() => setMenu(th)}
              onArchive={() => setMeta(th, { archived: !th.archived })}
            />
          );
        }}
        ListEmptyComponent={
          !error ? (
            <View style={s.empty}>
              <Text style={s.emptyText}>{mode === "inbox" ? "Nothing needs you right now" : projects.length ? "No matching threads" : "Loading…"}</Text>
            </View>
          ) : null
        }
      />
      {mode !== "projects" ? (
        <View style={s.modeBar}>
          <Text style={s.modeText}>{mode === "inbox" ? "Needs you" : "All threads"}</Text>
          <Pressable hitSlop={8} onPress={() => setMode("projects")}>
            <Text style={[s.modeText, { color: t.accent }]}>Projects</Text>
          </Pressable>
        </View>
      ) : null}
      <Sheet visible={!!menu} onClose={() => setMenu(null)} title={menu?.title}>
        {menu
          ? [
              { label: "Rename", run: () => { setNewTitle(menu.title); setRenaming(menu); } },
              { label: menu.archived ? "Unarchive" : "Archive", run: () => setMeta(menu, { archived: !menu.archived }) },
              ...(menu.unread ? [{ label: "Mark as read", run: () => api.seen(menu.id).then(refresh, () => {}) }] : []),
            ].map((a) => (
              <Pressable key={a.label} onPress={() => { setMenu(null); a.run(); }} style={({ pressed }) => [s.menuItem, pressed && { backgroundColor: t.hover }]}>
                <Text style={s.menuText}>{a.label}</Text>
              </Pressable>
            ))
          : null}
        <Text style={s.menuMeta}>Rename and archive apply in this app; Zed's own sidebar is unchanged.</Text>
      </Sheet>
      <Sheet visible={!!renaming} onClose={() => setRenaming(null)} title="Rename thread">
        <View style={{ paddingHorizontal: 18, gap: 12 }}>
          <TextInput value={newTitle} onChangeText={setNewTitle} autoFocus style={s.renameInput} placeholderTextColor={t.faint} placeholder={renaming?.zedTitle ?? renaming?.title} />
          <Pressable
            onPress={() => {
              if (renaming) setMeta(renaming, { title: newTitle });
              setRenaming(null);
            }}
            style={s.renameBtn}
          >
            <Text style={s.renameBtnText}>Save</Text>
          </Pressable>
          {renaming?.zedTitle ? (
            <Pressable onPress={() => { if (renaming) setMeta(renaming, { title: "" }); setRenaming(null); }}>
              <Text style={[s.menuMeta, { color: t.accent, paddingHorizontal: 0 }]}>Restore Zed's title “{renaming.zedTitle}”</Text>
            </Pressable>
          ) : null}
        </View>
      </Sheet>
      <View style={[s.bottom, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <View style={s.bottomLeft}>
          {/* Wide layouts: show / hide the thread list. Phones: back to the Projects view. */}
          <Pressable hitSlop={8} onPress={onToggleSidebar ?? (() => setMode("projects"))} accessibilityLabel={onToggleSidebar ? "Toggle sidebar" : "Projects"}>
            <SidebarIcon color={!onToggleSidebar && mode === "projects" ? t.accent : t.muted} size={18} />
          </Pressable>
          <Pressable hitSlop={8} onPress={() => setMode((m) => (m === "history" ? "projects" : "history"))}>
            <ClockIcon color={history ? t.accent : t.muted} size={18} />
          </Pressable>
          <Pressable hitSlop={8} onPress={() => setMode((m) => (m === "inbox" ? "projects" : "inbox"))} style={s.bellWrap}>
            <BellIcon color={mode === "inbox" ? t.accent : t.muted} size={18} />
            {inboxCount ? (
              <View style={[s.badge, { backgroundColor: t.accent }]}>
                <Text style={s.badgeText}>{inboxCount > 99 ? "99+" : inboxCount}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>
        <View style={s.bottomLeft}>
          <View style={[s.liveDot, { backgroundColor: live ? t.success : t.faint }]} />
          <Pressable hitSlop={8} onPress={onSettings}>
            <GearIcon color={t.muted} size={18} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function styles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.sidebar },
    searchBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, height: 46, borderBottomWidth: 1, borderBottomColor: t.border },
    search: { flex: 1, fontSize: 16, color: t.text, fontFamily: ui, paddingVertical: 8, outlineStyle: "none" } as any,
    error: { flexDirection: "row", gap: 8, alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: t.border },
    errorText: { flex: 1, color: t.muted, fontSize: 13, fontFamily: ui },
    project: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 12, height: 50, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.sidebar },
    projectTop: { borderTopWidth: 1, borderTopColor: t.border },
    projectName: { flex: 1, fontSize: 16, color: t.text, fontFamily: ui },
    projectDot: { width: 8, height: 8, borderRadius: 4, marginHorizontal: 4 },
    projectPlus: { padding: 4 },
    thread: { paddingLeft: 14, paddingRight: 14, paddingVertical: 9 },
    threadSel: { backgroundColor: t.selected },
    threadLine: { flexDirection: "row", alignItems: "center" },
    icon: { width: 26, height: 22, alignItems: "flex-start", justifyContent: "center" },
    title: { flex: 1, fontSize: 16, color: t.text, fontFamily: ui },
    age: { marginLeft: 26, marginTop: 2, fontSize: 14, color: t.muted, fontFamily: ui },
    empty: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.border },
    emptyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.border },
    emptyText: { fontSize: 15, color: t.faint, fontFamily: ui },
    bottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: t.border },
    bottomLeft: { flexDirection: "row", alignItems: "center", gap: 18 },
    bellWrap: { position: "relative" },
    badge: { position: "absolute", top: -7, right: -10, minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 4, alignItems: "center", justifyContent: "center" },
    badgeText: { color: "#fff", fontSize: 10.5, fontWeight: "700", fontFamily: ui },
    modeBar: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 1, borderTopColor: t.border },
    modeText: { fontSize: 13, color: t.muted, fontFamily: ui },
    menuItem: { paddingHorizontal: 18, paddingVertical: 13 },
    menuText: { fontSize: 16, color: t.text, fontFamily: ui },
    menuMeta: { fontSize: 12.5, color: t.faint, fontFamily: ui, paddingHorizontal: 18, paddingVertical: 8 },
    renameInput: { borderWidth: 1, borderColor: t.borderStrong, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: t.text, fontFamily: ui, outlineStyle: "none" } as any,
    renameBtn: { height: 42, borderRadius: 8, backgroundColor: t.accent, alignItems: "center", justifyContent: "center", marginBottom: 6 },
    renameBtnText: { color: "#fff", fontSize: 15.5, fontFamily: ui, fontWeight: "600" },
    liveDot: { width: 7, height: 7, borderRadius: 4 },
  });
}
