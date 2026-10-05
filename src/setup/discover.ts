// Finds the ACP agents Zed can run: installed registry agents and custom agent_servers.
import fs from "node:fs";
import path from "node:path";
import { parseJsonc } from "./jsonc.ts";

export type AgentSpec = {
  id: string;
  name: string;
  source: "registry" | "custom";
  /** How Zed runs it: "npx" (Node, can sync in-process), "binary", or "custom". */
  dist?: "npx" | "binary" | "custom";
  /** The user's own settings entry already sets env (we then use a synced entry instead). */
  hasEnv?: boolean;
  defaults: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export const SYNCED_SUFFIX = " (synced)";

function registryDir(zedSupport: string): string {
  return path.join(zedSupport, "external_agents", "registry");
}

function readRegistry(zedSupport: string): any[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(registryDir(zedSupport), "registry.json"), "utf8")).agents ?? [];
  } catch {
    return [];
  }
}

function platformKey(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  return `${os}-${arch}`;
}

function packageName(spec: string): string {
  // "@scope/name@1.2.3" -> "@scope/name", "name@1" -> "name"
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Resolves the command Zed would run for an installed registry agent. Throws if not installed. */
export function resolveRegistryCommand(zedSupport: string, id: string, execPath: string): { command: string; args: string[] } {
  const entry = readRegistry(zedSupport).find((a) => a.id === id);
  if (!entry) throw new Error(`agent ${id} not in Zed registry`);
  const dist = entry.distribution ?? {};
  if (dist.npx) {
    const pkgDir = path.join(registryDir(zedSupport), "npx", id, "node_modules", packageName(dist.npx.package));
    let pkg: any;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    } catch {
      throw new Error(`agent ${id} is not installed (missing ${pkgDir})`);
    }
    const bin = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    if (!bin) throw new Error(`agent ${id}: package has no bin`);
    const binPath = path.join(pkgDir, bin as string);
    const isJs = /\.(c|m)?js$/.test(binPath);
    return isJs
      ? { command: execPath, args: [binPath, ...(dist.npx.args ?? [])] }
      : { command: binPath, args: [...(dist.npx.args ?? [])] };
  }
  if (dist.binary) {
    const target = dist.binary[platformKey()];
    if (!target) throw new Error(`agent ${id}: no binary for ${platformKey()}`);
    const base = path.join(registryDir(zedSupport), id);
    let versions: string[] = [];
    try {
      versions = fs.readdirSync(base).filter((d) => d.startsWith("v_"));
    } catch {}
    if (!versions.length) throw new Error(`agent ${id} is not installed (missing ${base})`);
    versions.sort((a, b) => fs.statSync(path.join(base, b)).mtimeMs - fs.statSync(path.join(base, a)).mtimeMs);
    return { command: path.join(base, versions[0], target.cmd.replace(/^\.\//, "")), args: target.args ?? [] };
  }
  throw new Error(`agent ${id}: unsupported distribution`);
}

export function discoverAgents(opts: { settingsText: string; zedSupport: string; execPath?: string }): AgentSpec[] {
  const settings = parseJsonc(opts.settingsText) ?? {};
  const servers: Record<string, any> = settings.agent_servers ?? {};
  const out: AgentSpec[] = [];
  for (const entry of readRegistry(opts.zedSupport)) {
    try {
      resolveRegistryCommand(opts.zedSupport, entry.id, opts.execPath ?? process.execPath);
    } catch {
      continue;
    }
    out.push({
      id: entry.id,
      name: entry.name ?? entry.id,
      source: "registry",
      dist: entry.distribution?.npx ? "npx" : "binary",
      hasEnv: !!servers[entry.id]?.env && Object.keys(servers[entry.id].env).length > 0,
      defaults: { ...(servers[entry.id]?.default_config_options ?? {}) },
    });
  }
  for (const [id, cfg] of Object.entries(servers)) {
    if (id.endsWith(SYNCED_SUFFIX) || id.includes("(synced test)")) continue;
    if (cfg?.type !== "custom" || !cfg.command) continue;
    out.push({
      id,
      name: id,
      source: "custom",
      dist: "custom",
      defaults: { ...(cfg.default_config_options ?? {}) },
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ?? {},
    });
  }
  return out;
}
