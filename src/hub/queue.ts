// Messages sent while the agent is mid-turn wait here, like Zed's "Queued Messages": the next one goes
// out when the turn ends; "send now" stops the current turn and sends it straight away. Lives in the
// hub so the queue keeps draining while the phone is locked. In memory: a hub restart drops it.
import { randomUUID } from "node:crypto";
import type { Hub } from "./hub.ts";

export type PromptCommand = { cmd: "prompt"; text: string; content?: unknown[] };
export type QueuedMessage = { id: string; text: string; images: number; createdAt: number };
type Item = QueuedMessage & { command: PromptCommand; force?: boolean };

export class PromptQueue {
  private items = new Map<string, Item[]>();
  private hub: Hub;

  constructor(hub: Hub) {
    this.hub = hub;
    hub.on("event", (e: any) => {
      if (e.type !== "needs_input" || e.data?.reason !== "turn_ended") return;
      const head = this.items.get(e.threadId)?.[0];
      if (!head) return;
      // A turn the user stopped holds the queue, unless it was stopped to "send now".
      if (e.data.stopReason === "cancelled" && !head.force) return;
      // Let the interpreter settle the thread's status first.
      setImmediate(() => this.drain(e.threadId));
    });
  }

  /** True while a turn is in progress, i.e. a new message should wait. */
  busy(threadId: string): boolean {
    const t = this.hub.interpreter.threads.get(threadId);
    return !!t && (t.inFlight > 0 || t.status === "running" || t.status === "needs_permission");
  }

  list(threadId: string): QueuedMessage[] {
    return (this.items.get(threadId) ?? []).map(({ id, text, images, createdAt }) => ({ id, text, images, createdAt }));
  }

  add(threadId: string, command: PromptCommand): QueuedMessage {
    const images = (command.content ?? []).filter((b: any) => b?.type === "image").length;
    const item: Item = { id: randomUUID(), text: command.text, images, createdAt: Date.now(), command };
    this.items.set(threadId, [...(this.items.get(threadId) ?? []), item]);
    this.changed(threadId);
    // The turn may have ended between the caller's check and now.
    if (!this.busy(threadId)) setImmediate(() => this.drain(threadId));
    return { id: item.id, text: item.text, images, createdAt: item.createdAt };
  }

  remove(threadId: string, id: string): void {
    this.items.set(threadId, (this.items.get(threadId) ?? []).filter((i) => i.id !== id));
    this.changed(threadId);
  }

  clear(threadId: string): void {
    this.items.delete(threadId);
    this.changed(threadId);
  }

  edit(threadId: string, id: string, text: string): void {
    const item = (this.items.get(threadId) ?? []).find((i) => i.id === id);
    if (!item) return;
    item.text = text;
    item.command = {
      ...item.command,
      text,
      content: item.command.content?.map((b: any, i) => (i === 0 && b?.type === "text" ? { ...b, text } : b)),
    };
    this.changed(threadId);
  }

  /** Stops the current turn (if any) and sends this message next. */
  async sendNow(threadId: string, id: string): Promise<void> {
    const list = this.items.get(threadId) ?? [];
    const item = list.find((i) => i.id === id);
    if (!item) return;
    item.force = true;
    this.items.set(threadId, [item, ...list.filter((i) => i !== item)]);
    this.changed(threadId);
    if (this.busy(threadId)) await this.hub.command(threadId, { cmd: "cancel" });
    else await this.drain(threadId);
  }

  private async drain(threadId: string): Promise<void> {
    if (this.busy(threadId)) return;
    const list = this.items.get(threadId) ?? [];
    const next = list[0];
    if (!next) return;
    this.items.set(threadId, list.slice(1));
    this.changed(threadId);
    try {
      await this.hub.command(threadId, next.command);
    } catch (err: any) {
      // Put it back so it isn't lost; the app shows the queue and the user can retry or delete.
      this.items.set(threadId, [{ ...next, force: false }, ...(this.items.get(threadId) ?? [])]);
      this.changed(threadId);
      this.hub.emit("event", { type: "queue.error", threadId, data: { message: err?.message ?? String(err) } });
    }
  }

  private changed(threadId: string): void {
    this.hub.emit("event", { type: "thread.updated", threadId, data: {} });
  }
}
