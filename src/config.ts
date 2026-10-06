import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.ts";

export type AgentBinding = { zedName: string; keys: string; name: string; /** Zed default_config_options, applied to threads the hub resumes. */ defaults?: Record<string, string> };

export type Config = {
  token: string;
  /** Stable id for this Mac, so the app can tell several hubs apart. */
  hubId: string;
  /** Shown in the app's Mac switcher (defaults to the computer's name). */
  name?: string;
  host: string;
  port: number;
  zedCli?: string;
  keyHelper?: string;
  bindings: Record<string, AgentBinding>;
};

export const DEFAULT_PORT = 47321;

export function loadConfig(file = paths().config): Config {
  let cfg: Partial<Config> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const full: Config = {
    token: cfg.token || crypto.randomBytes(24).toString("hex"),
    hubId: cfg.hubId || crypto.randomBytes(6).toString("hex"),
    name: cfg.name,
    host: cfg.host || "127.0.0.1",
    port: cfg.port || DEFAULT_PORT,
    zedCli: cfg.zedCli,
    keyHelper: cfg.keyHelper,
    bindings: cfg.bindings || {},
  };
  if (!cfg.token || !cfg.hubId) saveConfig(full, file);
  return full;
}

export function saveConfig(cfg: Config, file = paths().config): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
