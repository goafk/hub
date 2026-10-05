// Renders a git unified diff (hunks, +/- lines) in Zed's diff colors.
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { mono, ui } from "../lib/theme";
import type { Theme } from "../lib/theme";

const MAX = 400;

export function UnifiedDiff({ text, t }: { text: string; t: Theme }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => {
    const out: string[] = [];
    let inBody = false;
    for (const l of text.split("\n")) {
      if (l.startsWith("@@")) inBody = true;
      if (!inBody) {
        if (l.startsWith("(new")) out.push(l);
        continue;
      }
      out.push(l);
    }
    if (out.at(-1) === "") out.pop();
    return out;
  }, [text]);
  const shown = all ? lines : lines.slice(0, MAX);
  const bg = (l: string) =>
    l.startsWith("+") ? (t.dark ? "rgba(152,195,121,0.14)" : "rgba(64,160,43,0.12)") : l.startsWith("-") ? (t.dark ? "rgba(224,108,117,0.14)" : "rgba(210,15,57,0.10)") : "transparent";
  return (
    <View style={[st.box, { borderColor: t.border, backgroundColor: t.surface }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ minWidth: "100%", paddingVertical: 4 }}>
          {shown.map((l, i) =>
            l.startsWith("@@") ? (
              <Text key={i} style={[st.hunk, { color: t.accent, backgroundColor: t.codeBg }]}>{l.replace(/^(@@[^@]*@@).*/, "$1")}</Text>
            ) : (
              <Text key={i} style={[st.line, { backgroundColor: bg(l), color: l.startsWith("+") || l.startsWith("-") ? t.text : t.muted }]}>
                <Text style={{ color: l.startsWith("+") ? t.success : l.startsWith("-") ? t.error : t.faint }}>{l[0] === "\\" ? "" : l[0] ?? " "} </Text>
                {l.slice(1) || " "}
              </Text>
            ),
          )}
          {!lines.length ? <Text style={[st.line, { color: t.faint }]}>No textual changes</Text> : null}
        </View>
      </ScrollView>
      {lines.length > MAX && !all ? (
        <Pressable onPress={() => setAll(true)} style={st.more}>
          <Text style={{ color: t.accent, fontFamily: ui, fontSize: 13 }}>Show all {lines.length} lines</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 6, overflow: "hidden", marginTop: 6, marginBottom: 4 },
  line: { fontFamily: mono, fontSize: 12, lineHeight: 18, paddingHorizontal: 10 },
  hunk: { fontFamily: mono, fontSize: 11.5, lineHeight: 20, paddingHorizontal: 10, marginVertical: 2 },
  more: { padding: 8, alignItems: "center" },
});
