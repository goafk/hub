// Pairing phones without sharing the hub's master token. `afk setup` / `afk pair` mint a
// short-lived one-time code (shown as a QR); the app trades it for its own key via POST /pair. Keys
// are stored hashed and can be revoked one by one (`afk devices revoke <id>`).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CODE_TTL_MS = 15 * 60_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export type Client = { id: string; name: string; keyHash: string; createdAt: number; lastSeen?: number };
type Code = { code: string; expiresAt: number };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class Pairing {
  private codesFile: string;
  private clientsFile: string;
  private cache: { mtime: number; clients: Client[] } | null = null;
  private failures: number[] = [];

  constructor(home: string) {
    this.codesFile = path.join(home, "pairing-codes.json");
    this.clientsFile = path.join(home, "clients.json");
  }

  /** A one-time code, valid for 15 minutes. */
  createCode(now = Date.now()): { code: string; expiresAt: number } {
    const bytes = crypto.randomBytes(10);
    const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
    const codes = readJson<Code[]>(this.codesFile, []).filter((c) => c.expiresAt > now);
    const entry = { code, expiresAt: now + CODE_TTL_MS };
    writeJson(this.codesFile, [...codes, entry]);
    return entry;
  }

  /** Trades a valid code for a new client key (returned once, stored hashed). */
  redeem(code: string, name: string, now = Date.now()): { client: Omit<Client, "keyHash">; key: string } | null {
    // Brute-force guard: at most 10 bad codes per 10 minutes.
    this.failures = this.failures.filter((t) => now - t < 10 * 60_000);
    if (this.failures.length >= 10) return null;
    const codes = readJson<Code[]>(this.codesFile, []).filter((c) => c.expiresAt > now);
    const want = String(code).trim().toUpperCase();
    const hit = codes.find((c) => c.code.length === want.length && crypto.timingSafeEqual(Buffer.from(c.code), Buffer.from(want)));
    if (!hit) {
      this.failures.push(now);
      return null;
    }
    writeJson(this.codesFile, codes.filter((c) => c !== hit));
    const key = `zt_${crypto.randomBytes(24).toString("hex")}`;
    const client: Client = { id: crypto.randomBytes(4).toString("hex"), name: (name || "Phone").slice(0, 60), keyHash: sha(key), createdAt: now };
    writeJson(this.clientsFile, [...this.clients(), client]);
    this.cache = null;
    const { keyHash: _h, ...pub } = client;
    return { client: pub, key };
  }

  clients(): Client[] {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.clientsFile).mtimeMs;
    } catch {
      return [];
    }
    if (!this.cache || this.cache.mtime !== mtime) this.cache = { mtime, clients: readJson<Client[]>(this.clientsFile, []) };
    return this.cache.clients;
  }

  /** The client a key belongs to, if any. */
  verify(key: string, now = Date.now()): Client | undefined {
    if (!key.startsWith("zt_")) return undefined;
    const h = sha(key);
    const c = this.clients().find((x) => x.keyHash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.keyHash), Buffer.from(h)));
    // Remember roughly when each phone was last seen (written at most every 10 minutes).
    if (c && (!c.lastSeen || now - c.lastSeen > 10 * 60_000)) {
      c.lastSeen = now;
      writeJson(this.clientsFile, this.clients());
      this.cache = null;
    }
    return c;
  }

  revoke(id: string): boolean {
    const all = this.clients();
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return false;
    writeJson(this.clientsFile, next);
    this.cache = null;
    return true;
  }
}
