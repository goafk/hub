// Transcript entries rendered the way Zed's agent panel shows them.
import React, { memo, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { Entry, PendingElicitation } from "../lib/api";
import { DiffView } from "./Diff";
import { AskedSummary, QuestionCard } from "./Question";
import { mono, ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { Markdown } from "./Markdown";
import { ArrowUpIcon, BrainIcon, CheckIcon, ChevronDown, ChevronRight, CopyIcon, ToolIcon, ToolKindIcon, UserUpIcon, XIcon } from "./Icons";

type EntryProps = {
  entry: Entry;
  turnEnd?: string;
  onCopied?: () => void;
  /** A pending agent question tied to this tool call: rendered inline as an interactive card. */
  question?: PendingElicitation;
  agentName?: string;
  /** Current "find in thread" hit. */
  highlight?: boolean;
  onAnswer?: (q: PendingElicitation, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => Promise<void>;
};

export const EntryView = memo(function EntryView(props: EntryProps) {
  const t = useTheme();
  if (!props.highlight) return <EntryBody {...props} />;
  return (
    <View style={{ borderLeftWidth: 3, borderLeftColor: t.accent, paddingLeft: 8, marginLeft: -11, backgroundColor: t.dark ? "rgba(198,120,221,0.07)" : "rgba(136,57,239,0.05)" }}>
      <EntryBody {...props} />
    </View>
  );
});

function EntryBody({ entry, turnEnd, onCopied, question, agentName, onAnswer }: EntryProps) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  switch (entry.kind) {
    case "user":
      return <UserMessage text={entry.text ?? ""} s={s} />;
    case "agent":
      return (
        <View style={s.agent}>
          <Markdown text={entry.text ?? ""} />
          {turnEnd !== undefined ? <TurnFooter text={turnEnd} s={s} t={t} onCopied={onCopied} /> : null}
        </View>
      );
    case "thought":
      return <Thought text={entry.text ?? ""} s={s} t={t} />;
    case "tool_call": {
      if (question && onAnswer) {
        return (
          <View>
            <View style={s.askHead}>
              <ToolIcon color={t.muted} size={15} />
              <Text style={s.askTitle}>{entry.title ?? "Asking for your input"}</Text>
            </View>
            <QuestionCard pending={question} agentName={agentName} onAnswer={(a, c) => onAnswer(question, a, c)} />
          </View>
        );
      }
      const asked = entry.data?.rawInput?.questions;
      if (Array.isArray(asked) && asked.length && /question|input/i.test(`${entry.data?.name ?? ""} ${entry.title ?? ""}`)) {
        return <AskedSummary questions={asked} answer={contentTexts(entry.data?.content).join("\n") || undefined} />;
      }
      return <ToolCall entry={entry} s={s} t={t} />;
    }
    case "plan":
      return <Plan entries={entry.data ?? []} s={s} t={t} />;
    default:
      return null;
  }
}

function UserMessage({ text, s }: { text: string; s: St }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 600 || text.split("\n").length > 12;
  return (
    <Pressable disabled={!long} onPress={() => setOpen((o) => !o)} style={s.user}>
      <Text style={s.userText} numberOfLines={long && !open ? 10 : undefined} selectable>
        {/* @-mentions shown like Zed's context chips */}
        {text.split(/(@[\w./~-]+|\[image\])/g).map((part, i) =>
          part === "[image]" ? (
            <Text key={i} style={s.mention}>🖼 image</Text>
          ) : part.startsWith("@") && part.length > 1 ? (
            <Text key={i} style={s.mention}>{part}</Text>
          ) : (
            part
          ),
        )}
      </Text>
      {long ? <Text style={s.more}>{open ? "Show less" : "Show more"}</Text> : null}
    </Pressable>
  );
}

function TurnFooter({ text, s, t, onCopied }: { text: string; s: St; t: Theme; onCopied?: () => void }) {
  return (
    <View style={s.footer}>
      <Pressable hitSlop={8} onPress={async () => { await Clipboard.setStringAsync(text); onCopied?.(); }}>
        <CopyIcon color={t.faint} size={17} />
      </Pressable>
      <UserUpIcon color={t.faint} size={17} />
      <ArrowUpIcon color={t.faint} size={17} />
    </View>
  );
}

function Thought({ text, s, t }: { text: string; s: St; t: Theme }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={s.thought}>
      <Pressable onPress={() => setOpen((o) => !o)} style={s.thoughtHead}>
        <BrainIcon color={t.faint} size={15} />
        <Text style={s.thoughtLabel}>Thinking</Text>
        {open ? <ChevronDown color={t.faint} size={14} /> : <ChevronRight color={t.faint} size={14} />}
      </Pressable>
      {open ? <Text style={s.thoughtText} selectable>{text}</Text> : null}
    </View>
  );
}

/** Text parts of ACP tool-call content blocks. */
function contentTexts(content: any): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((c: any) => (c?.type === "content" && c.content?.type === "text" && c.content.text ? [c.content.text] : []));
}

/** Short, readable form of a tool's raw input (instead of a JSON dump). */
function inputSummary(input: any): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (input.command) return String(input.command);
  const lines = Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return lines.join("\n");
}

function ToolCall({ entry, s, t }: { entry: Entry; s: St; t: Theme }) {
  const title = entry.title ?? entry.data?.title ?? "Tool call";
  const diffs: any[] = (entry.data?.content ?? []).filter((c: any) => c?.type === "diff");
  const texts = contentTexts(entry.data?.content);
  // Edits show their diff right away, like Zed's edit cards; other tools expand on tap.
  const [open, setOpen] = useState(diffs.length > 0);
  const running = entry.status === "pending" || entry.status === "in_progress";
  const failed = entry.status === "failed";
  const input = inputSummary(entry.data?.rawInput);
  const output = texts.join("\n").trim();
  return (
    <View style={s.tool}>
      <Pressable onPress={() => setOpen((o) => !o)} style={s.toolHead}>
        <ToolKindIcon title={title} color={t.muted} size={15} />
        <Text style={s.toolTitle} numberOfLines={open ? 3 : 1}>{title}</Text>
        {running ? <ActivityIndicator size="small" color={t.faint} style={{ transform: [{ scale: 0.6 }] }} /> : failed ? <XIcon color={t.error} size={14} /> : <CheckIcon color={t.faint} size={14} />}
      </Pressable>
      {open ? (
        <View style={s.toolOpen}>
          {diffs.map((d, i) => <DiffView key={i} path={d.path} oldText={d.oldText} newText={d.newText} />)}
          {!diffs.length && input && input !== title ? <Text style={s.toolBody} selectable numberOfLines={20}>{input}</Text> : null}
          {output ? (
            <Text style={[s.toolBody, s.toolOutput]} selectable numberOfLines={30}>{output}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Plan({ entries, s, t }: { entries: any[]; s: St; t: Theme }) {
  return (
    <View style={s.plan}>
      <Text style={s.planTitle}>Plan</Text>
      {entries.map((p, i) => (
        <View key={i} style={s.planRow}>
          <Text style={[s.planMark, p.status === "completed" && { color: t.success }]}>{p.status === "completed" ? "✓" : p.status === "in_progress" ? "◐" : "○"}</Text>
          <Text style={[s.planText, p.status === "completed" && { color: t.muted, textDecorationLine: "line-through" }]}>{p.content}</Text>
        </View>
      ))}
    </View>
  );
}

type St = ReturnType<typeof styles>;

function styles(t: Theme) {
  return StyleSheet.create({
    user: { borderWidth: 1, borderColor: t.borderStrong, backgroundColor: t.surface, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 14, marginVertical: 10 },
    userText: { fontFamily: mono, fontSize: 14.5, lineHeight: 23, color: t.text },
    mention: { color: t.accent, backgroundColor: t.dark ? "rgba(198,120,221,0.14)" : "rgba(136,57,239,0.09)", borderRadius: 4 },
    more: { marginTop: 6, fontSize: 13, color: t.accent, fontFamily: ui },
    agent: { paddingHorizontal: 4, paddingTop: 6 },
    footer: { flexDirection: "row", justifyContent: "flex-end", gap: 20, paddingVertical: 8, paddingRight: 4 },
    thought: { marginVertical: 4, paddingHorizontal: 4 },
    thoughtHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
    thoughtLabel: { fontSize: 14, color: t.faint, fontFamily: ui },
    thoughtText: { fontSize: 14, lineHeight: 21, color: t.muted, fontFamily: ui, paddingLeft: 23, paddingTop: 4, fontStyle: "italic" },
    tool: { marginVertical: 3, borderWidth: 1, borderColor: t.border, borderRadius: 6, backgroundColor: t.dark ? t.sidebar : "#EBEEF3" },
    toolHead: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 10, paddingVertical: 7, minHeight: 34 },
    toolTitle: { flex: 1, fontFamily: mono, fontSize: 13, color: t.muted },
    askHead: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 4, paddingTop: 8 },
    askTitle: { fontSize: 15, color: t.muted, fontFamily: ui },
    toolOpen: { paddingHorizontal: 10, paddingBottom: 10, gap: 6 },
    toolBody: { fontFamily: mono, fontSize: 12, lineHeight: 18, color: t.muted },
    toolOutput: { backgroundColor: t.codeBg, borderRadius: 4, padding: 8, color: t.text },
    plan: { borderWidth: 1, borderColor: t.border, borderRadius: 8, padding: 12, marginVertical: 8 },
    planTitle: { fontSize: 13, color: t.muted, fontFamily: ui, marginBottom: 6 },
    planRow: { flexDirection: "row", gap: 8, paddingVertical: 2 },
    planMark: { width: 16, color: t.faint, fontSize: 14 },
    planText: { flex: 1, color: t.text, fontSize: 14.5, lineHeight: 21, fontFamily: ui },
  });
}
