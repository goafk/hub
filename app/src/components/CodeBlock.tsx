// Fenced code blocks like Zed's: highlighted, horizontal scroll with a wrap toggle and copy,
// diff blocks colored per line, and mermaid diagrams with Preview / Code tabs.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { colorFor, tokenize } from "../lib/highlight";
import { mono, ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { CheckIcon, CopyIcon, WrapIcon } from "./Icons";

function CopyButton({ text, t }: { text: string; t: Theme }) {
  const [done, setDone] = useState(false);
  return (
    <Pressable
      hitSlop={8}
      onPress={async () => {
        await Clipboard.setStringAsync(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <CheckIcon color={t.success} size={15} /> : <CopyIcon color={t.muted} size={15} />}
    </Pressable>
  );
}

export function CodeBlock({ code, lang, size = 14 }: { code: string; lang?: string; size?: number }) {
  const t = useTheme();
  const s = useMemo(() => styles(t, size), [t, size]);
  const [wrap, setWrap] = useState(false);
  const isDiff = lang === "diff" || lang === "patch";
  const spans = useMemo(() => (isDiff ? [] : tokenize(code, lang)), [code, lang, isDiff]);
  const body = isDiff ? (
    code.split("\n").map((line, i) => (
      <Text key={i} style={[s.text, { color: line.startsWith("+") ? t.success : line.startsWith("-") ? t.error : line.startsWith("@@") ? t.accent : t.text }]}>
        {line || " "}
      </Text>
    ))
  ) : (
    <Text style={s.text} selectable>
      {spans.map((sp, i) => {
        const c = colorFor(sp.types, t);
        return c ? <Text key={i} style={{ color: c }}>{sp.text}</Text> : sp.text;
      })}
    </Text>
  );
  return (
    <View style={s.box}>
      <View style={s.tools}>
        <Pressable hitSlop={8} onPress={() => setWrap((w) => !w)}>
          <WrapIcon color={wrap ? t.accent : t.muted} size={15} />
        </Pressable>
        <CopyButton text={code} t={t} />
      </View>
      {wrap ? (
        <View style={s.pad}>{body}</View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={s.pad}>
          <View>{body}</View>
        </ScrollView>
      )}
    </View>
  );
}

function mermaidHtml(code: string, dark: boolean, id: string): string {
  const esc = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:8px;background:transparent;overflow-x:auto}</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></head>
<body><pre class="mermaid">${esc}</pre><script>
mermaid.initialize({startOnLoad:false, theme:${JSON.stringify(dark ? "dark" : "neutral")}, securityLevel:"strict"});
mermaid.run().then(function(){ send(); }).catch(function(e){ document.body.innerText = String(e && e.message || e); send(); });
function send(){ var m = JSON.stringify({id:${JSON.stringify(id)}, h: document.body.scrollHeight});
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(m); else parent.postMessage(m, "*"); }
</script></body></html>`;
}

let seq = 0;

/** Mermaid diagrams: Preview (rendered in a web view) / Code tabs, like Zed. */
export function MermaidBlock({ code }: { code: string }) {
  const t = useTheme();
  const s = useMemo(() => styles(t, 14), [t]);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [height, setHeight] = useState(160);
  const id = useRef(`m${++seq}`).current;
  const html = useMemo(() => mermaidHtml(code, t.dark, id), [code, t.dark, id]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onMsg = (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data);
        if (d.id === id) setHeight(Math.min(Math.max(d.h + 4, 60), 900));
      } catch {}
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [id]);

  let preview: React.ReactNode;
  if (Platform.OS === "web") {
    preview = React.createElement("iframe", { srcDoc: html, sandbox: "allow-scripts", style: { border: 0, width: "100%", height, background: "transparent" } });
  } else {
    const { WebView } = require("react-native-webview");
    preview = (
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        style={{ height, backgroundColor: "transparent" }}
        scrollEnabled={false}
        onMessage={(e: any) => {
          try {
            setHeight(Math.min(Math.max(JSON.parse(e.nativeEvent.data).h + 4, 60), 900));
          } catch {}
        }}
      />
    );
  }

  return (
    <View style={s.box}>
      <View style={s.tabs}>
        {(["preview", "code"] as const).map((k) => (
          <Pressable key={k} onPress={() => setTab(k)} style={[s.tab, tab === k && s.tabOn]}>
            <Text style={[s.tabText, tab === k && { color: t.accent }]}>{k === "preview" ? "Preview" : "Code"}</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        <CopyButton text={code} t={t} />
      </View>
      {tab === "preview" ? <View style={{ paddingHorizontal: 4, paddingBottom: 6 }}>{preview}</View> : <CodeBlock code={code} />}
    </View>
  );
}

function styles(t: Theme, size: number) {
  return StyleSheet.create({
    box: { backgroundColor: t.surface, borderRadius: 8, borderWidth: 1, borderColor: t.border, marginBottom: 12, overflow: "hidden" },
    tools: { position: "absolute", top: 8, right: 10, zIndex: 2, flexDirection: "row", gap: 14, backgroundColor: t.surface, paddingLeft: 6 },
    pad: { paddingHorizontal: 14, paddingVertical: 12, paddingRight: 64 },
    text: { fontFamily: mono, fontSize: size * 0.92, lineHeight: size * 1.75, color: t.text },
    tabs: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 6 },
    tab: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5 },
    tabOn: { backgroundColor: t.dark ? "rgba(97,175,239,0.15)" : "rgba(4,165,229,0.15)" },
    tabText: { fontSize: 14.5, color: t.text, fontFamily: ui },
  });
}
