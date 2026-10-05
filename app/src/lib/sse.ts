// Minimal Server-Sent Events client on XMLHttpRequest (works in React Native and on web,
// and can send the Authorization header that EventSource can't).
//
// Phones silently drop long-lived connections (sleep, Wi-Fi ↔ mobile switches, proxies), so the
// stream is treated as dead when nothing — not even the hub's ping — arrives for STALL_MS, and the
// app can force a reconnect (e.g. when it returns to the foreground).

export type HubEvent = { type: string; threadId: string; data: any };
export type Subscription = { close: () => void; reconnect: () => void };

const STALL_MS = 35_000;

export function subscribe(base: string, token: string, onEvent: (e: HubEvent) => void, onState: (connected: boolean) => void): Subscription {
  let xhr: XMLHttpRequest | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let delay = 1000;
  let lastByte = 0;
  let gen = 0; // ignores callbacks from connections we've already replaced

  const stop = () => {
    if (retry) clearTimeout(retry);
    retry = null;
    const old = xhr;
    xhr = null;
    gen++;
    old?.abort();
  };

  const connect = () => {
    if (closed || !base) return;
    stop();
    const my = gen;
    let seen = 0;
    let buf = "";
    let up = false;
    const x = new XMLHttpRequest();
    xhr = x;
    lastByte = Date.now();
    x.open("GET", `${base}/events`);
    if (token) x.setRequestHeader("Authorization", `Bearer ${token}`);
    x.onprogress = () => {
      if (my !== gen) return;
      const text = x.responseText;
      buf += text.slice(seen);
      seen = text.length;
      lastByte = Date.now();
      if (!up && seen > 0) {
        up = true;
        delay = 1000;
        onState(true);
      }
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!type || !data) continue;
        try {
          const d = JSON.parse(data);
          onEvent({ type, threadId: d.threadId, data: d.data });
        } catch {}
      }
      // Long-lived connections accumulate responseText (and slicing it gets slower); recycle at ~512KB.
      if (seen > 512_000) connect();
    };
    // onerror / onabort / onloadend can all fire for one failure: handle it once.
    const ended = () => {
      if (my !== gen) return;
      gen++;
      xhr = null;
      onState(false);
      if (closed) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10_000);
    };
    x.onerror = ended;
    x.onabort = ended;
    x.onloadend = ended;
    x.send();
  };

  watchdog = setInterval(() => {
    if (xhr && Date.now() - lastByte > STALL_MS) {
      onState(false);
      delay = 1000;
      connect();
    }
  }, 5_000);

  connect();
  return {
    close: () => {
      closed = true;
      if (watchdog) clearInterval(watchdog);
      stop();
    },
    reconnect: () => {
      delay = 1000;
      connect();
    },
  };
}
