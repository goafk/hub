'use no memo';
// Home-screen widgets. Widgets can't use hooks or regular RN views — only the library's primitives.
// Surfaces follow Zed's themes (Catppuccin Latte / One Dark); depth comes from layered surface
// colors (widgets can't draw shadows) and nested corners are concentric: outer 24 = inner 12 + padding 12.
import React from "react";
import { FlexWidget, TextWidget } from "react-native-android-widget";

export type WidgetItem = { id: string; title: string; project: string; state: "input" | "running" | "done"; ago: string };
export type WidgetProject = { name: string; path: string };
export type WidgetData = { needs: number; running: number; items: WidgetItem[]; projects: WidgetProject[]; updatedAt: number; error?: string };

const T = {
  light: { base: "#EFF1F5", raised: "#E6E9EF", pressed: "#DCE0E8", text: "#4C4F69", muted: "#6C6F85", faint: "#8C8FA1", accent: "#8839EF", warn: "#DF8E1D", warnBg: "#F6E7CF", accentBg: "#E9DDFB", ok: "#40A02B", okBg: "#DCEDD6" },
  dark: { base: "#282C34", raised: "#2F343E", pressed: "#3A404B", text: "#D7DAE0", muted: "#9DA5B4", faint: "#7F848E", accent: "#C678DD", warn: "#E5C07B", warnBg: "#3B3628", accentBg: "#3A3145", ok: "#98C379", okBg: "#2E3A2B" },
} as const;
type Pal = (typeof T)["light"] | (typeof T)["dark"];

const OUTER = 24;
const PAD = 12;
const INNER = OUTER - PAD; // concentric

const STATE = {
  input: { label: "needs you", glyph: "!" },
  running: { label: "working", glyph: "•••" },
  done: { label: "finished", glyph: "✓" },
} as const;

function stateColor(s: WidgetItem["state"], c: Pal) {
  return s === "input" ? { fg: c.warn, bg: c.warnBg } : s === "done" ? { fg: c.accent, bg: c.accentBg } : { fg: c.muted, bg: c.pressed };
}

function Pill({ text, fg, bg }: { text: string; fg: string; bg: string }) {
  return (
    <FlexWidget style={{ backgroundColor: bg as any, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
      <TextWidget text={text} style={{ fontSize: 12.5, color: fg as any, fontWeight: "600" }} />
    </FlexWidget>
  );
}

function Header({ data, c }: { data: WidgetData; c: Pal }) {
  return (
    <FlexWidget style={{ width: "match_parent", flexDirection: "row", alignItems: "center", flexGap: 6 }}>
      <TextWidget text="✳" style={{ fontSize: 18, color: c.accent }} />
      <TextWidget text="Zed agents" style={{ fontSize: 16.5, color: c.text, fontWeight: "600" }} />
      <FlexWidget style={{ flex: 1 }} />
      {data.needs ? <Pill text={`${data.needs} need you`} fg={c.warn} bg={c.warnBg} /> : null}
      {data.running ? <Pill text={`${data.running} running`} fg={c.muted} bg={c.raised} /> : null}
      {/* Refresh: a 40dp target around a small glyph. */}
      <FlexWidget clickAction="REFRESH" style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center", marginRight: -10 }}>
        <TextWidget text="↻" style={{ fontSize: 17, color: c.faint }} />
      </FlexWidget>
    </FlexWidget>
  );
}

function Row({ it, c }: { it: WidgetItem; c: Pal }) {
  const sc = stateColor(it.state, c);
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: `zedthreads://thread/${encodeURIComponent(it.id)}` }}
      style={{ width: "match_parent", flexDirection: "row", alignItems: "center", flexGap: 10, backgroundColor: c.raised, borderRadius: INNER, paddingHorizontal: 10, paddingVertical: 8 }}
    >
      <FlexWidget style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: sc.bg as any, alignItems: "center", justifyContent: "center" }}>
        <TextWidget text={STATE[it.state].glyph} style={{ fontSize: it.state === "running" ? 9 : 12.5, color: sc.fg as any, fontWeight: "700" }} />
      </FlexWidget>
      <FlexWidget style={{ flex: 1, flexDirection: "column" }}>
        <TextWidget text={it.title} style={{ fontSize: 15, color: c.text, fontWeight: "500" }} maxLines={1} truncate="END" />
        <TextWidget text={`${it.project} · ${STATE[it.state].label} · ${it.ago}`} style={{ fontSize: 12.5, color: c.faint }} maxLines={1} truncate="END" />
      </FlexWidget>
    </FlexWidget>
  );
}

function Empty({ data, c }: { data: WidgetData; c: Pal }) {
  return (
    <FlexWidget style={{ flex: 1, width: "match_parent", alignItems: "center", justifyContent: "center", flexDirection: "column", flexGap: 4 }}>
      <TextWidget text={data.error ? "⚠" : "✓"} style={{ fontSize: 20, color: data.error ? c.warn : c.ok, fontWeight: "700" }} />
      <TextWidget text={data.error ?? "All caught up"} style={{ fontSize: 13, color: data.error ? c.muted : c.text, fontWeight: "500", textAlign: "center" }} maxLines={2} />
      {!data.error && data.running ? <TextWidget text={`${data.running} agent${data.running === 1 ? "" : "s"} working`} style={{ fontSize: 11.5, color: c.faint }} /> : null}
    </FlexWidget>
  );
}

const HEADER = 46;
const ROW = 52;
const GAP = 6;
const FOOTER = 44;

/** Agents list sized to the space the launcher actually gives it: as many cards as fit, then an inbox bar. */
export function AgentsWidget({ data, dark, height = 150 }: { data: WidgetData; dark?: boolean; height?: number }) {
  const c = dark ? T.dark : T.light;
  const room = Math.max(0, height - HEADER - PAD);
  const fitAll = Math.max(1, Math.floor((room + GAP) / (ROW + GAP)));
  // Leave room for the footer bar when there are more threads than fit, unless that leaves no rows.
  const fitWithFooter = Math.floor((room - FOOTER) / (ROW + GAP));
  const items = data.error ? [] : data.items;
  const shown = items.slice(0, items.length <= fitAll || fitWithFooter < 1 ? fitAll : fitWithFooter);
  const more = items.length - shown.length;
  const showFooter = room - shown.length * (ROW + GAP) >= FOOTER - GAP;
  return (
    <FlexWidget
      clickAction="OPEN_APP"
      style={{ height: "match_parent", width: "match_parent", backgroundColor: c.base, borderRadius: OUTER, padding: PAD, paddingTop: 4, flexDirection: "column", flexGap: GAP }}
      accessibilityLabel={`Zed agents: ${data.needs} need you, ${data.running} running`}
    >
      <Header data={data} c={c} />
      {shown.length ? shown.map((it) => <Row key={it.id} it={it} c={c} />) : <Empty data={data} c={c} />}
      {shown.length ? <FlexWidget style={{ flex: 1 }} /> : null}
      {showFooter ? (
        <FlexWidget
          clickAction="OPEN_URI"
          clickActionData={{ uri: "zedthreads://inbox" }}
          style={{ width: "match_parent", height: 40, borderRadius: INNER, backgroundColor: c.raised, flexDirection: "row", alignItems: "center", justifyContent: "center", flexGap: 6 }}
        >
          <TextWidget text={more > 0 ? `+${more} more · Open inbox` : "Open inbox"} style={{ fontSize: 14, color: c.accent, fontWeight: "600" }} />
        </FlexWidget>
      ) : null}
    </FlexWidget>
  );
}

/** 2×2 counter: how many threads need you. */
export function NeedsYouWidget({ data, dark }: { data: WidgetData; dark?: boolean }) {
  const c = dark ? T.dark : T.light;
  const n = data.needs;
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: "zedthreads://inbox" }}
      style={{ height: "match_parent", width: "match_parent", borderRadius: OUTER, padding: 14, flexDirection: "column", backgroundGradient: { from: (n ? c.warnBg : c.base) as any, to: c.base as any, orientation: "TOP_BOTTOM" } }}
      accessibilityLabel={`${n} threads need you`}
    >
      <FlexWidget style={{ flexDirection: "row", alignItems: "center", flexGap: 5 }}>
        <TextWidget text="✳" style={{ fontSize: 13, color: c.accent }} />
        <TextWidget text="Zed" style={{ fontSize: 12.5, color: c.muted, fontWeight: "600" }} />
      </FlexWidget>
      <FlexWidget style={{ flex: 1 }} />
      <TextWidget text={data.error ? "–" : String(n)} style={{ fontSize: 48, color: (n ? c.warn : c.ok) as any, fontWeight: "700" }} />
      <TextWidget text={n === 1 ? "needs you" : n ? "need you" : "all caught up"} style={{ fontSize: 14, color: c.text, fontWeight: "500" }} />
      <TextWidget text={data.error ? "offline" : `${data.running} running`} style={{ fontSize: 11.5, color: c.faint, marginTop: 2 }} />
    </FlexWidget>
  );
}

/** 4×1: start a new thread in one of your recent projects. */
export function QuickStartWidget({ data, dark }: { data: WidgetData; dark?: boolean }) {
  const c = dark ? T.dark : T.light;
  const projects = data.projects.slice(0, 3);
  return (
    <FlexWidget
      style={{ height: "match_parent", width: "match_parent", backgroundColor: c.base, borderRadius: OUTER, paddingHorizontal: PAD, flexDirection: "row", alignItems: "center", flexGap: 8 }}
      accessibilityLabel="Start a new agent thread"
    >
      <FlexWidget clickAction="OPEN_APP" style={{ height: 40, justifyContent: "center", flexDirection: "column" }}>
        <TextWidget text="✳ New" style={{ fontSize: 15, color: c.accent, fontWeight: "700" }} />
        <TextWidget text="thread in" style={{ fontSize: 11, color: c.faint }} />
      </FlexWidget>
      {projects.length ? (
        projects.map((p) => (
          <FlexWidget
            key={p.path}
            clickAction="OPEN_URI"
            clickActionData={{ uri: `zedthreads://new?cwd=${encodeURIComponent(p.path)}` }}
            style={{ flex: 1, height: 40, borderRadius: INNER, backgroundColor: c.raised, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 }}
          >
            <TextWidget text={p.name} style={{ fontSize: 14, color: c.text, fontWeight: "500" }} maxLines={1} truncate="END" />
          </FlexWidget>
        ))
      ) : (
        <TextWidget text={data.error ?? "Open the app once to load projects"} style={{ fontSize: 12, color: c.muted }} maxLines={2} />
      )}
    </FlexWidget>
  );
}

export type WidgetSize = { width: number; height: number };

export const WIDGETS = {
  Agents: (d: WidgetData, dark?: boolean, size?: WidgetSize) => <AgentsWidget data={d} dark={dark} height={size?.height ?? 150} />,
  AgentsLarge: (d: WidgetData, dark?: boolean, size?: WidgetSize) => <AgentsWidget data={d} dark={dark} height={size?.height ?? 300} />,
  NeedsYou: (d: WidgetData, dark?: boolean) => <NeedsYouWidget data={d} dark={dark} />,
  QuickStart: (d: WidgetData, dark?: boolean) => <QuickStartWidget data={d} dark={dark} />,
} as const;
export type WidgetName = keyof typeof WIDGETS;
