// App-wide state: the paired Macs (one active at a time), the active Mac's Zed sidebar, and its
// live event stream.
import { AppState } from "react-native";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { defaultConn, makeApi } from "./api";
import { connOf, loadHosts, resolveUrl, saveHosts } from "./hosts";
import type { Host } from "./hosts";
import type { Api, Conn, Project } from "./api";
import { subscribe } from "./sse";
import { updateWidget } from "./widget";
import { registerForPush, setHostSwitcher } from "./push";
import type { PushState } from "./push";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { HubEvent } from "./sse";

type Store = {
  ready: boolean;
  conn: Conn;
  setConn: (c: Conn) => Promise<void>;
  api: Api;
  projects: Project[];
  error: string | null;
  live: boolean;
  refresh: () => Promise<void>;
  onEvent: (fn: (e: HubEvent) => void) => () => void;
  expanded: Record<string, boolean>;
  toggle: (path: string) => void;
  selected: string | null;
  select: (id: string | null) => void;
  push: PushState | null;
  setPushPrefs: (p: PushPrefs) => Promise<void>;
  hosts: Host[];
  activeHost: Host | undefined;
  switchHost: (id: string) => void;
  addHost: (h: Host) => Promise<void>;
  removeHost: (id: string) => Promise<void>;
  renameHost: (id: string, name: string) => Promise<void>;
  /** Other Macs at a glance: reachable, and how many threads need you there. */
  others: Record<string, { online: boolean; needs: number }>;
};

export type PushPrefs = { finished: boolean; input: boolean };
const PUSH_KEY = "acp-sync.push";

export async function loadPushPrefs(): Promise<PushPrefs> {
  try {
    return { finished: true, input: true, ...JSON.parse((await AsyncStorage.getItem(PUSH_KEY)) ?? "{}") };
  } catch {
    return { finished: true, input: true };
  }
}

async function savePushPrefs(p: PushPrefs): Promise<void> {
  await AsyncStorage.setItem(PUSH_KEY, JSON.stringify(p));
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conn, setConnState] = useState<Conn>({ url: "", token: "" });
  const [others, setOthers] = useState<Record<string, { online: boolean; needs: number }>>({});
  const hostsRef = useRef<Host[]>([]);
  hostsRef.current = hosts;
  const activeHost = hosts.find((h) => h.id === activeId);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);
  liveRef.current = live;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, select] = useState<string | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const listeners = useRef(new Set<(e: HubEvent) => void>());
  const api = useMemo(() => makeApi(conn), [conn]);

  const persist = useCallback(async (next: Host[], nextActive: string | null) => {
    setHosts(next);
    setActiveId(nextActive);
    await saveHosts(next, nextActive);
  }, []);

  useEffect(() => {
    loadHosts().then(({ hosts: hs, activeId: a }) => {
      setHosts(hs);
      setActiveId(a);
      const h = hs.find((x) => x.id === a);
      // Web build with nothing paired: the hub on this computer.
      setConnState(h ? connOf(h) : defaultConn());
      setReady(true);
    });
  }, []);

  // Pick whichever of the active Mac's addresses answers (Tailscale anywhere, Wi-Fi at home).
  const resolving = useRef(false);
  const reresolve = useCallback(async () => {
    const h = hostsRef.current.find((x) => x.id === activeId);
    if (!h || resolving.current) return;
    resolving.current = true;
    try {
      const url = await resolveUrl(h);
      if (!url) return;
      setConnState((c) => (c.url === url && c.token === h.key ? c : { url, token: h.key }));
      if (url !== h.lastUrl) {
        const next = hostsRef.current.map((x) => (x.id === h.id ? { ...x, lastUrl: url } : x));
        await persist(next, h.id);
      }
    } finally {
      resolving.current = false;
    }
  }, [activeId, persist]);

  useEffect(() => {
    if (!ready) return;
    reresolve();
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") reresolve();
    });
    return () => sub.remove();
  }, [ready, activeId, reresolve]);

  // Stream down for a while (e.g. left home Wi-Fi): try the Mac's other addresses.
  useEffect(() => {
    if (live || !ready) return;
    const tm = setTimeout(reresolve, 6000);
    return () => clearTimeout(tm);
  }, [live, ready, reresolve]);

  // Learn the Mac's real id and name once connected (hand-entered connections start as "local").
  useEffect(() => {
    if (!live || !activeHost) return;
    let gone = false;
    api.info().then(
      async (info) => {
        if (gone || !info?.id) return;
        const h = hostsRef.current.find((x) => x.id === activeHost.id);
        if (!h) return;
        const name = h.customName ? h.name : info.name || h.name;
        if (h.id === info.id && h.name === name) return;
        const dup = hostsRef.current.find((x) => x.id === info.id && x !== h);
        const next = hostsRef.current.filter((x) => x !== dup).map((x) => (x === h ? { ...x, id: info.id, name } : x));
        await persist(next, info.id);
      },
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [live, activeHost?.id, api, persist]);

  // Native builds: register for push with every paired Mac (titles name the Mac when there are several).
  const pushSig = hosts.map((h) => `${h.id}:${h.key}:${h.lastUrl ?? h.urls[0]}`).join("|");
  useEffect(() => {
    if (!ready || !hosts.length) return;
    loadPushPrefs().then(async (prefs) => {
      const showHub = hosts.length > 1;
      for (const h of hosts) {
        const r = await registerForPush(makeApi(connOf(h)), prefs, showHub);
        if (h.id === activeId) setPush(r);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pushSig]);

  // The other Macs: are they reachable, and does anything there need you?
  useEffect(() => {
    if (!ready || hosts.length < 2) {
      setOthers({});
      return;
    }
    let stop = false;
    const poll = async () => {
      if (AppState.currentState !== "active") return;
      const out: Record<string, { online: boolean; needs: number }> = {};
      await Promise.all(
        hostsRef.current
          .filter((h) => h.id !== activeId)
          .map(async (h) => {
            try {
              const url = (await resolveUrl(h, 3000)) ?? h.lastUrl ?? h.urls[0];
              const { projects: ps } = await makeApi({ url, token: h.key }).sidebar();
              const needs = ps.flatMap((p) => p.threads).filter((t) => !t.archived && (t.status === "needs_permission" || t.unread)).length;
              out[h.id] = { online: true, needs };
            } catch {
              out[h.id] = { online: false, needs: 0 };
            }
          }),
      );
      if (!stop) setOthers(out);
    };
    poll();
    const iv = setInterval(poll, 30_000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [ready, hosts.length, activeId]);

  const switchHost = useCallback(
    (id: string) => {
      const h = hostsRef.current.find((x) => x.id === id);
      if (!h || id === activeId) return;
      setProjects([]);
      setExpanded({});
      select(null);
      setError(null);
      setConnState(connOf(h));
      persist(hostsRef.current, id);
    },
    [activeId, persist],
  );

  useEffect(() => {
    setHostSwitcher((hubId) => {
      if (hostsRef.current.some((h) => h.id === hubId)) switchHost(hubId);
    });
    return () => setHostSwitcher(null);
  }, [switchHost]);

  const addHost = useCallback(
    async (h: Host) => {
      const next = [...hostsRef.current.filter((x) => x.id !== h.id), h];
      setProjects([]);
      setExpanded({});
      select(null);
      setConnState(connOf(h));
      await persist(next, h.id);
    },
    [persist],
  );

  const removeHost = useCallback(
    async (id: string) => {
      const next = hostsRef.current.filter((x) => x.id !== id);
      const nextActive = id === activeId ? (next[0]?.id ?? null) : activeId;
      if (id === activeId) {
        setProjects([]);
        setExpanded({});
        select(null);
        setConnState(connOf(next.find((x) => x.id === nextActive)));
      }
      await persist(next, nextActive);
    },
    [activeId, persist],
  );

  const renameHost = useCallback(
    async (id: string, name: string) => {
      const next = hostsRef.current.map((x) => (x.id === id ? { ...x, name: name.trim() || x.name, customName: true } : x));
      await persist(next, activeId);
    },
    [activeId, persist],
  );

  const refresh = useCallback(async () => {
    if (!api.base) return;
    try {
      const { projects: ps } = await api.sidebar();
      setProjects(ps);
      updateWidget(ps);
      setExpanded((prev) => {
        const next = { ...prev };
        for (const p of ps) if (next[p.path] === undefined) next[p.path] = p.expanded;
        return next;
      });
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [api]);

  useEffect(() => {
    if (!ready) return;
    refresh();
    if (!api.base) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 250);
    };
    const sub = subscribe(
      api.base,
      api.token,
      (e) => {
        if (e.type === "sidebar.changed" || e.type === "thread.created") soon();
        if (e.type === "thread.updated" && e.data) {
          setProjects((ps) =>
            ps.map((p) => ({
              ...p,
              threads: p.threads.map((t) =>
                t.id === e.threadId
                  ? {
                      ...t,
                      status: e.data.status,
                      online: !!e.data.online,
                      unread: e.data.unread ?? t.unread,
                      // Keep an app-side rename over the agent's title.
                      title: t.zedTitle ? t.title : (e.data.title ?? t.title),
                    }
                  : t,
              ),
            })),
          );
        }
        for (const l of listeners.current) l(e);
      },
      (ok) => {
        setLive(ok);
        if (ok) {
          // (Re)connected: anything that happened while we were away was missed — resync everything.
          soon();
          for (const l of listeners.current) l({ type: "resync", threadId: "", data: null });
        }
      },
    );
    // Back in the foreground: the old connection is usually dead after the phone slept.
    let wentAway = 0;
    const app = AppState.addEventListener("change", (st) => {
      if (st === "background") wentAway = Date.now();
      if (st === "active" && wentAway) {
        wentAway = 0;
        sub.reconnect();
      }
    });
    // Safety net while the stream is down: poll the sidebar.
    const poll = setInterval(() => {
      if (!liveRef.current && AppState.currentState === "active") refresh();
    }, 10_000);
    return () => {
      sub.close();
      app.remove();
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
  }, [ready, api, refresh]);

  // Hand-entered address + key (Settings): updates the active Mac, or adds one.
  const setConn = useCallback(
    async (c: Conn) => {
      const cur = hostsRef.current.find((x) => x.id === activeId);
      const h: Host = cur
        ? { ...cur, urls: [c.url, ...cur.urls.filter((u) => u !== c.url)], lastUrl: c.url, key: c.token }
        : { id: "local", name: "My Mac", urls: [c.url], lastUrl: c.url, key: c.token, addedAt: Date.now() };
      setConnState(c);
      await persist([...hostsRef.current.filter((x) => x.id !== h.id), h], h.id);
    },
    [activeId, persist],
  );

  const onEvent = useCallback((fn: (e: HubEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const toggle = useCallback((path: string) => setExpanded((e) => ({ ...e, [path]: !e[path] })), []);

  const setPushPrefs = useCallback(
    async (p: PushPrefs) => {
      await savePushPrefs(p);
      const showHub = hostsRef.current.length > 1;
      for (const h of hostsRef.current) {
        const r = await registerForPush(makeApi(connOf(h)), p, showHub);
        if (h.id === activeId) setPush(r);
      }
    },
    [activeId],
  );

  const value: Store = {
    ready,
    conn,
    setConn,
    api,
    projects,
    error,
    live,
    refresh,
    onEvent,
    expanded,
    toggle,
    selected,
    select,
    push,
    setPushPrefs,
    hosts,
    activeHost,
    switchHost,
    addHost,
    removeHost,
    renameHost,
    others,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("StoreProvider missing");
  return s;
}
