// Writes/removes the synced agent entries (settings.json), keybindings (keymap.json),
// config bindings, and the hub launchd agent.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../config.ts";
import type { AgentBinding } from "../config.ts";
import { paths } from "../paths.ts";
import { discoverAgents, SYNCED_SUFFIX } from "./discover.ts";
import { ensureKeyHelper } from "./keyhelper.ts";
import type { AgentSpec } from "./discover.ts";
import { removeBlocks, upsertKeymapBlock, upsertMemberBlock, upsertSettingsBlock } from "./zedfiles.ts";
import { parseJsonc } from "./jsonc.ts";

export const LAUNCHD_LABEL = "dev.goafk.hub";
const LEGACY_LAUNCHD_LABEL = "dev.acp-sync.hub";
const KEY_PREFIX = "ctrl-alt-cmd-z";
const LETTERS = "abcdefghijklmnopqrstuvwxy".split("");

export type InstallOpts = {
  zedConfig: string;
  zedSupport: string;
  nodePath: string;
  cliEntry: string;
  only?: string[];
  launchd?: boolean;
  /** Sync Node registry agents in-process (their threads keep Zed's own agent). Default true. */
  inProcess?: boolean;
  /** Bundled preload module path (built by setup). */
  preload?: string;
};

/** Registry Node agents with no user env of their own get the in-process preload. */
export function isInProcess(a: AgentSpec, opts: { inProcess?: boolean }): boolean {
  return opts.inProcess !== false && a.source === "registry" && a.dist === "npx" && !a.hasEnv;
}

/** Bundles the preload (and its imports) into one plain-JS file Zed's Node can load. */
export function buildPreload(projectRoot: string, nodePath: string): string {
  const out = path.join(paths().home, "preload.mjs");
  const npx = path.join(path.dirname(nodePath), "npx");
  execFileSync(fs.existsSync(npx) ? npx : "npx", ["--yes", "esbuild@0.25", path.join(projectRoot, "src/proxy/preload.ts"), "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`, "--log-level=warning"], {
    stdio: "pipe",
    env: { ...process.env, PATH: `${path.dirname(nodePath)}:${process.env.PATH ?? ""}` },
  });
  return out;
}

export function preloadEnv(a: AgentSpec, preload: string): Record<string, string> {
  return { NODE_OPTIONS: `--import=${preload}`, AFK_AGENT: a.id, AFK_NAME: a.name };
}

export function proxyEntry(a: AgentSpec, nodePath: string, cliEntry: string) {
  const args = ["--no-warnings", cliEntry, "proxy", "--agent", a.id, "--name", a.name];
  if (Object.keys(a.defaults).length) args.push("--defaults", JSON.stringify(a.defaults));
  if (a.source === "registry") args.push("--registry", a.id);
  else args.push("--", a.command!, ...(a.args ?? []));
  return { type: "custom", command: nodePath, args, env: a.env ?? {} };
}

function backup(file: string): void {
  if (!fs.existsSync(file)) return;
  const dir = paths().backups;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(file, path.join(dir, `${stamp}-${path.basename(file)}`));
}

export function install(opts: InstallOpts): { agents: Array<AgentSpec & AgentBinding> } {
  const settingsFile = path.join(opts.zedConfig, "settings.json");
  const keymapFile = path.join(opts.zedConfig, "keymap.json");
  const settingsText = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "{\n}\n";
  const keymapText = fs.existsSync(keymapFile) ? fs.readFileSync(keymapFile, "utf8") : "[\n]\n";

  // Discover from the user's own settings (ignoring what earlier runs of setup inserted).
  let agents = discoverAgents({ settingsText: removeBlocks(settingsText), zedSupport: opts.zedSupport, execPath: opts.nodePath });
  if (opts.only?.length) agents = agents.filter((a) => opts.only!.includes(a.id));
  if (!agents.length) throw new Error("no installed ACP agents found (install one from Zed's ACP registry first)");

  const cfg = loadConfig();
  const used = new Set<string>();
  const bindings: Record<string, AgentBinding> = {};
  // Keep existing key assignments stable across re-runs.
  for (const a of agents) {
    const prev = cfg.bindings[a.id]?.keys;
    if (prev) { bindings[a.id] = { ...cfg.bindings[a.id], name: a.name }; used.add(prev); }
  }
  const zedNames = new Set<string>();
  for (const a of agents) {
    // In-process agents keep Zed's own entry; others get a "<Name> (synced)" custom entry.
    let zedName = isInProcess(a, opts) ? a.id : `${a.name}${SYNCED_SUFFIX}`;
    if (zedNames.has(zedName)) zedName = `${a.name} [${a.id}]${SYNCED_SUFFIX}`;
    zedNames.add(zedName);
    if (!bindings[a.id]) {
      const letter = LETTERS.find((l) => !used.has(`${KEY_PREFIX} ${l}`));
      if (!letter) throw new Error("too many agents for available keybindings");
      used.add(`${KEY_PREFIX} ${letter}`);
      bindings[a.id] = { zedName, keys: `${KEY_PREFIX} ${letter}`, name: a.name };
    }
    bindings[a.id].zedName = zedName;
    bindings[a.id].defaults = a.defaults;
  }

  const entries: Record<string, unknown> = {};
  const keys: Record<string, unknown> = {};
  const inProcess = agents.filter((a) => isInProcess(a, opts));
  const preload = inProcess.length ? (opts.preload ?? buildPreload(path.resolve(path.dirname(opts.cliEntry), ".."), opts.nodePath)) : "";
  const userServers = parseJsonc(removeBlocks(settingsText))?.agent_servers ?? {};
  for (const a of agents) {
    if (isInProcess(a, opts)) {
      // No user entry for this registry agent yet: create one in our block.
      if (!userServers[a.id]) entries[a.id] = { type: "registry", env: preloadEnv(a, preload) };
    } else {
      entries[bindings[a.id].zedName] = proxyEntry(a, opts.nodePath, opts.cliEntry);
    }
    keys[bindings[a.id].keys] = ["agent::NewExternalAgentThread", { agent: bindings[a.id].zedName }];
  }

  fs.mkdirSync(opts.zedConfig, { recursive: true });
  backup(settingsFile);
  backup(keymapFile);
  let newSettings = upsertSettingsBlock(settingsText, entries);
  // Existing user entries get the preload env injected inside their own object.
  for (const a of inProcess) {
    if (userServers[a.id]) newSettings = upsertMemberBlock(newSettings, ["agent_servers", a.id], { env: preloadEnv(a, preload) });
  }
  fs.writeFileSync(settingsFile, newSettings);
  fs.writeFileSync(keymapFile, upsertKeymapBlock(keymapText, keys));
  const keyHelper = opts.launchd !== false ? ensureKeyHelper(paths().home) : cfg.keyHelper;
  saveConfig({ ...cfg, bindings, keyHelper });
  if (opts.launchd !== false) installLaunchd(opts.nodePath, opts.cliEntry);
  return { agents: agents.map((a) => ({ ...a, ...bindings[a.id] })) };
}

export function uninstall(opts: { zedConfig: string; launchd?: boolean }): void {
  for (const f of ["settings.json", "keymap.json"]) {
    const file = path.join(opts.zedConfig, f);
    if (!fs.existsSync(file)) continue;
    backup(file);
    fs.writeFileSync(file, removeBlocks(fs.readFileSync(file, "utf8")));
  }
  const cfg = loadConfig();
  saveConfig({ ...cfg, bindings: {} });
  if (opts.launchd !== false) {
    uninstallLaunchd();
    uninstallLaunchd(LEGACY_LAUNCHD_LABEL);
  }
}

export function plistPath(label = LAUNCHD_LABEL): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function installLaunchd(nodePath: string, cliEntry: string): void {
  const p = paths();
  fs.mkdirSync(p.logs, { recursive: true });
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>--no-warnings</string>
    <string>${esc(cliEntry)}</string>
    <string>hub</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(p.logs, "hub.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(p.logs, "hub.log"))}</string>
</dict>
</plist>
`;
  uninstallLaunchd(LEGACY_LAUNCHD_LABEL);
  uninstallLaunchd();
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), plist);
  // bootout is asynchronous; bootstrap fails with EIO until the old job is gone.
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plistPath()], { stdio: "pipe" });
      return;
    } catch (e) {
      if (attempt >= 20) throw e;
      sleepMs(250);
    }
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function uninstallLaunchd(label = LAUNCHD_LABEL): void {
  const target = `gui/${process.getuid!()}/${label}`;
  try {
    execFileSync("launchctl", ["bootout", target], { stdio: "ignore" });
  } catch {}
  for (let i = 0; i < 40; i++) {
    try {
      execFileSync("launchctl", ["print", target], { stdio: "ignore" });
      sleepMs(250);
    } catch {
      break; // job is gone
    }
  }
  if (fs.existsSync(plistPath(label))) fs.unlinkSync(plistPath(label));
}
