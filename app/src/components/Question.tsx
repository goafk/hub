// Agent questions (ACP form elicitation, e.g. Claude's AskUserQuestion), laid out like Zed's
// "Input Requested by <agent>" card: titled fields, boxed radio/checkbox options with
// descriptions, per-question "Other" box, and a Submit / Decline / Cancel footer.
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { PendingElicitation } from "../lib/api";
import { ui, useTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";
import { CheckIcon, InfoIcon, XIcon } from "./Icons";

type Opt = { value: string; label: string; description?: string };
type Base = { key: string; title?: string; description?: string };
export type Field =
  | (Base & { kind: "single" | "multi"; options: Opt[] })
  | (Base & { kind: "text" | "number" })
  | (Base & { kind: "bool" });

function opts(list: any[] | undefined): Opt[] {
  return (list ?? []).map((o: any) =>
    typeof o === "string" ? { value: o, label: o } : { value: String(o.const ?? o.value), label: o.title ?? String(o.const ?? o.value), description: o.description },
  );
}

/** JSON-schema form → ordered fields (the "Other" boxes are ordinary text fields, as in Zed). */
export function schemaFields(schema: any): Field[] {
  const props: Record<string, any> = schema?.properties ?? {};
  return Object.entries(props).map(([key, p]) => {
    const base = { key, title: p.title, description: p.description };
    if (p.type === "array") return { ...base, kind: "multi", options: opts(p.items?.anyOf ?? p.items?.oneOf ?? p.items?.enum) };
    if (p.oneOf || p.enum) return { ...base, kind: "single", options: opts(p.oneOf ?? p.enum) };
    if (p.type === "boolean") return { ...base, kind: "bool" };
    if (p.type === "number" || p.type === "integer") return { ...base, kind: "number" };
    return { ...base, kind: "text" };
  });
}

type Action = "accept" | "decline" | "cancel";
type Props = { pending: PendingElicitation; agentName?: string; onAnswer: (action: Action, content?: Record<string, unknown>) => Promise<void> };

export function QuestionCard({ pending, agentName, onAnswer }: Props) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  const fields = useMemo(() => schemaFields(pending.requestedSchema), [pending]);
  const [values, setValues] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<Action | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: any) => setValues((x) => ({ ...x, [k]: v }));

  const submit = async (action: Action) => {
    setBusy(action);
    setErr(null);
    try {
      const content: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
        content[k] = fields.find((f) => f.key === k)?.kind === "number" ? Number(v) : v;
      }
      await onAnswer(action, action === "accept" ? content : undefined);
    } catch (e: any) {
      setErr(e.message);
      setBusy(null);
    }
  };

  return (
    <View style={s.card}>
      <View style={s.head}>
        <InfoIcon color={t.dark ? "#56B6C2" : "#179299"} size={16} />
        <Text style={s.headTitle} numberOfLines={1}>Input Requested by {agentName ?? "agent"}</Text>
        <Text style={s.headState}>Waiting for input</Text>
      </View>
      <View style={s.body}>
        {pending.message ? <Text style={s.message}>{pending.message}</Text> : null}
        {pending.mode === "url" ? (
          <>
            {pending.url ? <Text style={s.desc} selectable>{pending.url}</Text> : null}
            <Text style={s.desc}>Open this link on your Mac to continue.</Text>
          </>
        ) : (
          fields.map((f) => (
            <View key={f.key} style={s.field}>
              {f.title ? <Text style={s.title}>{f.title}</Text> : null}
              {f.description ? <Text style={s.desc}>{f.description}</Text> : null}
              {f.kind === "single" || f.kind === "multi" ? (
                f.options.map((o) => {
                  const cur = values[f.key];
                  const on = f.kind === "multi" ? Array.isArray(cur) && cur.includes(o.value) : cur === o.value;
                  const toggle = () =>
                    f.kind === "multi"
                      ? set(f.key, on ? (cur as string[]).filter((v) => v !== o.value) : [...((cur as string[]) ?? []), o.value])
                      : set(f.key, on ? undefined : o.value);
                  return (
                    <Pressable key={o.value} onPress={toggle} style={({ pressed }) => [s.option, (on || pressed) && s.optionOn]}>
                      <View style={[f.kind === "multi" ? s.box : s.radio, on && s.markOn]}>
                        {on ? f.kind === "multi" ? <CheckIcon color="#fff" size={12} strokeWidth={2.6} /> : <View style={s.dot} /> : null}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.optLabel}>{o.label}</Text>
                        {o.description ? <Text style={s.optDesc}>{o.description}</Text> : null}
                      </View>
                    </Pressable>
                  );
                })
              ) : f.kind === "bool" ? (
                <Switch value={!!values[f.key]} onValueChange={(v) => set(f.key, v)} trackColor={{ false: t.switchOff, true: t.accent }} />
              ) : (
                <TextInput
                  value={values[f.key] ?? ""}
                  onChangeText={(v) => set(f.key, v)}
                  placeholderTextColor={t.faint}
                  keyboardType={f.kind === "number" ? "numeric" : "default"}
                  style={s.input}
                  multiline={f.kind === "text"}
                />
              )}
            </View>
          ))
        )}
        {err ? <Text style={s.err}>{err}</Text> : null}
      </View>
      <View style={s.footer}>
        <FooterButton label="Submit" icon={<CheckIcon color={t.success} size={15} />} busy={busy === "accept"} onPress={() => submit("accept")} disabled={!!busy || pending.mode === "url"} s={s} t={t} />
        <FooterButton label="Decline" icon={<XIcon color={t.error} size={14} />} busy={busy === "decline"} onPress={() => submit("decline")} disabled={!!busy} s={s} t={t} />
        <FooterButton label="Cancel" busy={busy === "cancel"} onPress={() => submit("cancel")} disabled={!!busy} s={s} t={t} />
      </View>
    </View>
  );
}

function FooterButton({ label, icon, busy, disabled, onPress, s, t }: { label: string; icon?: React.ReactNode; busy: boolean; disabled: boolean; onPress: () => void; s: St; t: Theme }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [s.fbtn, pressed && { backgroundColor: t.hover }]}>
      {busy ? <ActivityIndicator size="small" color={t.faint} style={{ transform: [{ scale: 0.7 }] }} /> : icon}
      <Text style={s.fbtnText}>{label}</Text>
    </Pressable>
  );
}

/** Read-only view of an AskUserQuestion tool call after it was answered. */
export function AskedSummary({ questions, answer }: { questions: any[]; answer?: string }) {
  const t = useTheme();
  const s = useMemo(() => styles(t), [t]);
  return (
    <View style={[s.card, { marginVertical: 6 }]}>
      <View style={s.body}>
        {questions.map((q, i) => (
          <View key={i} style={i > 0 ? s.field : undefined}>
            {q.header ? <Text style={s.title}>{q.header}</Text> : null}
            <Text style={s.desc}>{q.question}</Text>
            <Text style={[s.optDesc, { marginTop: 0 }]}>{(q.options ?? []).map((o: any) => o.label).join(" · ")}</Text>
          </View>
        ))}
        {answer ? <Text style={s.answer}>{answer}</Text> : null}
      </View>
    </View>
  );
}

type St = ReturnType<typeof styles>;

function styles(t: Theme) {
  const optBg = t.dark ? "#2F343E" : "#EEF0F4";
  return StyleSheet.create({
    card: { borderWidth: 1, borderColor: t.border, borderRadius: 8, backgroundColor: t.panel, marginVertical: 8, overflow: "hidden" },
    head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: t.dark ? "#2C313A" : "#DCE0E8" },
    headTitle: { flex: 1, fontSize: 15, color: t.text, fontFamily: ui },
    headState: { fontSize: 14, color: t.muted, fontFamily: ui },
    body: { paddingHorizontal: 14, paddingVertical: 12 },
    message: { fontSize: 15, lineHeight: 22, color: t.text, fontFamily: ui, marginBottom: 4 },
    field: { marginTop: 12 },
    title: { fontSize: 15, color: t.text, fontFamily: ui, marginBottom: 4 },
    desc: { fontSize: 15, lineHeight: 22, color: t.muted, fontFamily: ui, marginBottom: 8 },
    option: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 6, borderWidth: 1, borderColor: t.border, backgroundColor: optBg, marginBottom: 8 },
    optionOn: { backgroundColor: t.selected },
    radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: t.borderStrong, backgroundColor: t.surface, alignItems: "center", justifyContent: "center", marginTop: 1 },
    box: { width: 20, height: 20, borderRadius: 4, borderWidth: 1, borderColor: t.borderStrong, backgroundColor: t.surface, alignItems: "center", justifyContent: "center", marginTop: 1 },
    markOn: { borderColor: t.accent, backgroundColor: t.accent },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" },
    optLabel: { fontSize: 15, color: t.text, fontFamily: ui },
    optDesc: { fontSize: 14.5, lineHeight: 21, color: t.muted, fontFamily: ui, marginTop: 4 },
    input: { borderWidth: 1, borderColor: t.border, borderRadius: 6, backgroundColor: t.surface, paddingHorizontal: 10, paddingVertical: 9, minHeight: 44, fontSize: 15, color: t.text, fontFamily: ui, outlineStyle: "none" } as any,
    err: { color: t.error, fontSize: 13, fontFamily: ui, marginTop: 8 },
    footer: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderTopWidth: 1, borderTopColor: t.border },
    fbtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 5 },
    fbtnText: { fontSize: 15, color: t.text, fontFamily: ui },
    answer: { marginTop: 10, fontSize: 14.5, lineHeight: 21, color: t.text, fontFamily: ui },
  });
}
