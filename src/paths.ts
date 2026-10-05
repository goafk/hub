import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Paths = { home: string; sock: string; db: string; config: string; backups: string; logs: string };

/** AFK_<name>, or the pre-rename ACP_SYNC_<name>. */
export function envVar(name: string): string | undefined {
  return process.env[`AFK_${name}`] || process.env[`ACP_SYNC_${name}`] || undefined;
}

/** Where afk (the old name) kept its state; `afk setup` moves it to ~/.afk. */
export function legacyHome(): string {
  return path.join(os.homedir(), ".acp-sync");
}

export function paths(): Paths {
  const fresh = path.join(os.homedir(), ".afk");
  const home = envVar("HOME") || (fs.existsSync(fresh) || !fs.existsSync(legacyHome()) ? fresh : legacyHome());
  return {
    home,
    sock: path.join(home, "hub.sock"),
    db: path.join(home, "hub.db"),
    config: path.join(home, "config.json"),
    backups: path.join(home, "backups"),
    logs: path.join(home, "logs"),
  };
}

export function zedConfigDir(): string {
  return envVar("ZED_CONFIG") || path.join(os.homedir(), ".config", "zed");
}

export function zedSupportDir(): string {
  return envVar("ZED_SUPPORT") || path.join(os.homedir(), "Library", "Application Support", "Zed");
}
