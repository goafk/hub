// The ACP relay core, independent of transport: it sees every line between Zed and the agent,
// mirrors traffic to the hub, and executes hub commands inside live sessions.
// Used by the out-of-process proxy (proxy.ts) and the in-process preload (preload.ts).
import { tryParse } from "../lines.ts";
import { HubLink } from "./hublink.ts";

export type RelayOpts = {
  agentId: string;
  name: string;
  defaults: Record<string, string>;
  sock: string;
  /** Delivers one line to the agent. */
  writeAgent: (line: string) => void;
  /** Delivers one line to Zed. */
  writeZed: (line: string) => void;
  rpcTimeoutMs?: number;
};

export type Relay = { fromZed: (line: string) => void; fromAgent: (line: string) => void; link: HubLink };

type SessionInfo = { sessionId: string; cwd?: string; configOptions?: any[]; modes?: any; models?: any; availableCommands?: any[] };

/** Flattens ACP select options, which may be grouped ({group, options:[…]}). */
export function optionValues(opt: any): string[] {
  const out: string[] = [];
  for (const o of opt?.options ?? []) {
    if (Array.isArray(o.options)) out.push(...o.options.map((x: any) => x.value));
    else out.push(o.value);
  }
  return out;
}

/** Commands this relay build understands (the hub checks before sending). */
export const PROXY_COMMANDS = ["prompt", "prompt:content", "config", "cancel", "permission", "elicitation", "rpc", "notify"];

export function createRelay(opts: RelayOpts): Relay {
  const timeout = opts.rpcTimeoutMs ?? 30000;

  const sessions = new Map<string, SessionInfo>();
  const fromZed = new Map<string | number, { method: string; params: any }>(); // Zed requests awaiting agent reply
  const fromAgent = new Map<string | number, { method: string; params: any }>(); // agent requests awaiting Zed reply
  const answered = new Set<string | number>(); // agent requests the hub already answered
  const busy = new Map<string, number>(); // sessionId -> prompts in flight
  const ours = new Map<string, { resolve: (m: any) => void }>();
  let seq = 0;

  // Outbound-to-Zed queue so we can hold messages while rewriting a session/new response.
  let holding = 0;
  const held: string[] = [];
  const writeZed = (line: string) => {
    if (holding > 0) held.push(line);
    else opts.writeZed(line);
  };
  const holdWaiters: Array<() => void> = [];
  const release = () => {
    holding--;
    if (holding > 0) return;
    for (const l of held.splice(0)) opts.writeZed(l);
    for (const w of holdWaiters.splice(0)) w();
  };
  // Commands wait until a new session's defaults are applied and Zed knows the session.
  const settled = () => (holding === 0 ? Promise.resolve() : new Promise<void>((r) => holdWaiters.push(r)));

  const link = new HubLink(
    opts.sock,
    () => ({ type: "hello", agentId: opts.agentId, name: opts.name, pid: process.pid, commands: PROXY_COMMANDS, sessions: [...sessions.values()] }),
    (cmd) => runCommand(cmd),
  );
  const mirror = (dir: string, msg: any) => link.send({ type: "acp", dir, msg, t: Date.now() });

  const bump = (sid: string, d: number) => busy.set(sid, Math.max(0, (busy.get(sid) ?? 0) + d));

  function toAgent(method: string, params: any): Promise<any> {
    const id = `sync-${++seq}`;
    const msg = { jsonrpc: "2.0", id, method, params };
    // Register before writing: an in-process agent may answer synchronously during the write.
    const done = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        ours.delete(id);
        reject(Object.assign(new Error(`${method} timed out`), { code: "timeout" }));
      }, method === "session/prompt" ? 24 * 3600 * 1000 : timeout);
      timer.unref();
      ours.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
    mirror("sync->agent", msg);
    opts.writeAgent(JSON.stringify(msg));
    return done;
  }
  function notifyAgent(method: string, params: any): void {
    const msg = { jsonrpc: "2.0", method, params };
    mirror("sync->agent", msg);
    opts.writeAgent(JSON.stringify(msg));
  }
  function toZed(method: string, params: any): void {
    const msg = { jsonrpc: "2.0", method, params };
    mirror("sync->zed", msg);
    writeZed(JSON.stringify(msg));
  }
  const rpcError = (m: any) => Object.assign(new Error(m.error?.message ?? "agent error"), { code: "agent_error", data: m.error });

  /** Sets a config option (or legacy mode/model) on the agent; returns updated session info. */
  async function setConfig(info: SessionInfo, configId: string, value: string | boolean): Promise<boolean> {
    const opt = info.configOptions?.find((o) => o.id === configId);
    if (opt?.type === "boolean") {
      const on = value === true || ["true", "on", "1"].includes(String(value).toLowerCase());
      if (opt.currentValue === on) return false;
      const res = await toAgent("session/set_config_option", { sessionId: info.sessionId, configId, type: "boolean", value: on });
      if (res.error) throw rpcError(res);
      if (res.result?.configOptions) info.configOptions = res.result.configOptions;
      else opt.currentValue = on;
      return true;
    }
    if (opt) {
      if (opt.currentValue === value) return false;
      if (!optionValues(opt).includes(value)) throw Object.assign(new Error(`invalid value ${value} for ${configId}`), { code: "invalid" });
      const res = await toAgent("session/set_config_option", { sessionId: info.sessionId, configId, value });
      if (res.error) throw rpcError(res);
      if (res.result?.configOptions) info.configOptions = res.result.configOptions;
      else opt.currentValue = value;
      if (opt.category === "mode" && info.modes) info.modes = { ...info.modes, currentModeId: value };
      return true;
    }
    if (configId === "mode" && info.modes?.availableModes?.some((m: any) => m.id === value)) {
      if (info.modes.currentModeId === value) return false;
      const res = await toAgent("session/set_mode", { sessionId: info.sessionId, modeId: value });
      if (res.error) throw rpcError(res);
      info.modes = { ...info.modes, currentModeId: value };
      return true;
    }
    if (configId === "model" && info.models?.availableModels?.some((m: any) => m.modelId === value)) {
      if (info.models.currentModelId === value) return false;
      const res = await toAgent("session/set_model", { sessionId: info.sessionId, modelId: value });
      if (res.error) throw rpcError(res);
      info.models = { ...info.models, currentModelId: value };
      return true;
    }
    throw Object.assign(new Error(`unknown config option ${configId}`), { code: "invalid" });
  }

  function notifyZedOfConfig(info: SessionInfo, configId: string): void {
    if (info.configOptions?.some((o) => o.id === configId)) {
      toZed("session/update", { sessionId: info.sessionId, update: { sessionUpdate: "config_option_update", configOptions: info.configOptions } });
    }
    if (configId === "mode" && info.modes) {
      toZed("session/update", { sessionId: info.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: info.modes.currentModeId } });
    }
  }

  async function applyDefaults(info: SessionInfo): Promise<void> {
    // Model first: switching models can reset dependent options such as reasoning effort.
    const rank = (id: string) => {
      const cat = info.configOptions?.find((o) => o.id === id)?.category ?? id;
      return cat === "model" ? 0 : cat === "mode" ? 1 : 2;
    };
    const entries = Object.entries(opts.defaults).sort((a, b) => rank(a[0]) - rank(b[0]));
    const failures = new Map<string, string>();
    for (let pass = 0; pass < 2; pass++) {
      for (const [configId, value] of entries) {
        try {
          await setConfig(info, configId, value);
          failures.delete(configId);
        } catch (e: any) {
          failures.set(configId, `${value}: ${e.message}`);
        }
      }
    }
    for (const [id, why] of failures) process.stderr.write(`[afk] default ${id}=${why} (not applied)\n`);
  }

  /** Answers an agent→client request on Zed's behalf; Zed is told to drop its copy. */
  function answerAgent(requestId: string | number, result: unknown): void {
    const msg = { jsonrpc: "2.0", id: requestId, result };
    fromAgent.delete(requestId);
    answered.add(requestId);
    mirror("sync->agent", msg);
    opts.writeAgent(JSON.stringify(msg));
    toZed("$/cancel_request", { requestId });
  }

  async function runCommand(cmd: any): Promise<any> {
    await settled();
    const need = (sid: string) => {
      const info = sessions.get(sid);
      if (!info) throw Object.assign(new Error(`unknown session ${sid}`), { code: "not_found" });
      return info;
    };
    switch (cmd.cmd) {
      case "prompt": {
        const info = need(cmd.sessionId);
        if ((busy.get(info.sessionId) ?? 0) > 0) throw Object.assign(new Error("session is busy"), { code: "busy" });
        bump(info.sessionId, 1);
        // Either plain text or ACP content blocks (text + resource_link mentions, like Zed's @-mentions).
        const prompt: any[] = Array.isArray(cmd.content) && cmd.content.length ? cmd.content : [{ type: "text", text: String(cmd.text ?? "") }];
        for (const block of prompt) {
          toZed("session/update", { sessionId: info.sessionId, update: { sessionUpdate: "user_message_chunk", content: block } });
        }
        toAgent("session/prompt", { sessionId: info.sessionId, prompt }).then(
          (res) => {
            bump(info.sessionId, -1);
            if (res.error) {
              toZed("session/update", { sessionId: info.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `⚠️ afk: ${res.error.message ?? "agent error"}` } } });
            }
          },
          () => bump(info.sessionId, -1),
        );
        return { accepted: true };
      }
      case "config": {
        const info = need(cmd.sessionId);
        const changed = await setConfig(info, cmd.configId, cmd.value);
        if (changed) notifyZedOfConfig(info, cmd.configId);
        return { configOptions: info.configOptions, modes: info.modes, models: info.models };
      }
      case "cancel": {
        need(cmd.sessionId);
        notifyAgent("session/cancel", { sessionId: cmd.sessionId });
        return { ok: true };
      }
      case "permission": {
        const req = fromAgent.get(cmd.requestId);
        if (!req || req.method !== "session/request_permission") throw Object.assign(new Error("no such pending permission"), { code: "not_found" });
        const valid = (req.params?.options ?? []).some((o: any) => o.optionId === cmd.optionId);
        if (!valid) throw Object.assign(new Error(`invalid optionId ${cmd.optionId}`), { code: "invalid" });
        answerAgent(cmd.requestId, { outcome: { outcome: "selected", optionId: cmd.optionId } });
        return { ok: true };
      }
      case "elicitation": {
        const req = fromAgent.get(cmd.requestId);
        if (!req || req.method !== "elicitation/create") throw Object.assign(new Error("no such pending question"), { code: "not_found" });
        const action = cmd.action ?? "accept";
        if (!["accept", "decline", "cancel"].includes(action)) throw Object.assign(new Error(`invalid action ${action}`), { code: "invalid" });
        answerAgent(cmd.requestId, action === "accept" ? { action, content: cmd.content ?? {} } : { action });
        return { ok: true };
      }
      case "rpc": {
        const res = await toAgent(cmd.method, cmd.params);
        if (res.error) throw rpcError(res);
        // A session the hub loaded itself ("continue on phone") becomes usable for later commands.
        if ((cmd.method === "session/load" || cmd.method === "session/resume") && cmd.params?.sessionId) {
          const r = res.result ?? {};
          sessions.set(cmd.params.sessionId, { sessionId: cmd.params.sessionId, cwd: cmd.params.cwd, configOptions: r.configOptions, modes: r.modes, models: r.models });
        }
        return res.result;
      }
      case "notify": {
        toZed(cmd.method, cmd.params);
        return { ok: true };
      }
      default:
        throw Object.assign(new Error(`unknown command ${cmd.cmd}`), { code: "invalid" });
    }
  }

  // Zed -> agent
  function fromZedLine(line: string): void {
    const m = tryParse(line);
    if (!m) return opts.writeAgent(line);
    if (m.method === undefined && m.id !== undefined) {
      if (answered.has(m.id)) {
        answered.delete(m.id);
        return; // hub already answered this permission request
      }
      fromAgent.delete(m.id);
    } else if (m.method !== undefined && m.id !== undefined) {
      fromZed.set(m.id, { method: m.method, params: m.params });
      if (m.method === "session/prompt" && m.params?.sessionId) bump(m.params.sessionId, 1);
    }
    mirror("zed->agent", m);
    opts.writeAgent(line);
  }

  // agent -> Zed
  function fromAgentLine(line: string): void {
    const m = tryParse(line);
    if (!m) return writeZed(line);
    if (m.method === undefined && typeof m.id === "string" && ours.has(m.id)) {
      mirror("agent->zed", m);
      const o = ours.get(m.id)!;
      ours.delete(m.id);
      return o.resolve(m);
    }
    mirror("agent->zed", m);
    // Remember each session's slash commands so a reconnecting hub gets them in the hello snapshot.
    if (m.method === "session/update" && m.params?.update?.sessionUpdate === "available_commands_update") {
      const info = sessions.get(m.params.sessionId);
      if (info) info.availableCommands = m.params.update.availableCommands;
    }
    if (m.method !== undefined && m.id !== undefined) {
      fromAgent.set(m.id, { method: m.method, params: m.params });
      return writeZed(line);
    }
    if (m.method === undefined && m.id !== undefined && fromZed.has(m.id)) {
      const req = fromZed.get(m.id)!;
      fromZed.delete(m.id);
      if (req.method === "session/prompt" && req.params?.sessionId) bump(req.params.sessionId, -1);
      if ((req.method === "session/new" || req.method === "session/load" || req.method === "session/resume") && m.result) {
        const sid = m.result.sessionId ?? req.params?.sessionId;
        const info: SessionInfo = { sessionId: sid, cwd: req.params?.cwd, configOptions: m.result.configOptions, modes: m.result.modes, models: m.result.models };
        sessions.set(sid, info);
        const wantsDefaults = req.method === "session/new" && Object.keys(opts.defaults).length > 0;
        if (wantsDefaults) {
          holding++;
          applyDefaults(info).finally(() => {
            const result = { ...m.result };
            if (info.configOptions) result.configOptions = info.configOptions;
            if (info.modes) result.modes = info.modes;
            if (info.models) result.models = info.models;
            const out = { ...m, result };
            mirror("sync->zed", out); // what Zed actually received
            opts.writeZed(JSON.stringify(out));
            release();
          });
          return;
        }
      }
    }
    writeZed(line);
  }

  return { fromZed: fromZedLine, fromAgent: fromAgentLine, link };
}
