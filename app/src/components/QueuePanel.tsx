// Zed's "Queued Messages" panel: messages sent mid-turn wait here and go out when the turn ends.
// Each can be deleted, edited, or sent now (which stops the current turn first).
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { QueuedMessage } from "../lib/api";
import { mono, ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { ChevronDown, ChevronRight, PencilIcon, TrashIcon } from "./Icons";

type Props = {
  items: QueuedMessage[];
  onRemove: (id: string) => Promise<void>;
  onEdit: (id: string, text: string) => Promise<void>;
  onSendNow: (id: string) => Promise<void>;
  onClear: () => Promise<void>;
};

export function QueuePanel({ items, onRemove, onEdit, onSendNow, onClear }: Props) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!items.length) return null;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={s.root}>
      <View style={s.head}>
        <Pressable onPress={() => setOpen((o) => !o)} style={s.headLeft} hitSlop={6}>
          {open ? <ChevronDown color={t.muted} size={14} /> : <ChevronRight color={t.muted} size={14} />}
          <Text style={s.title}>
            {items.length} Queued Message{items.length === 1 ? "" : "s"}
          </Text>
        </Pressable>
        <Pressable onPress={() => run("clear", onClear)} style={s.textBtn} hitSlop={6}>
          {busy === "clear" ? <ActivityIndicator size="small" color={t.faint} /> : <Text style={s.textBtnLabel}>Clear All</Text>}
        </Pressable>
      </View>
      {open
        ? items.map((q) =>
            editing?.id === q.id ? (
              <View key={q.id} style={s.row}>
                <TextInput
                  value={editing.text}
                  onChangeText={(text) => setEditing({ id: q.id, text })}
                  autoFocus
                  multiline
                  style={s.input}
                />
                <Pressable onPress={() => setEditing(null)} style={s.textBtn} hitSlop={6}>
                  <Text style={[s.textBtnLabel, { color: t.muted }]}>Cancel</Text>
                </Pressable>
                <Pressable
                  disabled={!editing.text.trim()}
                  onPress={() => run(`edit:${q.id}`, () => onEdit(q.id, editing.text.trim()).then(() => setEditing(null)))}
                  style={[s.sendNow, { backgroundColor: t.accent }]}
                >
                  {busy === `edit:${q.id}` ? <ActivityIndicator size="small" color="#fff" /> : <Text style={[s.sendNowText, { color: "#fff" }]}>Save</Text>}
                </Pressable>
              </View>
            ) : (
              <View key={q.id} style={s.row}>
                <View style={[s.dot, { backgroundColor: t.accent }]} />
                <Text style={s.text} numberOfLines={2}>
                  {q.text}
                  {q.images ? <Text style={{ color: t.faint }}>{`  · ${q.images} photo${q.images === 1 ? "" : "s"}`}</Text> : null}
                </Text>
                <Pressable onPress={() => run(`rm:${q.id}`, () => onRemove(q.id))} style={s.icon} hitSlop={4} accessibilityLabel="Delete queued message">
                  {busy === `rm:${q.id}` ? <ActivityIndicator size="small" color={t.faint} /> : <TrashIcon color={t.muted} size={16} />}
                </Pressable>
                <Pressable onPress={() => setEditing({ id: q.id, text: q.text })} style={s.icon} hitSlop={4} accessibilityLabel="Edit queued message">
                  <PencilIcon color={t.muted} size={16} />
                </Pressable>
                <Pressable onPress={() => run(`now:${q.id}`, () => onSendNow(q.id))} style={({ pressed }) => [s.sendNow, pressed && { transform: [{ scale: 0.96 }] }]}>
                  {busy === `now:${q.id}` ? <ActivityIndicator size="small" color={t.faint} /> : <Text style={s.sendNowText}>Send Now</Text>}
                </Pressable>
              </View>
            ),
          )
        : null}
    </View>
  );
}

function styles(t: Theme) {
  return StyleSheet.create({
    root: { marginHorizontal: 10, marginBottom: 8, borderRadius: 10, borderWidth: 1, borderColor: t.borderStrong, backgroundColor: t.surface, overflow: "hidden" },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12, paddingRight: 6, minHeight: 44, borderBottomWidth: 1, borderBottomColor: t.border },
    headLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minHeight: 44 },
    title: { fontSize: 15, color: t.text, fontFamily: ui, fontWeight: "500" },
    textBtn: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
    textBtnLabel: { fontSize: 14, color: t.text, fontFamily: ui },
    row: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 12, paddingRight: 6, minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border },
    dot: { width: 8, height: 8, borderRadius: 4 },
    text: { flex: 1, fontSize: 14.5, color: t.text, fontFamily: mono, marginLeft: 4 },
    icon: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
    sendNow: { minHeight: 36, paddingHorizontal: 12, borderRadius: 7, backgroundColor: t.hover, alignItems: "center", justifyContent: "center" },
    sendNowText: { fontSize: 14, color: t.text, fontFamily: ui, fontWeight: "500" },
    input: { flex: 1, fontSize: 14.5, color: t.text, fontFamily: mono, paddingVertical: 8, outlineStyle: "none" } as any,
  });
}
