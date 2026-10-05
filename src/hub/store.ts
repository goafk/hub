// SQLite persistence for threads and transcript entries (JSON blobs keyed by id/seq).
import { DatabaseSync } from "node:sqlite";
import type { Entry, Thread } from "./interpreter.ts";

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (thread_id, seq));
    `);
  }

  saveThread(t: Thread): void {
    const { conn: _c, inFlight: _i, pendingPermissions: _p, pendingElicitations: _e, ...rest } = t;
    this.db
      .prepare("INSERT INTO threads (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .run(t.id, JSON.stringify(rest), t.updatedAt);
  }

  saveEntry(threadId: string, e: Entry): void {
    this.db
      .prepare("INSERT INTO entries (thread_id, seq, data) VALUES (?, ?, ?) ON CONFLICT(thread_id, seq) DO UPDATE SET data = excluded.data")
      .run(threadId, e.seq, JSON.stringify(e));
  }

  clearEntries(threadId: string): void {
    this.db.prepare("DELETE FROM entries WHERE thread_id = ?").run(threadId);
  }

  load(): { threads: Thread[]; entries: Map<string, Entry[]> } {
    const threads = (this.db.prepare("SELECT data FROM threads ORDER BY updated_at").all() as any[]).map(
      (r) => ({ inFlight: 0, pendingPermissions: [], pendingElicitations: [], ...JSON.parse(r.data) }) as Thread,
    );
    const entries = new Map<string, Entry[]>();
    for (const r of this.db.prepare("SELECT thread_id, data FROM entries ORDER BY thread_id, seq").all() as any[]) {
      const list = entries.get(r.thread_id) ?? [];
      list.push(JSON.parse(r.data));
      entries.set(r.thread_id, list);
    }
    return { threads, entries };
  }

  close(): void {
    this.db.close();
  }
}
