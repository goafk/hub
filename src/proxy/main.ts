// Entry for `afk proxy …` (what Zed launches as a custom agent).
import { paths, zedSupportDir } from "../paths.ts";
import { resolveRegistryCommand } from "../setup/discover.ts";
import { startProxy } from "./proxy.ts";

export async function proxyMain(argv: string[]): Promise<void> {
  const sep = argv.indexOf("--");
  const flags = sep >= 0 ? argv.slice(0, sep) : argv;
  const rest = sep >= 0 ? argv.slice(sep + 1) : [];
  const get = (name: string) => {
    const i = flags.indexOf(name);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  const agentId = get("--agent");
  if (!agentId) throw new Error("proxy: --agent is required");
  const registry = get("--registry");
  let command: string;
  let args: string[];
  if (registry) {
    ({ command, args } = resolveRegistryCommand(zedSupportDir(), registry, process.execPath));
  } else {
    if (!rest.length) throw new Error("proxy: need --registry <id> or -- <command>");
    [command, ...args] = rest;
  }
  const { done } = startProxy({
    agentId,
    name: get("--name") ?? agentId,
    command,
    args,
    defaults: JSON.parse(get("--defaults") ?? "{}"),
    sock: get("--sock") ?? paths().sock,
    stdin: process.stdin,
    stdout: process.stdout,
  });
  process.exit(await done);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  proxyMain(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`[afk] ${e.message}\n`);
    process.exit(1);
  });
}
