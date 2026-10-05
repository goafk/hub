// Line diff for ACP `diff` tool content (file edits), red/green like Zed's edit cards.
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { mono, ui, useTheme } from "../lib/theme";

type Line = { kind: " " | "+" | "-"; text: string };

/** LCS line diff; falls back to "all removed / all added" for very large inputs. */
export function diffLines(oldText: string, newText: string): Line[] {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  if (a.length * b.length > 400_000) return [...a.map((t) => ({ kind: "-" as const, text: t })), ...b.map((t) => ({ kind: "+" as const, text: t }))];
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (out.push({ kind: " ", text: a[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: "-", text: a[i++] });
    else out.push({ kind: "+", text: b[j++] });
  }
  while (i < n) out.push({ kind: "-", text: a[i++] });
  while (j < m) out.push({ kind: "+", text: b[j++] });
  return out;
}

/** Keeps changed lines plus `ctx` lines of context, collapsing the rest. */
function hunks(lines: Line[], ctx = 2): Array<Line | { gap: number }> {
  const keep = lines.map((l, i) => l.kind !== " " || lines.slice(Math.max(0, i - ctx), i + ctx + 1).some((x) => x.kind !== " "));
  const out: Array<Line | { gap: number }> = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ gap });
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ gap });
  return out;
}

export function DiffView({ path, oldText, newText }: { path?: string; oldText?: string | null; newText?: string }) {
  const t = useTheme();
  const [all, setAll] = useState(false);
  const rows = useMemo(() => hunks(diffLines(oldText ?? "", newText ?? "")), [oldText, newText]);
  const added = rows.filter((r) => "kind" in r && r.kind === "+").length;
  const removed = rows.filter((r) => "kind" in r && r.kind === "-").length;
  const shown = all ? rows : rows.slice(0, 40);
  const bg = { "+": t.dark ? "rgba(152,195,121,0.14)" : "rgba(64,160,43,0.12)", "-": t.dark ? "rgba(224,108,117,0.14)" : "rgba(210,15,57,0.10)", " ": "transparent" };
  return (
    <View style={[st.box, { borderColor: t.border }]}>
      <View style={[st.head, { borderBottomColor: t.border }]}>
        <Text style={[st.path, { color: t.text }]} numberOfLines={1}>{path?.split("/").slice(-3).join("/") ?? "file"}</Text>
        <Text style={[st.stat, { color: t.success }]}>+{added}</Text>
        <Text style={[st.stat, { color: t.error }]}>−{removed}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ minWidth: "100%" }}>
          {shown.map((r, i) =>
            "gap" in r ? (
              <Text key={i} style={[st.gap, { color: t.faint }]}>⋯ {r.gap} unchanged line{r.gap === 1 ? "" : "s"}</Text>
            ) : (
              <Text key={i} style={[st.line, { backgroundColor: bg[r.kind], color: r.kind === " " ? t.muted : t.text }]}>
                <Text style={{ color: r.kind === "+" ? t.success : r.kind === "-" ? t.error : t.faint }}>{r.kind} </Text>
                {r.text || " "}
              </Text>
            ),
          )}
        </View>
      </ScrollView>
      {rows.length > 40 && !all ? (
        <Pressable onPress={() => setAll(true)} style={st.more}>
          <Text style={{ color: t.accent, fontFamily: ui, fontSize: 13 }}>Show all {rows.length} lines</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 6, overflow: "hidden", marginTop: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1 },
  path: { flex: 1, fontFamily: mono, fontSize: 12.5 },
  stat: { fontFamily: mono, fontSize: 12 },
  line: { fontFamily: mono, fontSize: 12, lineHeight: 18, paddingHorizontal: 10 },
  gap: { fontFamily: ui, fontSize: 12, paddingHorizontal: 10, paddingVertical: 3 },
  more: { padding: 8, alignItems: "center" },
});
