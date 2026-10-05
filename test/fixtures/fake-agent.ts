// A tiny scripted ACP agent for integration tests. Prompt text drives behavior:
//   FAIL -> JSON-RPC error; PERM -> asks permission first; SLOW -> 400ms delay (session/cancel ends it
//   early with stopReason "cancelled"); else streams "Hel","lo".
import { onLines, tryParse } from "../../src/lines.ts";

let n = 0;
let reqId = 100;
const waiting = new Map<number, (r: any) => void>();
const sessions = new Map<string, any[]>();
const cancels = new Map<string, () => void>(); // sessionId -> end the slow turn now
const send = (m: any) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (sessionId: string, update: any) => send({ method: "session/update", params: { sessionId, update } });
const options = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] },
  { id: "fast", name: "Fast mode", category: "model_config", type: "boolean", currentValue: false },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ group: "g", name: "G", options: [{ value: "ask", name: "Ask" }, { value: "auto", name: "Auto" }] }] },
];

onLines(process.stdin, async (line) => {
  const m = tryParse(line);
  if (!m) return;
  if (m.method === undefined && m.id !== undefined) return waiting.get(m.id)?.(m);
  const p = m.params ?? {};
  switch (m.method) {
    case "session/cancel":
      return cancels.get(p.sessionId)?.();
    case "initialize":
      return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    case "session/new": {
      const sessionId = `fake-${++n}`;
      sessions.set(sessionId, options());
      send({ id: m.id, result: { sessionId, configOptions: sessions.get(sessionId), modes: { currentModeId: "ask", availableModes: [{ id: "ask" }, { id: "auto" }] } } });
      return update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review the current diff" }, { name: "compact", description: "Summarize the conversation to free context" }, { name: "init", description: "Create a CLAUDE.md for this project" }] });
    }
    case "session/load": {
      // Replay a stored conversation, like real agents do when a thread is reopened.
      if (!sessions.has(p.sessionId)) sessions.set(p.sessionId, options());
      update(p.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } });
      return send({ id: m.id, result: { configOptions: sessions.get(p.sessionId) } });
    }
    case "session/set_config_option": {
      const opts = sessions.get(p.sessionId)!;
      const o = opts.find((x) => x.id === p.configId);
      if (!o) return send({ id: m.id, error: { code: -32602, message: "bad config" } });
      o.currentValue = p.value;
      // Like real agents: changing the model resets the effort option.
      if (p.configId === "model") opts.find((x) => x.id === "effort")!.currentValue = "low";
      return send({ id: m.id, result: { configOptions: opts } });
    }
    case "session/prompt": {
      const text = (p.prompt ?? []).map((c: any) => c.text).join("");
      if (text.includes("FAIL")) return send({ id: m.id, error: { code: -32603, message: "model not available" } });
      if (text.includes("SLOW")) {
        const cancelled = await new Promise<boolean>((r) => {
          const tm = setTimeout(() => r(false), 400);
          cancels.set(p.sessionId, () => {
            clearTimeout(tm);
            r(true);
          });
        });
        cancels.delete(p.sessionId);
        if (cancelled) return send({ id: m.id, result: { stopReason: "cancelled" } });
      }
      if (text.includes("ASK")) {
        const id = ++reqId;
        const other = (multi: boolean) => ({ type: "string", title: "Other", description: multi ? "Type your own answer to add to your selection above (optional)." : "Type your own answer, or add a note to the option you chose above (optional)." });
        // Same shape claude-agent-acp sends for AskUserQuestion (ASK3 = three questions).
        const schema = text.includes("ASK3")
          ? {
              type: "object",
              properties: {
                question_0: { type: "string", title: "Focus", description: "Which area should we focus on next?", oneOf: [{ const: "Workflow builder", title: "Workflow builder", description: "Finish and commit the workflow builder" }, { const: "Notifications", title: "Notifications", description: "Bell, panel and preferences" }] },
                question_0_custom: other(false),
                question_1: { type: "array", title: "Checks", description: "Which checks should run before calling a task done?", items: { anyOf: [{ const: "Lint", title: "Lint", description: "ESLint + TypeScript diagnostics" }, { const: "Jest tests", title: "Jest tests", description: "Run the relevant test suites" }] } },
                question_1_custom: other(true),
              },
            }
          : { type: "object", properties: { question_0: { type: "string", oneOf: [{ const: "A", title: "A" }, { const: "B", title: "B" }] } } };
        const resp: any = await new Promise((r) => {
          waiting.set(id, r);
          update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: "ask1", title: "Asking for your input", kind: "other", status: "pending" });
          send({ id, method: "elicitation/create", params: { sessionId: p.sessionId, mode: "form", toolCallId: "ask1", message: text.includes("ASK3") ? "Please answer the following questions." : "Pick", requestedSchema: schema } });
        });
        update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ask:${resp.result?.action}:${JSON.stringify(resp.result?.content ?? {})}` } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      // FILE:<path> asks the client to read a file; RUN:<command> runs it in a client terminal.
      const ask = (method: string, params: any) => {
        const id = ++reqId;
        return new Promise<any>((r) => {
          waiting.set(id, r);
          send({ id, method, params: { sessionId: p.sessionId, ...params } });
        });
      };
      const file = /FILE:(\S+)/.exec(text);
      if (file) {
        const r = await ask("fs/read_text_file", { path: file[1] });
        update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `file:${r.result?.content ?? r.error?.message}` } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      const run = /RUN:(.+)$/.exec(text);
      if (run) {
        const c = await ask("terminal/create", { command: run[1] });
        const terminalId = c.result?.terminalId;
        await ask("terminal/wait_for_exit", { terminalId });
        const o = await ask("terminal/output", { terminalId });
        await ask("terminal/release", { terminalId });
        update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `run:${o.result?.exitStatus?.exitCode}:${o.result?.output?.trim()}` } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (text.includes("PERM")) {
        const id = ++reqId;
        const resp: any = await new Promise((r) => {
          waiting.set(id, r);
          send({ id, method: "session/request_permission", params: { sessionId: p.sessionId, toolCall: { toolCallId: "t1", title: "Write file" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
        });
        update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `perm:${resp.result?.outcome?.optionId ?? "cancelled"}` } });
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
      return send({ id: m.id, result: { stopReason: "end_turn" } });
    }
  }
});
