// Zed's message editor: monospace input, + / context icons, config dropdowns, toggles, send.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ConfigOption } from "../lib/api";
import { mono, ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { CheckIcon, ChevronDown, ExpandIcon, FileIcon, FolderIcon, PlusIcon, SendIcon, StopIcon, XIcon, BoltIcon } from "./Icons";
import { pickImages } from "../lib/images";
import type { Attachment } from "../lib/images";
import { Sheet } from "./Sheet";
import { formatTokens } from "./PlanBar";

type Choice = { value: string; name?: string; description?: string; group?: string };

export function flatOptions(o: ConfigOption): Choice[] {
  const out: Choice[] = [];
  for (const x of o.options ?? []) {
    if ("options" in x && Array.isArray(x.options)) for (const y of x.options) out.push({ ...y, group: x.name ?? x.group });
    else out.push(x as Choice);
  }
  return out;
}

const ON = new Set(["on", "true", "enabled", "yes"]);
const OFF = new Set(["off", "false", "disabled", "no"]);

/** Two-valued on/off options (e.g. Fast mode) render as a switch like Zed. */
export function isToggle(o: ConfigOption): boolean {
  if (typeof o.currentValue === "boolean") return true;
  const vals = flatOptions(o).map((c) => String(c.value).toLowerCase());
  return vals.length === 2 && vals.some((v) => ON.has(v)) && vals.some((v) => OFF.has(v));
}

const ORDER: Record<string, number> = { mode: 0, model: 1, thought_level: 2 };

type Props = {
  agentName: string;
  options: ConfigOption[];
  running: boolean;
  disabled?: boolean;
  onSend: (text: string, mentions: string[], images?: Attachment[]) => Promise<void>;
  onCancel: () => void;
  onConfig: (id: string, value: string) => Promise<void>;
  /** The agent's slash commands, shown in a popup while typing "/…". */
  commands?: SlashCommand[];
  /** Context usage reported by the agent ({ used, size, cost }). */
  usage?: { used?: number; size?: number; cost?: { amount: number; currency: string } };
  /** Project file search for "@" mentions. */
  searchFiles?: (q: string) => Promise<FileHit[]>;
};

export type SlashCommand = { name: string; description?: string; input?: { hint?: string } | null };
export type FileHit = { path: string; dir: boolean };

/** Fuzzy subsequence score (name prefix > substring > scattered letters); -1 = no match. */
export function fuzzy(candidate: string, q: string): number {
  const c = candidate.toLowerCase();
  if (!q) return 0;
  if (c.startsWith(q)) return 1000 - c.length;
  if (c.includes(q)) return 500 - c.length;
  let at = 0;
  let score = 0;
  for (const ch of q) {
    const i = c.indexOf(ch, at);
    if (i < 0) return -1;
    score += i === at ? 12 : 4;
    at = i + 1;
  }
  return score;
}

/** Commands matching a "/query" being typed (name first, then description), or [] when not typing one. */
export function matchCommands(text: string, commands: SlashCommand[]): SlashCommand[] {
  const m = /^\/(\S*)$/.exec(text);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return commands
    .map((c) => {
      const byName = fuzzy(c.name, q);
      const byDesc = q.length > 2 && (c.description ?? "").toLowerCase().includes(q) ? 100 : -1;
      return { c, s: Math.max(byName, byDesc) };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
    .map((x) => x.c);
}

/** The "@query" being typed at the end of the message, or null. */
export function mentionQuery(text: string): string | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text);
  return m ? m[2] : null;
}

/** One-tap replies for steering an agent from the phone. */
export const QUICK_REPLIES = ["Continue", "Yes, do it", "Run the tests", "Commit it", "Explain what you changed"];

type MenuItem = { kind: "cmd"; cmd: SlashCommand } | { kind: "file"; file: FileHit };

export function Composer({ agentName, options, running, disabled, onSend, onCancel, onConfig, commands = [], searchFiles, usage }: Props) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const [text, setText] = useState("");
  const [big, setBig] = useState(false);
  const [sending, setSending] = useState(false);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<ConfigOption | null>(null);
  const [busyOpt, setBusyOpt] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [mentions, setMentions] = useState<string[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [images, setImages] = useState<Attachment[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const attach = async (source: "library" | "camera") => {
    setAttachOpen(false);
    try {
      const picked = await pickImages(source);
      setImages((cur) => [...cur, ...picked].slice(0, 6));
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const inputRef = useRef<TextInput>(null);

  const atQ = mentionQuery(text);
  useEffect(() => {
    if (atQ === null || !searchFiles) return setFiles([]);
    let live = true;
    const tm = setTimeout(() => {
      searchFiles(atQ).then((r) => live && setFiles(r), () => live && setFiles([]));
    }, 120);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [atQ, searchFiles]);

  const items: MenuItem[] = useMemo(() => {
    const cmds = matchCommands(text, commands);
    if (cmds.length) return cmds.map((cmd) => ({ kind: "cmd" as const, cmd }));
    return atQ !== null ? files.map((file) => ({ kind: "file" as const, file })) : [];
  }, [text, commands, atQ, files]);

  const pick = (it: MenuItem) => {
    if (it.kind === "cmd") setText(`/${it.cmd.name} `);
    else {
      setText((x) => x.replace(/@([^\s@]*)$/, `@${it.file.path} `));
      setMentions((m) => (m.includes(it.file.path) ? m : [...m, it.file.path]));
    }
    setSel(0);
    inputRef.current?.focus();
  };

  // "+" adds context like Zed's: a photo, a screenshot, or an @-mentioned file.
  const addContext = () => setAttachOpen(true);
  const startMention = () => {
    setText((x) => (x && !/\s$/.test(x) ? `${x} @` : `${x}@`));
    inputRef.current?.focus();
  };

  const selects = options.filter((o) => !isToggle(o)).sort((a, b) => (ORDER[a.category ?? ""] ?? 9) - (ORDER[b.category ?? ""] ?? 9));
  const toggles = options.filter(isToggle);

  const send = async () => {
    const msg = text.trim() || (images.length ? "What do you see in this image?" : "");
    if (!msg || sending) return;
    setSending(true);
    setErr(null);
    try {
      await onSend(msg, mentions.filter((m) => msg.includes(`@${m}`)), images);
      setText("");
      setMentions([]);
      setImages([]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  };

  const setOpt = async (o: ConfigOption, value: string) => {
    setOpen(null);
    setBusyOpt(o.id);
    setErr(null);
    try {
      await onConfig(o.id, value);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusyOpt(null);
    }
  };

  const label = (o: ConfigOption) => {
    const c = flatOptions(o).find((x) => String(x.value) === String(o.currentValue));
    return c?.name ?? String(o.currentValue);
  };

  const canSend = (!!text.trim() || images.length > 0) && !disabled && !sending;

  return (
    <View style={s.root}>
      {!text && (!running || quickBusy) && !disabled ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.quick} keyboardShouldPersistTaps="always">
          {QUICK_REPLIES.map((q) => (
            <Pressable
              key={q}
              disabled={sending}
              onPress={() => {
                setSending(true);
                setQuickBusy(q);
                setErr(null);
                onSend(q, [])
                  .catch((e) => setErr(e.message))
                  .finally(() => {
                    setSending(false);
                    setQuickBusy(null);
                  });
              }}
              style={({ pressed }) => [
                s.quickChip,
                pressed && { backgroundColor: t.hover, transform: [{ scale: 0.96 }] },
                quickBusy === q && { borderColor: t.accent },
                quickBusy !== null && quickBusy !== q && { opacity: 0.45 },
              ]}
            >
              {quickBusy === q ? <ActivityIndicator size="small" color={t.accent} style={{ transform: [{ scale: 0.7 }], marginVertical: -4 }} /> : null}
              <Text style={[s.quickText, quickBusy === q && { color: t.accent }]}>{q}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {items.length ? (
        <View style={s.cmdMenu}>
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 280 }}>
            {items.map((it, i) => (
              <Pressable
                key={it.kind === "cmd" ? `c:${it.cmd.name}` : `f:${it.file.path}`}
                onPress={() => pick(it)}
                style={({ pressed }) => [s.cmdRow, (i === sel || pressed) && { backgroundColor: t.selected }]}
              >
                {it.kind === "cmd" ? (
                  <>
                    <Text style={s.cmdName}>/{it.cmd.name}</Text>
                    {it.cmd.description ? <Text style={s.cmdDesc} numberOfLines={2}>{it.cmd.description}</Text> : null}
                  </>
                ) : (
                  <View style={s.fileRow}>
                    {it.file.dir ? <FolderIcon color={t.muted} size={15} /> : <FileIcon color={t.muted} size={15} />}
                    <Text style={s.fileName} numberOfLines={1}>{it.file.path.replace(/\/$/, "").split("/").pop()}</Text>
                    <Text style={s.fileDir} numberOfLines={1}>{it.file.path.replace(/\/$/, "").split("/").slice(0, -1).join("/")}</Text>
                  </View>
                )}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      {images.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.thumbs}>
          {images.map((im, i) => (
            <View key={im.uri + i} style={s.thumbWrap}>
              <Image source={{ uri: im.uri }} style={s.thumb} />
              <Pressable hitSlop={8} onPress={() => setImages((cur) => cur.filter((_, j) => j !== i))} style={s.thumbX}>
                <XIcon color="#fff" size={11} strokeWidth={2.6} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}
      <View style={s.inputRow}>
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={(v) => {
            setText(v);
            setSel(0);
          }}
          placeholder={`Message ${agentName} — @ to include context, / for commands`}
          placeholderTextColor={t.faint}
          style={[s.input, big && { minHeight: 220 }]}
          multiline
          editable={!disabled}
          textAlignVertical="top"
          onKeyPress={(e: any) => {
            const key = e.nativeEvent.key;
            // Web keyboard: arrows/Tab/Enter drive the command menu; Enter sends, Shift+Enter is a newline.
            if (items.length && (key === "ArrowDown" || key === "ArrowUp")) {
              e.preventDefault?.();
              setSel((x) => (x + (key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
              return;
            }
            if (items.length && (key === "Tab" || (key === "Enter" && !e.nativeEvent.shiftKey))) {
              e.preventDefault?.();
              pick(items[Math.min(sel, items.length - 1)]);
              return;
            }
            if (items.length && key === "Escape") {
              setText(text + " ");
              return;
            }
            if (key === "Enter" && !e.nativeEvent.shiftKey && typeof document !== "undefined") {
              e.preventDefault?.();
              send();
            }
          }}
        />
        <View style={s.inputSide}>
          <Pressable hitSlop={8} onPress={() => setBig((b) => !b)} style={s.expand} accessibilityLabel="Expand editor">
            <ExpandIcon color={t.faint} size={16} />
          </Pressable>
          {usage?.used && usage?.size ? (
            <Pressable onPress={() => setShowUsage((v) => !v)} hitSlop={8} accessibilityLabel={`Context ${formatTokens(usage.used)} of ${formatTokens(usage.size)}`}>
              <Text style={[s.usageText, usage.used / usage.size > 0.8 && { color: t.warning }]}>{`${Math.round((usage.used / usage.size) * 100)}%`}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {err ? <Text style={s.err} numberOfLines={3}>{err}</Text> : null}
      {showUsage && usage?.used && usage?.size ? (
        <Text style={[s.usageText, { alignSelf: "flex-end", marginTop: 4 }]}>
          Context {formatTokens(usage.used)} / {formatTokens(usage.size)}
          {usage.cost ? ` · $${usage.cost.amount.toFixed(2)} this thread` : ""}
        </Text>
      ) : null}
      {/* One toolbar: attach · mode / model / effort · Fast · context usage · send. */}
      <View style={s.toolbar}>
        <Pressable onPress={addContext} disabled={disabled} style={s.toolBtn} accessibilityLabel="Add photo or file">
          <PlusIcon color={t.muted} size={19} />
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} style={{ flex: 1 }} keyboardShouldPersistTaps="always">
          {selects.map((o) => (
            <Pressable key={o.id} onPress={() => setOpen(o)} style={({ pressed }) => [s.chip, pressed && { backgroundColor: t.hover }]} disabled={disabled}>
              {busyOpt === o.id ? <ActivityIndicator size="small" color={t.faint} style={{ transform: [{ scale: 0.6 }] }} /> : null}
              <Text style={s.chipText} numberOfLines={1}>{label(o)}</Text>
              <ChevronDown color={t.muted} size={13} />
            </Pressable>
          ))}
        </ScrollView>
        {toggles.map((o) => {
          const on = typeof o.currentValue === "boolean" ? o.currentValue : ON.has(String(o.currentValue).toLowerCase());
          const target = flatOptions(o).find((c) => (on ? OFF : ON).has(String(c.value).toLowerCase()));
          return (
            <Pressable
              key={o.id}
              disabled={disabled || busyOpt === o.id}
              onPress={() => setOpt(o, target ? String(target.value) : String(!on))}
              accessibilityRole="switch"
              accessibilityLabel={o.name ?? o.id}
              accessibilityState={{ checked: on }}
              style={({ pressed }) => [s.chip, s.toggleChip, on && { borderColor: t.accent, backgroundColor: t.accent + "22" }, pressed && { transform: [{ scale: 0.96 }] }]}
            >
              {busyOpt === o.id ? <ActivityIndicator size="small" color={t.faint} style={{ transform: [{ scale: 0.6 }] }} /> : null}
              {/fast/i.test(`${o.id} ${o.name ?? ""}`) ? (
                <BoltIcon color={on ? t.accent : t.muted} size={16} />
              ) : (
                <Text style={[s.chipText, { color: on ? t.accent : t.muted }]} numberOfLines={1}>
                  {(o.name ?? o.id).replace(/\s*mode$/i, "")}
                </Text>
              )}
            </Pressable>
          );
        })}
        {running && !canSend ? (
          <Pressable onPress={onCancel} style={[s.send, { backgroundColor: t.hover }]} accessibilityLabel="Stop">
            <StopIcon color={t.error} size={17} />
          </Pressable>
        ) : (
          <Pressable onPress={send} disabled={!canSend} style={[s.send, canSend && { backgroundColor: t.accent }]} accessibilityLabel="Send">
            {sending ? <ActivityIndicator size="small" color={t.faint} /> : <SendIcon color={canSend ? "#FFFFFF" : t.faint} size={18} />}
          </Pressable>
        )}
      </View>

      <Sheet visible={attachOpen} onClose={() => setAttachOpen(false)} title="Add context">
        {[
          { label: "Photo or screenshot", run: () => attach("library") },
          ...(Platform.OS !== "web" ? [{ label: "Take a photo", run: () => attach("camera") }] : []),
          { label: "Mention a file  @", run: () => { setAttachOpen(false); startMention(); } },
        ].map((a) => (
          <Pressable key={a.label} onPress={a.run} style={({ pressed }) => [s.opt, pressed && { backgroundColor: t.hover }]}>
            <Text style={s.optName}>{a.label}</Text>
          </Pressable>
        ))}
      </Sheet>
      <Sheet visible={!!open} onClose={() => setOpen(null)} title={open?.name ?? open?.id}>
        <ScrollView style={{ maxHeight: 460 }}>
          {open
            ? flatOptions(open).map((c, i, all) => {
                const cur = String(c.value) === String(open.currentValue);
                const showGroup = c.group && c.group !== all[i - 1]?.group;
                return (
                  <View key={`${c.group}:${c.value}`}>
                    {showGroup ? <Text style={s.group}>{c.group}</Text> : null}
                    <Pressable onPress={() => setOpt(open, String(c.value))} style={({ pressed }) => [s.opt, pressed && { backgroundColor: t.hover }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.optName, cur && { color: t.accent }]}>{c.name ?? String(c.value)}</Text>
                        {c.description ? <Text style={s.optDesc} numberOfLines={2}>{c.description}</Text> : null}
                      </View>
                      {cur ? <CheckIcon color={t.accent} size={16} /> : null}
                    </Pressable>
                  </View>
                );
              })
            : null}
        </ScrollView>
      </Sheet>
    </View>
  );
}

function styles(t: Theme) {
  return StyleSheet.create({
    root: { borderTopWidth: 1, borderTopColor: t.border, backgroundColor: t.surface, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
    cmdMenu: { borderWidth: 1, borderColor: t.border, borderRadius: 8, backgroundColor: t.panel, marginBottom: 10, overflow: "hidden" },
    cmdRow: { paddingHorizontal: 12, paddingVertical: 8 },
    cmdName: { fontFamily: mono, fontSize: 14, color: t.text },
    thumbs: { gap: 8, paddingBottom: 10 },
    thumbWrap: { position: "relative" },
    thumb: { width: 64, height: 64, borderRadius: 6, borderWidth: 1, borderColor: t.border },
    thumbX: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.65)", alignItems: "center", justifyContent: "center" },
    quick: { gap: 6, paddingBottom: 10 },
    quickChip: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 36, borderWidth: 1, borderColor: t.borderStrong, borderRadius: 18, paddingHorizontal: 13, backgroundColor: t.panel },
    quickText: { fontSize: 13.5, color: t.text, fontFamily: ui },
    usage: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 40, paddingHorizontal: 4 },
    toolbar: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8, marginLeft: -8 },
    toolBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
    toggleChip: { borderWidth: 1, borderColor: t.borderStrong, borderRadius: 18, width: 36, justifyContent: "center", marginLeft: 4 },
    inputSide: { alignItems: "flex-end", gap: 8 },
    usageTrack: { width: 36, height: 4, borderRadius: 2, overflow: "hidden" },
    usageText: { fontSize: 12, color: t.faint, fontFamily: ui },
    fileRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    fileName: { fontFamily: ui, fontSize: 14.5, color: t.text, flexShrink: 0, maxWidth: "60%" },
    fileDir: { flex: 1, fontFamily: ui, fontSize: 13, color: t.faint },
    cmdDesc: { fontFamily: ui, fontSize: 13, color: t.muted, marginTop: 2 },
    inputRow: { flexDirection: "row", alignItems: "flex-start" },
    input: { flex: 1, minHeight: 52, maxHeight: 260, fontFamily: mono, fontSize: 15, lineHeight: 24, color: t.text, padding: 0, outlineStyle: "none" } as any,
    expand: { paddingLeft: 10, paddingTop: 4 },
    err: { color: t.error, fontSize: 13, fontFamily: ui, marginTop: 6 },
    iconRow: { flexDirection: "row", alignItems: "center", gap: 18, marginTop: 10, marginBottom: 6, paddingLeft: 2 },
    controls: { flexDirection: "row", alignItems: "center" },
    chips: { gap: 4, alignItems: "center" },
    chip: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 5, minHeight: 36, borderRadius: 6 },
    chipText: { fontSize: 14.5, color: t.text, fontFamily: ui, maxWidth: 200 },
    bottomRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 },
    toggles: { flexDirection: "row", alignItems: "center", gap: 16, flexShrink: 1 },
    toggle: { flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 8 },
    toggleLabel: { fontSize: 15.5, color: t.text, fontFamily: ui },
    send: { width: 42, height: 38, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: t.hover },
    group: { fontSize: 12, color: t.faint, fontFamily: ui, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
    opt: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingVertical: 11 },
    optName: { fontSize: 16, color: t.text, fontFamily: ui },
    optDesc: { fontSize: 13, color: t.muted, fontFamily: ui, marginTop: 2 },
  });
}

