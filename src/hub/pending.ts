// New threads asked for while the Mac was locked ("start when the Mac unlocks"). Kept on disk so
// a hub restart doesn't lose them; the hub starts them in Zed as soon as the screen unlocks.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type PendingLaunch = { id: string; cwd: string; agentId: string; prompt?: string; createdAt: number; tries: number };

export class PendingLaunches {
  private file: string;
  private items: PendingLaunch[];

  constructor(file: string) {
    this.file = file;
    try {
      this.items = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.items = [];
    }
  }

  list(): PendingLaunch[] {
    return this.items;
  }

  add(req: { cwd: string; agentId: string; prompt?: string }): PendingLaunch {
    const item: PendingLaunch = { id: crypto.randomUUID(), cwd: req.cwd, agentId: req.agentId, prompt: req.prompt || undefined, createdAt: Date.now(), tries: 0 };
    this.items = [...this.items, item];
    this.save();
    return item;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }

  /** Counts a failed attempt; returns the item if it may be retried, undefined once it gave up. */
  failed(id: string, maxTries = 3): PendingLaunch | undefined {
    const item = this.items.find((x) => x.id === id);
    if (!item) return undefined;
    item.tries++;
    if (item.tries >= maxTries) {
      this.remove(id);
      return undefined;
    }
    this.save();
    return item;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
  }
}
