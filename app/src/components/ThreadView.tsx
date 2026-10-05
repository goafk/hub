// One thread: Zed-style header, live transcript, permission prompt, and composer.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Entry, PendingElicitation, ThreadDetail } from "../lib/api";
import { QuestionCard } from "./Question";
import { KeyboardSafe } from "../lib/keyboard";
import { QueuePanel } from "./QueuePanel";
import { useStore } from "../lib/store";
import { ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { Composer } from "./Composer";
import { EntryView } from "./Entries";
import { AgentIcon, ChevronLeft, ExpandIcon, MoreIcon, PlusIcon, SearchIcon, WarningIcon, XIcon } from "./Icons";
import { PlanBar } from "./PlanBar";
import { Sheet } from "./Sheet";

type Props = { id: string; onBack?: () => void; onNewThread?: (cwd: string) => void; onToggleWide?: () => void; onReviewChanges?: (cwd: string) => void };

export function ThreadView({ id, onBack, onNewThread, onToggleWide, onReviewChanges }: Props) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const insets = useSafeAreaInsets();
  const { api, onEvent } = useStore();
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const listRef = useRef<FlatList<any>>(null);
  const [resumeErr, setResumeErr] = useState<string | null>(null);
  const [permBusy, setPermBusy] = useState<string | null>(null);
  const syncedRef = useRef<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      setThread(await api.thread(id));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [api, id]);

  useEffect(() => {
    setThread(null);
    load();
    api.seen(id).catch(() => {}); // opening a thread clears its unread mark
  }, [load, api, id]);

  useEffect(
    () =>
      onEvent((e) => {
        if (e.type === "resync") {
          load(); // stream reconnected: pick up whatever we missed
          return;
        }
        if (e.type === "sidebar.changed") {
          // Unsynced threads change only in the agent's logs, which Zed's DB reflects.
          if (syncedRef.current === false) load();
          return;
        }
        if (e.threadId !== id) return;
        if (e.type === "queue.error") {
          setToast(`Queued message not sent: ${e.data?.message ?? "error"}`);
          return;
        }
        if (e.type === "entry.upserted") {
          const entry = e.data as Entry;
          setThread((th) => {
            if (!th) return th;
            // The hub's echo of our message replaces the optimistic copy.
            const entries = entry.kind === "user" ? th.entries.filter((x) => x.seq >= 0) : th.entries.slice();
            const i = entries.findIndex((x) => x.seq === entry.seq);
            if (i >= 0) entries[i] = entry;
            else entries.push(entry);
            return { ...th, entries };
          });
        } else if (e.type === "entries.cleared") {
          setThread((th) => (th ? { ...th, entries: [] } : th));
        } else if (e.type === "thread.updated" || e.type === "needs_input") {
          if (e.type === "thread.updated" && e.data) {
            setThread((th) =>
              th
                ? {
                    ...th,
                    status: e.data.status,
                    online: !!e.data.online,
                    title: e.data.title ?? th.title,
                    configOptions: e.data.configOptions ?? th.configOptions,
                    pendingPermissions: e.data.pendingPermissions ?? th.pendingPermissions,
                    pendingElicitations: e.data.pendingElicitations ?? th.pendingElicitations,
                    availableCommands: e.data.availableCommands ?? th.availableCommands,
                    queued: e.data.queued ?? th.queued,
                  }
                : th,
            );
          } else load();
        }
      }),
    [onEvent, id, load],
  );

  useEffect(() => {
    syncedRef.current = thread ? thread.synced : null;
  }, [thread]);

  useEffect(() => {
    if (!toast) return;
    const tm = setTimeout(() => setToast(null), 1500);
    return () => clearTimeout(tm);
  }, [toast]);

  // Newest at the bottom: inverted list over reversed entries. The last agent message of
  // each turn gets Zed's copy / feedback footer.
  const rows = useMemo(() => {
    const es = thread?.entries ?? [];
    const out: Array<{ entry: Entry; turnEnd?: string }> = [];
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      const next = es[i + 1];
      const endsTurn = e.kind === "agent" && (!next || next.kind === "user") && !(i === es.length - 1 && thread?.status === "running");
      out.push({ entry: e, turnEnd: endsTurn ? e.text ?? "" : undefined });
    }
    return out.reverse();
  }, [thread]);

  // Find in thread: rows (newest first) whose text matches; step through them.
  const findHits = useMemo(() => {
    const q = findQ.trim().toLowerCase();
    if (!q) return [] as number[];
    return rows.map((r, i) => ((r.entry.text ?? r.entry.title ?? "").toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0);
  }, [rows, findQ]);
  const jump = (dir: 1 | -1) => {
    if (!findHits.length) return;
    const next = (findIdx + dir + findHits.length) % findHits.length;
    setFindIdx(next);
    listRef.current?.scrollToIndex({ index: findHits[next], viewPosition: 0.5, animated: true });
  };
  useEffect(() => {
    setFindIdx(0);
    if (findHits.length) listRef.current?.scrollToIndex({ index: findHits[0], viewPosition: 0.5, animated: true });
  }, [findHits]);
  const plan = useMemo(() => [...(thread?.entries ?? [])].reverse().find((e) => e.kind === "plan")?.data ?? [], [thread]);
  const toggleAutoApprove = async () => {
    if (!thread) return;
    const next = !thread.autoApprove;
    await api.setMeta(id, { autoApprove: next });
    setThread((th) => (th ? { ...th, autoApprove: next } : th));
    setToast(next ? "Approving everything in this thread" : "Asking before tools again");
  };

  const queueAction = useCallback(
    async (action: "remove" | "edit" | "send_now" | "clear", qid?: string, text?: string) => {
      try {
        const r = await api.queue(id, action, qid, text);
        setThread((th) => (th ? { ...th, queued: r.queued } : th));
      } catch (e: any) {
        setToast(e.message);
      }
    },
    [api, id],
  );

  const live = !!thread?.synced && thread.online;
  const running = thread?.status === "running" || thread?.status === "needs_permission";
  const perms = thread?.pendingPermissions ?? [];
  const questions = thread?.pendingElicitations ?? [];
  // Questions not attached to a visible tool call are shown above the composer instead.
  const looseQuestions = questions.filter((q) => !q.toolCallId || !thread?.entries.some((e) => e.toolCallId === q.toolCallId));
  const resume = useCallback(async () => {
    setResuming(true);
    setResumeErr(null);
    try {
      await api.resume(id);
      await load();
    } catch (e: any) {
      setResumeErr(e.message);
    } finally {
      setResuming(false);
    }
  }, [api, id, load]);
  const cwd = thread?.cwd;
  const searchFiles = useCallback(async (q: string) => (cwd ? (await api.files(cwd, q)).files : []), [api, cwd]);
  const answer = useCallback(
    async (q: PendingElicitation, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => {
      await api.answer(id, q.requestId, action, content);
      setThread((th) => (th ? { ...th, pendingElicitations: (th.pendingElicitations ?? []).filter((x) => x.requestId !== q.requestId) } : th));
    },
    [api, id],
  );

  return (
    <View style={[s.root, { paddingTop: onBack ? insets.top : 0 }]}>
      <View style={s.header}>
        {onBack ? (
          <Pressable hitSlop={10} onPress={onBack} style={{ marginRight: 4 }}>
            <ChevronLeft color={t.muted} size={22} />
          </Pressable>
        ) : null}
        <AgentIcon kind={thread?.kind ?? "claude"} color={t.muted} size={19} />
        <Text style={s.headerTitle} numberOfLines={1}>{thread?.title ?? " "}</Text>
        {thread?.autoApprove ? (
          <View style={s.autoBadge}>
            <Text style={s.autoBadgeText}>auto</Text>
          </View>
        ) : null}
        {thread ? (
          <Pressable hitSlop={8} onPress={() => onNewThread?.(thread.cwd)}>
            <PlusIcon color={t.muted} size={19} />
          </Pressable>
        ) : null}
        {onToggleWide ? (
          <Pressable hitSlop={8} onPress={onToggleWide}>
            <ExpandIcon color={t.muted} size={17} />
          </Pressable>
        ) : null}
        <Pressable hitSlop={8} onPress={() => setMenu(true)}>
          <MoreIcon color={t.muted} size={19} />
        </Pressable>
      </View>

      {findOpen ? (
        <View style={s.findBar}>
          <SearchIcon color={t.faint} size={15} />
          <TextInput value={findQ} onChangeText={setFindQ} autoFocus placeholder="Find in thread" placeholderTextColor={t.faint} style={s.findInput} onSubmitEditing={() => jump(1)} />
          <Text style={s.findCount}>{findQ ? `${findHits.length ? findIdx + 1 : 0}/${findHits.length}` : ""}</Text>
          <Pressable hitSlop={8} onPress={() => jump(1)}><ChevronLeft color={t.muted} size={17} /></Pressable>
          <Pressable hitSlop={8} onPress={() => jump(-1)} style={{ transform: [{ rotate: "180deg" }] }}><ChevronLeft color={t.muted} size={17} /></Pressable>
          <Pressable hitSlop={8} onPress={() => { setFindOpen(false); setFindQ(""); }}><XIcon color={t.muted} size={15} /></Pressable>
        </View>
      ) : null}
      {thread && plan.length ? <PlanBar plan={plan} t={t} /> : null}
      <KeyboardSafe style={{ flex: 1 }} iosOffset={onBack ? insets.top + 52 : 0} bottomInset={onBack ? insets.bottom : 0}>
        {error && !thread ? (
          <View style={s.center}>
            <WarningIcon color={t.warning} size={20} />
            <Text style={s.muted}>{error}</Text>
          </View>
        ) : !thread ? (
          <View style={s.center}>
            <ActivityIndicator color={t.faint} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            onScrollToIndexFailed={(info) => setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5 }), 250)}
            inverted
            data={rows}
            keyExtractor={(r) => String(r.entry.seq)}
            renderItem={({ item, index }) => (
              <EntryView
                highlight={!!findQ && findHits[findIdx] === index}
                entry={item.entry}
                turnEnd={item.turnEnd}
                onCopied={() => setToast("Copied")}
                agentName={thread.agentName}
                question={item.entry.toolCallId ? questions.find((q) => q.toolCallId === item.entry.toolCallId) : undefined}
                onAnswer={answer}
              />
            )}
            extraData={[questions, findIdx, findQ]}
            contentContainerStyle={s.list}
            initialNumToRender={14}
            maxToRenderPerBatch={10}
            windowSize={9}
            keyboardDismissMode="interactive"
            ListHeaderComponent={
              thread.status === "running" ? (
                <View style={s.generating}>
                  <ActivityIndicator size="small" color={t.faint} style={{ transform: [{ scale: 0.7 }] }} />
                  <Text style={s.mutedSmall}>Generating…</Text>
                </View>
              ) : null
            }
            ListEmptyComponent={<Text style={[s.mutedSmall, { textAlign: "center", padding: 24 }]}>No messages yet</Text>}
          />
        )}

        {looseQuestions.length ? (
          <ScrollView style={{ maxHeight: "60%", flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 12 }}>
            {looseQuestions.map((q) => (
              <QuestionCard key={String(q.requestId)} pending={q} agentName={thread?.agentName} onAnswer={(a, c) => answer(q, a, c)} />
            ))}
          </ScrollView>
        ) : null}
        {perms.map((p) => (
          <View key={String(p.requestId)} style={s.perm}>
            <View style={s.permHead}>
              <WarningIcon color={t.warning} size={16} />
              <Text style={s.permTitle} numberOfLines={3}>{p.toolCall?.title ?? "The agent wants to run a tool"}</Text>
            </View>
            <View style={s.permButtons}>
              {p.options.map((o) => {
                const allow = (o.kind ?? o.optionId).startsWith("allow");
                return (
                  <Pressable
                    key={o.optionId}
                    disabled={permBusy !== null}
                    onPress={async () => {
                      const key = `${p.requestId}:${o.optionId}`;
                      setPermBusy(key);
                      try {
                        await api.permission(id, p.requestId, o.optionId);
                        // Drop the card right away; the hub's update confirms it.
                        setThread((th) => (th ? { ...th, pendingPermissions: (th.pendingPermissions ?? []).filter((x) => x.requestId !== p.requestId), status: "running" } : th));
                      } catch (e: any) {
                        setToast(e.message);
                        load();
                      } finally {
                        setPermBusy(null);
                      }
                    }}
                    style={({ pressed }) => [s.permBtn, allow && s.permAllow, (pressed || (permBusy !== null && permBusy !== `${p.requestId}:${o.optionId}`)) && { opacity: 0.55 }]}
                  >
                    {permBusy === `${p.requestId}:${o.optionId}` ? (
                      <ActivityIndicator size="small" color={allow ? "#fff" : t.faint} />
                    ) : (
                      <Text style={[s.permBtnText, allow && { color: "#fff" }]}>{o.name}</Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}

        {thread ? (
          live ? (
            <View style={{ paddingBottom: onBack ? insets.bottom : 0, backgroundColor: t.surface }}>
              <QueuePanel
                items={thread.queued ?? []}
                onRemove={(qid) => queueAction("remove", qid)}
                onEdit={(qid, text) => queueAction("edit", qid, text)}
                onSendNow={(qid) => queueAction("send_now", qid)}
                onClear={() => queueAction("clear")}
              />
              <Composer
                agentName={thread.agentName ?? "agent"}
                options={thread.configOptions ?? []}
                commands={thread.availableCommands ?? []}
                usage={thread.usage}
                running={running}
                onSend={async (text, mentions, images) => {
                  if (running) {
                    // Mid-turn: the hub queues it (Zed-style) and sends it when the turn ends.
                    const r = await api.prompt(id, text, mentions, images?.map((i) => ({ mimeType: i.mimeType, data: i.data })));
                    const q = r.queued;
                    if (q) setThread((th) => (th ? { ...th, queued: [...(th.queued ?? []).filter((x) => x.id !== q.id), q] } : th));
                    return;
                  }
                  // Show the message and the working state immediately; the hub's echo replaces it.
                  const tempSeq = -Date.now();
                  setThread((th) => (th ? { ...th, status: "running", entries: [...th.entries, { seq: tempSeq, kind: "user", text }] } : th));
                  try {
                    await api.prompt(id, text, mentions, images?.map((i) => ({ mimeType: i.mimeType, data: i.data })));
                  } catch (e) {
                    setThread((th) => (th ? { ...th, status: "idle", entries: th.entries.filter((x) => x.seq !== tempSeq) } : th));
                    throw e;
                  }
                }}
                searchFiles={searchFiles}
                onCancel={() => api.cancel(id).catch((e) => setToast(e.message))}
                onConfig={async (cid, value) => {
                  const r = await api.config(id, cid, value);
                  if (r.configOptions) setThread((th) => (th ? { ...th, configOptions: r.configOptions } : th));
                }}
              />
            </View>
          ) : (
            <View style={[s.notice, { paddingBottom: 14 + (onBack ? insets.bottom : 0) }]}>
              <Text style={s.noticeText}>
                {thread.synced
                  ? "This thread isn't open in Zed right now. Continue it here — Zed shows the new messages next time you open it."
                  : `Read-only: ${thread.agentName} isn't synced (run afk setup to sync it).`}
              </Text>
              {resumeErr ? <Text style={[s.noticeText, { color: t.error }]}>{resumeErr}</Text> : null}
              {thread.synced ? (
                <Pressable onPress={resume} disabled={resuming} style={[s.resumeBtn, resuming && { opacity: 0.6 }]}>
                  {resuming ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.resumeText}>Continue here</Text>}
                </Pressable>
              ) : (
                <Pressable onPress={() => onNewThread?.(thread.cwd)} style={s.noticeBtn}>
                  <PlusIcon color={t.accent} size={15} />
                  <Text style={s.noticeBtnText}>New thread</Text>
                </Pressable>
              )}
            </View>
          )
        ) : null}
      </KeyboardSafe>

      {toast ? (
        <View style={s.toast} pointerEvents="none">
          <Text style={s.toastText}>{toast}</Text>
        </View>
      ) : null}

      <Sheet visible={menu} onClose={() => setMenu(false)}>
        {[
          { label: "Find in thread", run: () => setFindOpen(true) },
          ...(onReviewChanges ? [{ label: "Review changes", run: () => onReviewChanges(thread!.cwd) }] : []),
          ...(live ? [{ label: thread?.autoApprove ? "Approve everything: on — turn off" : "Approve everything in this thread", run: toggleAutoApprove }] : []),
          { label: "Refresh", run: load },
          ...(live && running ? [{ label: "Stop generating", run: () => api.cancel(id) }] : []),
          { label: "Copy thread id", run: async () => { const C = await import("expo-clipboard"); await C.setStringAsync(id); setToast("Copied"); } },
        ].map((a) => (
          <Pressable key={a.label} onPress={() => { setMenu(false); a.run(); }} style={({ pressed }) => [s.menuItem, pressed && { backgroundColor: t.hover }]}>
            <Text style={s.menuText}>{a.label}</Text>
          </Pressable>
        ))}
        {thread ? <Text style={s.menuMeta}>{thread.agentName} · {thread.cwd}{thread.synced ? " · synced" : ""}</Text> : null}
      </Sheet>
    </View>
  );
}

function styles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.panel },
    header: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 14, height: 52, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.panel },
    autoBadge: { backgroundColor: t.warning, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
    autoBadgeText: { color: "#fff", fontSize: 11, fontWeight: "700", fontFamily: ui, textTransform: "uppercase" },
    findBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, height: 44, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface },
    findInput: { flex: 1, fontSize: 15, color: t.text, fontFamily: ui, outlineStyle: "none" } as any,
    findCount: { fontSize: 13, color: t.faint, fontFamily: ui, minWidth: 34, textAlign: "right" },
    headerTitle: { flex: 1, fontSize: 17, color: t.text, fontFamily: ui, marginLeft: -4 },
    list: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 18 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
    muted: { color: t.muted, fontSize: 15, fontFamily: ui, textAlign: "center" },
    mutedSmall: { color: t.faint, fontSize: 13.5, fontFamily: ui },
    generating: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 4 },
    perm: { marginHorizontal: 12, marginBottom: 10, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: t.warning, backgroundColor: t.surface },
    permHead: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
    permTitle: { flex: 1, color: t.text, fontSize: 15, fontFamily: ui },
    permButtons: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
    permBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: t.borderStrong },
    permAllow: { backgroundColor: t.accent, borderColor: t.accent },
    permBtnText: { color: t.text, fontSize: 14, fontFamily: ui },
    notice: { borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface, paddingHorizontal: 18, paddingTop: 14, gap: 10 },
    noticeText: { color: t.muted, fontSize: 14, lineHeight: 20, fontFamily: ui },
    resumeBtn: { alignSelf: "stretch", height: 42, borderRadius: 8, backgroundColor: t.accent, alignItems: "center", justifyContent: "center" },
    resumeText: { color: "#fff", fontSize: 15.5, fontFamily: ui, fontWeight: "600" },
    noticeBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
    noticeBtnText: { color: t.accent, fontSize: 14.5, fontFamily: ui },
    toast: { position: "absolute", bottom: 120, alignSelf: "center", backgroundColor: t.text, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
    toastText: { color: t.panel, fontSize: 14, fontFamily: ui },
    menuItem: { paddingHorizontal: 18, paddingVertical: 13 },
    menuText: { fontSize: 16, color: t.text, fontFamily: ui },
    menuMeta: { fontSize: 12.5, color: t.faint, fontFamily: ui, paddingHorizontal: 18, paddingTop: 8 },
  });
}
