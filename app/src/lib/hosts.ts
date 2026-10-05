// The Macs this phone is paired with. Each runs its own hub; one is "active" at a time (the switcher
// at the top of the sidebar). A Mac can be reached at several addresses (Tailscale, home Wi-Fi):
// we remember the one that last worked and fall back to the others.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Conn } from "./api";

export type Host = {
  /** The hub's id from /info (or "local" for a connection entered by hand before pairing existed). */
  id: string;
  name: string;
  urls: string[];
  key: string;
  lastUrl?: string;
  addedAt: number;
  /** Set when the user renamed it, so /info doesn't overwrite the name. */
  customName?: boolean;
};

const HOSTS = "acp-sync.hosts";
const ACTIVE = "acp-sync.activeHost";
const LEGACY = "acp-sync.conn";

export async function loadHosts(): Promise<{ hosts: Host[]; activeId: string | null }> {
  let hosts: Host[] = [];
  try {
    hosts = JSON.parse((await AsyncStorage.getItem(HOSTS)) ?? "[]");
  } catch {}
  let activeId = await AsyncStorage.getItem(ACTIVE);
  if (!hosts.length) {
    // One-time migration from the single-hub connection.
    try {
      const old = JSON.parse((await AsyncStorage.getItem(LEGACY)) ?? "null");
      if (old?.url) {
        hosts = [{ id: "local", name: "My Mac", urls: [old.url], key: old.token ?? "", lastUrl: old.url, addedAt: Date.now() }];
        activeId = "local";
        await saveHosts(hosts, activeId);
      }
    } catch {}
  }
  if (!hosts.some((h) => h.id === activeId)) activeId = hosts[0]?.id ?? null;
  return { hosts, activeId };
}

export async function saveHosts(hosts: Host[], activeId: string | null): Promise<void> {
  await AsyncStorage.setItem(HOSTS, JSON.stringify(hosts));
  if (activeId) await AsyncStorage.setItem(ACTIVE, activeId);
  else await AsyncStorage.removeItem(ACTIVE);
}

export function connOf(h: Host | undefined): Conn {
  return h ? { url: h.lastUrl ?? h.urls[0] ?? "", token: h.key } : { url: "", token: "" };
}

/** The active Mac's connection (widgets and background tasks use this). */
export async function activeConn(): Promise<Conn> {
  const { hosts, activeId } = await loadHosts();
  return connOf(hosts.find((h) => h.id === activeId));
}

async function answers(url: string, key: string, timeoutMs: number): Promise<boolean> {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/health`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(tm);
  }
}

/** First address of this Mac that answers right now (last good one first), or undefined. */
export async function resolveUrl(h: Host, timeoutMs = 3500): Promise<string | undefined> {
  if (h.lastUrl && (await answers(h.lastUrl, h.key, timeoutMs))) return h.lastUrl;
  const others = h.urls.filter((u) => u !== h.lastUrl);
  if (!others.length) return undefined;
  return new Promise((resolve) => {
    let left = others.length;
    for (const u of others) {
      answers(u, h.key, timeoutMs).then((ok) => {
        if (ok) resolve(u);
        else if (--left === 0) resolve(undefined);
      });
    }
  });
}

/** Any HTTP answer (even 401) means a hub is listening there. */
export async function listening(url: string, timeoutMs = 4000): Promise<boolean> {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetch(`${url.replace(/\/$/, "")}/health`, { signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(tm);
  }
}

export type PairLink = { hubId: string; name: string; code: string; urls: string[] };

/** Parses zedthreads://pair?h=…&n=…&c=…&u=…&u=… (also accepts the params object from the router). */
export function parsePairLink(input: string | Record<string, string | string[] | undefined>): PairLink | null {
  let get: (k: string) => string[];
  if (typeof input === "string") {
    // Hand-rolled: React Native's URLSearchParams doesn't implement getAll.
    const q = input.includes("?") ? input.slice(input.indexOf("?") + 1).split("#")[0] : "";
    const pairs = q
      .split("&")
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf("=");
        const dec = (x: string) => {
          try {
            return decodeURIComponent(x.replace(/\+/g, " "));
          } catch {
            return x;
          }
        };
        return i < 0 ? [dec(kv), ""] : [dec(kv.slice(0, i)), dec(kv.slice(i + 1))];
      });
    get = (k) => pairs.filter(([key]) => key === k).map(([, v]) => v);
  } else {
    get = (k) => {
      const v = input[k];
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    };
  }
  const code = get("c")[0];
  const urls = get("u").filter((u) => /^https?:\/\//.test(u));
  if (!code || !urls.length) return null;
  return { hubId: get("h")[0] ?? "", name: get("n")[0] || "Mac", code, urls };
}
