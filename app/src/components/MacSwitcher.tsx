// The Mac switcher at the top of the sidebar: which Mac's projects you're looking at, a dot when
// something on another Mac needs you, and a sheet to switch, add, rename or remove Macs.
import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { Host } from "../lib/hosts";
import { useStore } from "../lib/store";
import { ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { CheckIcon, ChevronDown, LaptopIcon, PencilIcon, PlusIcon, TrashIcon } from "./Icons";
import { Sheet } from "./Sheet";

export function MacSwitcher() {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const { hosts, activeHost, switchHost, removeHost, renameHost, others, live } = useStore();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const elsewhere = Object.values(others).reduce((n, o) => n + o.needs, 0);
  if (!activeHost) return null;

  const close = () => {
    setOpen(false);
    setEditing(null);
    setConfirmRemove(null);
  };

  const status = (h: Host) => {
    if (h.id === activeHost.id) return live ? "Connected" : "Connecting…";
    const o = others[h.id];
    if (!o) return "Checking…";
    if (!o.online) return "Offline";
    return o.needs ? `${o.needs} need${o.needs === 1 ? "s" : ""} you` : "Nothing waiting";
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [s.bar, pressed && { backgroundColor: t.hover }]}
        accessibilityLabel={`Mac: ${activeHost.name}. Switch Mac`}
      >
        <LaptopIcon color={t.muted} size={17} />
        <Text style={s.name} numberOfLines={1}>
          {activeHost.name}
        </Text>
        <ChevronDown color={t.faint} size={14} />
        {elsewhere ? (
          <View style={[s.badge, { backgroundColor: t.accent }]}>
            <Text style={s.badgeText}>{elsewhere > 99 ? "99+" : elsewhere} elsewhere</Text>
          </View>
        ) : null}
      </Pressable>

      <Sheet visible={open} onClose={close} title="Your Macs">
        {hosts.map((h) => {
          const active = h.id === activeHost.id;
          const o = others[h.id];
          if (editing?.id === h.id) {
            return (
              <View key={h.id} style={s.row}>
                <TextInput value={editing.name} onChangeText={(name) => setEditing({ id: h.id, name })} autoFocus style={s.input} selectTextOnFocus />
                <Pressable
                  onPress={async () => {
                    await renameHost(h.id, editing.name);
                    setEditing(null);
                  }}
                  style={[s.smallBtn, { backgroundColor: t.accent }]}
                >
                  <Text style={[s.smallBtnText, { color: "#fff" }]}>Save</Text>
                </Pressable>
              </View>
            );
          }
          return (
            <Pressable
              key={h.id}
              onPress={() => {
                switchHost(h.id);
                close();
              }}
              style={({ pressed }) => [s.row, pressed && { backgroundColor: t.hover }]}
            >
              <View style={[s.dot, { backgroundColor: active ? (live ? t.success : t.faint) : o?.online ? (o.needs ? t.accent : t.success) : t.faint }]} />
              <View style={{ flex: 1 }}>
                <Text style={[s.rowName, active && { fontWeight: "600" }]} numberOfLines={1}>
                  {h.name}
                </Text>
                <Text style={[s.rowSub, o?.needs ? { color: t.accent } : null]}>{status(h)}</Text>
              </View>
              {active ? <CheckIcon color={t.accent} size={18} /> : null}
              <Pressable onPress={() => setEditing({ id: h.id, name: h.name })} hitSlop={4} style={s.icon} accessibilityLabel={`Rename ${h.name}`}>
                <PencilIcon color={t.faint} size={16} />
              </Pressable>
              <Pressable
                onPress={async () => {
                  if (confirmRemove !== h.id) return setConfirmRemove(h.id);
                  await removeHost(h.id);
                  setConfirmRemove(null);
                  if (hosts.length === 1) {
                    close();
                    router.replace("/scan");
                  }
                }}
                hitSlop={4}
                style={[s.icon, confirmRemove === h.id && { width: 76 }]}
                accessibilityLabel={`Remove ${h.name}`}
              >
                {confirmRemove === h.id ? <Text style={[s.smallBtnText, { color: t.error }]}>Remove?</Text> : <TrashIcon color={t.faint} size={16} />}
              </Pressable>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => {
            close();
            router.push("/scan");
          }}
          style={({ pressed }) => [s.row, pressed && { backgroundColor: t.hover }]}
        >
          <PlusIcon color={t.accent} size={18} />
          <Text style={[s.rowName, { color: t.accent, flex: 1 }]}>Add a Mac</Text>
        </Pressable>
        <Text style={s.foot}>Each Mac shows only its own projects and threads. Notifications come from all of them.</Text>
      </Sheet>
    </>
  );
}

function styles(t: Theme) {
  return StyleSheet.create({
    bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, minHeight: 46, borderBottomWidth: 1, borderBottomColor: t.border },
    name: { flexShrink: 1, fontSize: 16, color: t.text, fontFamily: ui, fontWeight: "600" },
    badge: { marginLeft: "auto", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
    badgeText: { color: "#fff", fontSize: 12, fontFamily: ui, fontWeight: "600" },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, minHeight: 60 },
    dot: { width: 9, height: 9, borderRadius: 5 },
    rowName: { fontSize: 16, color: t.text, fontFamily: ui },
    rowSub: { fontSize: 13, color: t.faint, fontFamily: ui, marginTop: 2 },
    icon: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
    input: { flex: 1, fontSize: 16, color: t.text, fontFamily: ui, borderBottomWidth: 1, borderBottomColor: t.accent, paddingVertical: 8, outlineStyle: "none" } as any,
    smallBtn: { minHeight: 36, paddingHorizontal: 14, borderRadius: 8, alignItems: "center", justifyContent: "center" },
    smallBtnText: { fontSize: 14.5, fontFamily: ui, fontWeight: "600" },
    foot: { fontSize: 13, color: t.faint, fontFamily: ui, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 6 },
  });
}
