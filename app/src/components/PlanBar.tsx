// The agent's current plan pinned under the thread header: "Plan · 3/7" + current step; tap to expand.
import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ui } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { ChevronDown, ChevronRight } from "./Icons";

type Item = { content: string; status?: string; priority?: string };

export function PlanBar({ plan, t }: { plan: Item[]; t: Theme }) {
  const [open, setOpen] = useState(false);
  if (!plan?.length) return null;
  const done = plan.filter((p) => p.status === "completed").length;
  const current = plan.find((p) => p.status === "in_progress") ?? plan.find((p) => p.status !== "completed");
  return (
    <View style={[st.box, { backgroundColor: t.surface, borderBottomColor: t.border }]}>
      <Pressable onPress={() => setOpen((o) => !o)} style={st.head}>
        {open ? <ChevronDown color={t.muted} size={14} /> : <ChevronRight color={t.muted} size={14} />}
        <Text style={[st.label, { color: t.muted }]}>Plan · {done}/{plan.length}</Text>
        <View style={[st.track, { backgroundColor: t.border }]}>
          <View style={[st.fill, { backgroundColor: done === plan.length ? t.success : t.accent, width: `${(done / plan.length) * 100}%` }]} />
        </View>
        {!open && current ? <Text style={[st.current, { color: t.text }]} numberOfLines={1}>{current.content}</Text> : null}
      </Pressable>
      {open ? (
        <ScrollView style={{ maxHeight: 260 }} contentContainerStyle={{ paddingBottom: 8 }}>
          {plan.map((p, i) => (
            <View key={i} style={st.row}>
              <Text style={[st.mark, { color: p.status === "completed" ? t.success : p.status === "in_progress" ? t.accent : t.faint }]}>
                {p.status === "completed" ? "✓" : p.status === "in_progress" ? "◐" : "○"}
              </Text>
              <Text style={[st.item, { color: p.status === "completed" ? t.muted : t.text }, p.status === "completed" && { textDecorationLine: "line-through" }]}>{p.content}</Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

/** Context usage like Zed's meter: "53k / 1M". */
export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

const st = StyleSheet.create({
  box: { borderBottomWidth: 1, paddingHorizontal: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  label: { fontSize: 13, fontFamily: ui },
  track: { width: 48, height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4 },
  current: { flex: 1, fontSize: 13.5, fontFamily: ui },
  row: { flexDirection: "row", gap: 8, paddingVertical: 3, paddingLeft: 4 },
  mark: { width: 16, fontSize: 13.5 },
  item: { flex: 1, fontSize: 14, lineHeight: 20, fontFamily: ui },
});
