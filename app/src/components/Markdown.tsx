// Markdown → React Native, styled like Zed's agent panel (headings, tables, code, links).
import React, { memo, useMemo, useState } from "react";
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { marked } from "marked";
import type { Token, Tokens } from "marked";
import { mono, ui, useTheme } from "../lib/theme";
import { CodeBlock, MermaidBlock } from "./CodeBlock";
import type { Theme } from "../lib/theme";

type Props = { text: string; size?: number };

export const Markdown = memo(function Markdown({ text, size = 15.5 }: Props) {
  const t = useTheme();
  const tokens = useMemo(() => {
    try {
      return marked.lexer(withFootnotes(text ?? ""), { gfm: true, breaks: false });
    } catch {
      return [{ type: "paragraph", raw: text, text, tokens: [{ type: "text", raw: text, text }] } as any];
    }
  }, [text]);
  const s = useMemo(() => styles(t, size), [t, size]);
  return <View>{tokens.map((tok, i) => <Block key={i} tok={tok} s={s} t={t} first={i === 0} />)}</View>;
});

type St = ReturnType<typeof styles>;

function Block({ tok, s, t, first, tight }: { tok: Token; s: St; t: Theme; first?: boolean; tight?: boolean }): React.ReactElement | null {
  switch (tok.type) {
    case "heading": {
      const h = tok as Tokens.Heading;
      const hs = h.depth <= 1 ? s.h1 : h.depth === 2 ? s.h2 : h.depth === 3 ? s.h3 : s.h4;
      return <Text style={[hs, first && { marginTop: 0 }]}><Inline toks={h.tokens} s={s} /></Text>;
    }
    case "paragraph":
      return <Text style={tight ? s.pTight : s.p}><Inline toks={(tok as Tokens.Paragraph).tokens} s={s} /></Text>;
    case "text": {
      const tt = tok as Tokens.Text;
      return <Text style={tight ? s.pTight : s.p}>{tt.tokens ? <Inline toks={tt.tokens} s={s} /> : tt.text}</Text>;
    }
    case "code": {
      const c = tok as Tokens.Code;
      const lang = (c.lang ?? "").trim().split(/\s+/)[0];
      return lang === "mermaid" ? <MermaidBlock code={c.text} /> : <CodeBlock code={c.text} lang={lang} />;
    }
    case "blockquote":
      return (
        <View style={s.quote}>
          {(tok as Tokens.Blockquote).tokens.map((x, i) => <Block key={i} tok={x} s={s} t={t} />)}
        </View>
      );
    case "list": {
      const l = tok as Tokens.List;
      const start = typeof l.start === "number" ? l.start : 1;
      return (
        <View style={s.list}>
          {l.items.map((item, i) => (
            <View key={i} style={s.li}>
              {item.task ? (
                <View style={[s.task, item.checked && s.taskOn]}>{item.checked ? <Text style={s.taskMark}>✓</Text> : null}</View>
              ) : (
                <Text style={[s.bullet, l.ordered && s.ordinal]}>{l.ordered ? `${start + i}.` : "•"}</Text>
              )}
              <View style={{ flex: 1 }}>
                {item.tokens.map((x, j) => <Block key={j} tok={x} s={s} t={t} tight />)}
              </View>
            </View>
          ))}
        </View>
      );
    }
    case "table":
      return <Table tok={tok as Tokens.Table} s={s} />;
    case "hr":
      return <View style={s.hr} />;
    case "space":
      return null;
    case "html":
      return <Text style={s.p}>{(tok as Tokens.HTML).text}</Text>;
    default:
      return (tok as any).text ? <Text style={s.p}>{(tok as any).text}</Text> : null;
  }
}

function Table({ tok, s }: { tok: Tokens.Table; s: St }) {
  const [width, setWidth] = useState(0);
  const cols = tok.header.length;
  const texts = (c: number) => [tok.header[c]?.text ?? "", ...tok.rows.map((r) => r[c]?.text ?? "")];
  // Column widths follow content length, like Zed's auto-sized markdown tables…
  const weights = Array.from({ length: cols }, (_, c) => Math.min(Math.max(...texts(c).map((x) => x.length), 4), 60));
  // …and never break a word, unless the words can't all fit (then scale down evenly).
  let mins = Array.from({ length: cols }, (_, c) => Math.max(...texts(c).flatMap((x) => x.split(/\s+/)).map((w) => w.length), 3) * s.charW + 20);
  const total = mins.reduce((a, b) => a + b, 0);
  if (width && total > width) mins = mins.map((m) => (m * width) / total);
  return (
    <View style={s.table} onLayout={(e) => setWidth(e.nativeEvent.layout.width - 2)}>
      <View style={[s.tr, s.thead]}>
        {tok.header.map((h, c) => (
          <View key={c} style={[s.cell, { flex: weights[c], minWidth: mins[c] }, c > 0 && s.cellBorder]}>
            <Text style={s.th}><Inline toks={h.tokens} s={s} /></Text>
          </View>
        ))}
      </View>
      {tok.rows.map((row, r) => (
        <View key={r} style={[s.tr, s.rowBorder]}>
          {row.map((cell, c) => (
            <View key={c} style={[s.cell, { flex: weights[c], minWidth: mins[c] }, c > 0 && s.cellBorder]}>
              <Text style={[s.td, align(tok.align[c], "left")]}><Inline toks={cell.tokens} s={s} /></Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function Inline({ toks, s }: { toks?: Token[]; s: St }): React.ReactElement {
  return (
    <>
      {(toks ?? []).map((tok, i) => {
        switch (tok.type) {
          case "strong":
            return <Text key={i} style={s.strong}><Inline toks={(tok as Tokens.Strong).tokens} s={s} /></Text>;
          case "em":
            return <Text key={i} style={s.em}><Inline toks={(tok as Tokens.Em).tokens} s={s} /></Text>;
          case "del":
            return <Text key={i} style={s.del}><Inline toks={(tok as Tokens.Del).tokens} s={s} /></Text>;
          case "codespan": {
            const code = decode((tok as Tokens.Codespan).text);
            // Zed turns project file paths in inline code into links.
            const isPath = /^[\w.@~-]+(\/[\w.@-]+)+\.[A-Za-z0-9]+(:\d+)?$/.test(code);
            return <Text key={i} style={[s.code, isPath && s.pathLink]}>{code}</Text>;
          }
          case "link": {
            const l = tok as Tokens.Link;
            const onPress = /^https?:/.test(l.href) ? () => Linking.openURL(l.href) : undefined;
            const onlyCode = l.tokens?.length === 1 && l.tokens[0].type === "codespan";
            return (
              <Text key={i} style={[s.link, onlyCode && s.codeLink]} onPress={onPress}>
                {onlyCode ? decode((l.tokens[0] as Tokens.Codespan).text) : <Inline toks={l.tokens} s={s} />}
              </Text>
            );
          }
          case "checkbox":
            return null;
          case "br":
            return <Text key={i}>{"\n"}</Text>;
          case "escape":
          case "text": {
            const tt = tok as Tokens.Text;
            return tt.tokens ? <Inline key={i} toks={tt.tokens} s={s} /> : <Text key={i}>{decode(tt.text)}</Text>;
          }
          default:
            return <Text key={i}>{decode((tok as any).text ?? (tok as any).raw ?? "")}</Text>;
        }
      })}
    </>
  );
}

function align(a: string | null | undefined, fallback: "left" | "center"): { textAlign: "left" | "center" | "right" } {
  return { textAlign: a === "right" ? "right" : a === "center" ? "center" : a === "left" ? "left" : fallback };
}

/** GFM footnotes ([^id] refs + "[^id]: text" defs) → numbered refs and a list under a rule, like Zed. */
export function withFootnotes(md: string): string {
  const defs = new Map<string, string>();
  const body = md.replace(/^\[\^([^\]]+)\]:[ \t]*(.+)$/gm, (_m, id: string, text: string) => {
    defs.set(id, text);
    return "";
  });
  if (!defs.size) return md;
  const order: string[] = [];
  const out = body.replace(/\[\^([^\]]+)\]/g, (m, id: string) => {
    if (!defs.has(id)) return m;
    if (!order.includes(id)) order.push(id);
    return `[\\[${order.indexOf(id) + 1}\\]](#fn-${order.indexOf(id) + 1})`;
  });
  const notes = order.map((id, i) => `${i + 1}. ${defs.get(id)}`).join("\n");
  return `${out.trimEnd()}\n\n---\n\n${notes}\n`;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function styles(t: Theme, size: number) {
  const lh = Math.round(size * 1.62);
  const base = { color: t.text, fontSize: size, lineHeight: lh, fontFamily: ui };
  const sheet = StyleSheet.create({
    p: { ...base, marginBottom: 12 },
    pTight: { ...base, marginBottom: 2 },
    h1: { ...base, fontSize: size * 1.45, lineHeight: size * 1.9, marginTop: 18, marginBottom: 12, fontWeight: "500" },
    h2: { ...base, fontSize: size * 1.3, lineHeight: size * 1.75, marginTop: 18, marginBottom: 12, fontWeight: "400" },
    h3: { ...base, fontSize: size * 1.15, lineHeight: size * 1.6, marginTop: 14, marginBottom: 10, fontWeight: "500" },
    h4: { ...base, fontWeight: "600", marginTop: 12, marginBottom: 8 },
    strong: { fontWeight: "600" },
    em: { fontStyle: "italic" },
    del: { textDecorationLine: "line-through" },
    code: {
      fontFamily: mono,
      fontSize: size * 0.9,
      backgroundColor: t.codeBg,
      color: t.text,
      borderRadius: 4,
      ...(Platform.OS === "web" ? ({ paddingHorizontal: 4, paddingVertical: 1 } as any) : {}),
    },
    link: { color: t.link, textDecorationLine: "underline" },
    pathLink: { color: t.link, textDecorationLine: "underline" },
    codeLink: { fontFamily: mono, fontSize: size * 0.9, backgroundColor: t.codeBg, borderRadius: 4 },
    codeBlock: { backgroundColor: t.codeBg, borderRadius: 6, marginBottom: 12 },
    codeText: { fontFamily: mono, fontSize: size * 0.82, lineHeight: size * 1.35, color: t.text },
    quote: { borderLeftWidth: 3, borderLeftColor: t.borderStrong, paddingLeft: 12, marginBottom: 12 },
    list: { marginBottom: 8, paddingLeft: 10 },
    li: { flexDirection: "row", marginBottom: 2 },
    bullet: { ...base, width: 22, color: t.text, textAlign: "center", marginRight: 4 },
    ordinal: { width: 26, textAlign: "right", marginRight: 8 },
    task: { width: 20, height: 20, borderRadius: 4, borderWidth: 1, borderColor: t.borderStrong, backgroundColor: t.surface, marginTop: (lh - 20) / 2, marginRight: 10, alignItems: "center", justifyContent: "center" },
    taskOn: { backgroundColor: t.codeBg },
    taskMark: { color: t.accent, fontSize: 13, lineHeight: 16, fontWeight: "700" },
    table: { borderWidth: 1, borderColor: t.borderStrong, borderRadius: 4, marginBottom: 14, overflow: "hidden" },
    thead: { backgroundColor: t.tableHead },
    tr: { flexDirection: "row" },
    rowBorder: { borderTopWidth: 1, borderTopColor: t.borderStrong },
    cell: { paddingHorizontal: 9, paddingVertical: 6, justifyContent: "center" },
    cellBorder: { borderLeftWidth: 1, borderLeftColor: t.borderStrong },
    th: { ...base, fontWeight: "600", textAlign: "center" },
    td: { ...base },
    hr: { height: 1, backgroundColor: t.border, marginVertical: 14 },
  });
  // Approximate glyph width for sizing table columns.
  return { ...sheet, charW: size * 0.56 };
}
