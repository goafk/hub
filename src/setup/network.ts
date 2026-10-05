// How phones reach this Mac: Tailscale (HTTPS, works anywhere) and/or the local network.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const TAILSCALE_PORT = 8443;

function run(cmd: string, args: string[], timeout = 8000): string {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout }).toString().trim();
}

export function tailscaleBin(): string | undefined {
  for (const c of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]) {
    if (fs.existsSync(c)) return c;
  }
  try {
    return run("/usr/bin/which", ["tailscale"]) || undefined;
  } catch {
    return undefined;
  }
}

export type TailscaleState =
  | { ok: true; dnsName: string; url: string; note?: string }
  | { ok: false; reason: "missing" | "stopped" | "serve_failed"; detail?: string };

/** Puts the hub behind `tailscale serve` on :8443 (HTTPS, tailnet only). */
export function setupTailscale(hubPort: number): TailscaleState {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, reason: "missing" };
  let status: any;
  try {
    status = JSON.parse(run(bin, ["status", "--json"]));
  } catch (e: any) {
    return { ok: false, reason: "stopped", detail: e.message };
  }
  if (status.BackendState !== "Running" || !status.Self?.DNSName) return { ok: false, reason: "stopped", detail: status.BackendState };
  const dnsName = String(status.Self.DNSName).replace(/\.$/, "");
  const url = `https://${dnsName}:${TAILSCALE_PORT}`;
  const target = `http://127.0.0.1:${hubPort}`;
  try {
    const current = run(bin, ["serve", "status", "--json"]);
    if (current.includes(`:${TAILSCALE_PORT}`) && current.includes(target)) return { ok: true, dnsName, url };
  } catch {}
  try {
    run(bin, ["serve", "--bg", `--https=${TAILSCALE_PORT}`, target], 20000);
    return { ok: true, dnsName, url };
  } catch (e: any) {
    const msg = String(e.stderr ?? e.message ?? e);
    // Tailscale asks once to enable HTTPS / Serve for the tailnet in its admin console.
    const link = msg.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
    return { ok: false, reason: "serve_failed", detail: link ? `Enable Serve for your tailnet: ${link}` : msg.split("\n")[0] };
  }
}

export function lanAddress(): string | undefined {
  for (const iface of ["en0", "en1", "en2"]) {
    try {
      const ip = run("/usr/sbin/ipconfig", ["getifaddr", iface]);
      if (ip) return ip;
    } catch {}
  }
  return undefined;
}

/** Whether a URL answers as an afk hub (with the master token). */
export async function reachable(url: string, token: string, timeoutMs = 6000): Promise<boolean> {
  try {
    const r = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}
