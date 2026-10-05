// Push notifications to the phone app through Expo's push service: a thread finished,
// or it needs your input (question / permission).
import fs from "node:fs";
import path from "node:path";
import type { HubEvent } from "./interpreter.ts";

export type Prefs = { finished: boolean; input: boolean; /** Live "agent working" progress (silent, updates in place). */ progress: boolean };
export type Device = { token: string; platform: string; name?: string; prefs: Prefs; addedAt: number; /** Phone is paired with several Macs: name this one in titles. */ showHub?: boolean };
type Post = (url: string, body: string) => Promise<any>;

const EXPO_PUSH = "https://exp.host/--/api/v2/push/send";
const DEFAULT_PREFS: Prefs = { finished: true, input: true, progress: true };

/** What a running thread is doing, for the phone's live progress notification. */
export type Progress = { threadId: string; title: string; project: string; running: boolean; step?: string; done?: number; total?: number };

/** The Allow (once) / Reject options of a permission request, for notification buttons. */
export function permissionButtons(options: Array<{ optionId: string; kind?: string; name?: string }>): { allow?: string; reject?: string } {
  const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => /^allow/i.test(o.optionId) || /^allow/i.test(o.name ?? ""));
  const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => /reject|deny/i.test(`${o.optionId} ${o.name ?? ""}`));
  return { allow: allow?.optionId, reject: reject?.optionId };
}

/** The one free-text field of a question's form, when that's all it asks for (so it can be answered inline). */
export function singleTextField(schema: any): string | undefined {
  const props = schema?.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length !== 1) return undefined;
  const f = props[keys[0]];
  return f?.type === "string" && !f.enum && !f.oneOf ? keys[0] : undefined;
}

export const defaultPost: Post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
  return r.json();
};

export class Notifier {
  private file: string;
  /** This Mac's id and name, sent with every notification so a tap opens the right Mac in the app. */
  hub: () => { id: string; name: string } = () => ({ id: "", name: "" });
  private post: Post;
  private devices: Device[];

  constructor(file: string, post: Post = defaultPost) {
    this.file = file;
    this.post = post;
    try {
      this.devices = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.devices = [];
    }
  }

  list(): Device[] {
    return this.devices;
  }

  register(d: { token: string; platform: string; name?: string; prefs?: Partial<Prefs>; showHub?: boolean }): Device {
    if (!/^Expo(nent)?PushToken\[.+\]$/.test(d.token ?? "")) throw Object.assign(new Error("not an Expo push token"), { code: "invalid" });
    const prev = this.devices.find((x) => x.token === d.token);
    const dev: Device = { token: d.token, platform: d.platform, name: d.name, prefs: { ...DEFAULT_PREFS, ...prev?.prefs, ...d.prefs }, addedAt: prev?.addedAt ?? Date.now(), showHub: !!d.showHub };
    this.devices = [...this.devices.filter((x) => x.token !== d.token), dev];
    this.save();
    return dev;
  }

  unregister(token: string): void {
    this.devices = this.devices.filter((x) => x.token !== token);
    this.save();
  }

  /** Sends a notification for a `needs_input` hub event to every device that wants it. */
  /** Sends a test notification to one registered phone, so the app can check the whole path works. */
  async test(token: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.devices.some((x) => x.token === token)) return { ok: false, error: "This phone isn't registered for notifications on this Mac yet." };
    const hub = this.hub();
    try {
      const res: any = await this.post(
        EXPO_PUSH,
        JSON.stringify([{ to: token, title: hub.name ? `afk · ${hub.name}` : "afk", body: "Notifications work. You'll hear from your agents here.", sound: "default", priority: "high", channelId: "default", data: { hubId: hub.id } }]),
      );
      const r = res?.data?.[0];
      return r?.status === "error" ? { ok: false, error: r.message ?? r.details?.error ?? "Push failed" } : { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  async notify(ev: HubEvent, thread: { id: string; title?: string; cwd: string }, lastAgentText: string): Promise<void> {
    if (ev.type !== "needs_input") return;
    const d = ev.data ?? {};
    let kind: keyof Prefs;
    let body: string;
    if (d.reason === "turn_ended") {
      if (d.stopReason === "cancelled") return; // you stopped it yourself
      kind = "finished";
      body = d.stopReason === "error" ? `⚠️ ${d.error ?? "The agent hit an error"}` : oneLine(lastAgentText) || "Finished";
    } else if (d.reason === "question") {
      kind = "input";
      body = oneLine(d.message) || "The agent has a question for you";
    } else if (d.reason === "permission") {
      kind = "input";
      body = `Permission needed: ${d.toolCall?.title ?? "run a tool"}`;
    } else return;
    // Buttons on the notification (the app registers these categories): answer without opening it.
    let action: Record<string, unknown> = {};
    let categoryId: string | undefined;
    if (d.reason === "permission") {
      const b = permissionButtons(d.options ?? []);
      if (b.allow && b.reject) {
        categoryId = "permission";
        action = { action: "permission", requestId: d.requestId, allowId: b.allow, rejectId: b.reject };
      }
    } else if (d.reason === "question") {
      const field = singleTextField(d.requestedSchema);
      if (field) {
        categoryId = "answer";
        action = { action: "answer", requestId: d.requestId, field };
      }
    } else if (d.stopReason !== "error") {
      categoryId = "reply";
      action = { action: "reply" };
    }
    const targets = this.devices.filter((x) => x.prefs[kind]);
    if (!targets.length) return;
    const title = `${path.basename(thread.cwd)} · ${thread.title ?? "Thread"}`;
    const hub = this.hub();
    const messages = targets.map((x) => ({
      to: x.token,
      title: x.showHub && hub.name ? `${hub.name} · ${title}` : title,
      body: body.length > 180 ? body.slice(0, 177) + "…" : body,
      sound: "default",
      priority: "high",
      channelId: kind === "input" ? "input" : "default",
      ...(categoryId ? { categoryId } : {}),
      data: { threadId: thread.id, hubId: hub.id, url: `zedthreads://thread/${thread.id}`, ...action },
    }));
    await this.send(messages);
  }

  /**
   * Live progress for a running thread: a silent, data-only push. The app shows (or, when
   * `running` is false, removes) one ongoing notification per thread and updates it in place.
   */
  async progress(p: Progress): Promise<void> {
    const targets = this.devices.filter((x) => x.prefs.progress !== false);
    if (!targets.length) return;
    const hub = this.hub();
    await this.send(
      targets.map((x) => ({
        to: x.token,
        priority: "high",
        _contentAvailable: true,
        data: { kind: "progress", hubId: hub.id, hubName: x.showHub ? hub.name : "", ...p },
      })),
    );
  }

  private async send(messages: Array<{ to: string } & Record<string, unknown>>): Promise<void> {
    let res: any;
    try {
      res = await this.post(EXPO_PUSH, JSON.stringify(messages));
    } catch (e: any) {
      console.error(`push failed: ${e.message}`);
      return;
    }
    // Forget devices that uninstalled the app or revoked permission.
    const dead = new Set<string>();
    (res?.data ?? []).forEach((r: any, i: number) => {
      if (r?.status === "error" && r.details?.error === "DeviceNotRegistered") dead.add(messages[i].to);
    });
    if (dead.size) {
      this.devices = this.devices.filter((x) => !dead.has(x.token));
      this.save();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
  }
}

function oneLine(s?: string): string {
  return (s ?? "").replace(/[#*`>_]/g, "").replace(/\s+/g, " ").trim();
}
