// Push notifications to the phone app through Expo's push service: a thread finished,
// or it needs your input (question / permission).
import fs from "node:fs";
import path from "node:path";
import type { HubEvent } from "./interpreter.ts";

export type Prefs = { finished: boolean; input: boolean };
export type Device = { token: string; platform: string; name?: string; prefs: Prefs; addedAt: number; /** Phone is paired with several Macs: name this one in titles. */ showHub?: boolean };
type Post = (url: string, body: string) => Promise<any>;

const EXPO_PUSH = "https://exp.host/--/api/v2/push/send";
const DEFAULT_PREFS: Prefs = { finished: true, input: true };

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
      data: { threadId: thread.id, hubId: hub.id, url: `zedthreads://thread/${thread.id}` },
    }));
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
