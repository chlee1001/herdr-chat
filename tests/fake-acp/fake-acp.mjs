#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { AgentSideConnection, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";

const scenario = process.env.FAKE_ACP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_ACP_SCENARIO, "utf8")) : {};
const store = process.env.FAKE_ACP_STORE;
const saved = store && existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {};
const log = (method, params) => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify({ method, params }) + "\n"); };
const persist = () => { if (store) writeFileSync(store, JSON.stringify(saved)); };
// `configOptions`, `modes`: the session settings session/new and session/load answer with; `commands`: available_commands_update after either.
// A new session starts from them again; session/load keeps the current ones.
let config = structuredClone(scenario.configOptions ?? []);
let modes = scenario.modes ? structuredClone(scenario.modes) : null;
const fresh = () => { config = structuredClone(scenario.configOptions ?? []); modes = scenario.modes ? structuredClone(scenario.modes) : null; };
const cwds = new Map();
const refused = (id) => (scenario.refuse ?? []).includes(id);
const settings = () => ({ ...(config.length ? { configOptions: config } : {}), ...(modes ? { modes } : {}) });
const opened = (sessionId) => { if (scenario.commands) setTimeout(() => void update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: scenario.commands }, false), scenario.commandsDelay ?? 20); };
let cancelled = false;
let prompts = 0;
let release;
let connection;
let mode;
const update = async (sessionId, update, record = true) => {
  if (record) { saved[sessionId] ??= []; saved[sessionId].push(update); persist(); }
  await connection.sessionUpdate({ sessionId, update });
};
// FAKE_ACP_MODE: a module whose createMode({scenario, update, permission}) flavours this agent like a specific one.
if (process.env.FAKE_ACP_MODE) mode = (await import(pathToFileURL(process.env.FAKE_ACP_MODE).href)).createMode({ scenario, update, permission: (params) => connection.requestPermission(params).then((result) => { log("permission/response", result); return result; }) });
connection = new AgentSideConnection(() => ({
  async initialize(params) { log("initialize", params); return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }, agentInfo: mode?.agentInfo ?? { name: "fake-acp", version: "1.0.0" } }; },
  async newSession(params) { log("session/new", params); const sessionId = randomUUID(); const before = Object.keys(saved).at(-1); saved[sessionId] = []; fresh();
    // `stray`: the session left behind still sends output (a turn it finishes on its own) and asks for approval;
    // `strayDuring`: it does both while session/new is still being answered.
    const stray = () => {
      void update(before, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stray" } }, false);
      void connection.requestPermission({ sessionId: before, toolCall: { toolCallId: "stray", title: "stray tool", kind: "execute" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }).then((result) => log("permission/response", result));
    };
    if (scenario.stray && before) setTimeout(stray, 50);
    if (scenario.strayDuring && before) { stray(); await new Promise((resolve) => setTimeout(resolve, 100)); } cwds.set(sessionId, params.cwd); persist(); await mode?.newSession?.(sessionId, params, connection); opened(sessionId); return { sessionId, ...settings() }; },
  async loadSession(params) { log("session/load", params); if (!saved[params.sessionId]) throw RequestError.invalidParams(); cwds.set(params.sessionId, params.cwd); await mode?.load?.(params.sessionId); for (const item of saved[params.sessionId]) await update(params.sessionId, item, false); await mode?.loaded?.(params.sessionId); opened(params.sessionId); return settings(); },
  // `sessions`: session/list's rows as given; without it, the sessions this agent opened.
  async listSessions(params) { log("session/list", params); return { sessions: scenario.sessions ?? Object.keys(saved).filter((id) => !params.cwd || cwds.get(id) === params.cwd).map((sessionId) => ({ sessionId, cwd: cwds.get(sessionId) ?? params.cwd, title: `session ${sessionId.slice(0, 8)}`, updatedAt: new Date(Date.now() - Object.keys(saved).indexOf(sessionId) * 1000).toISOString() })) }; },
  async closeSession(params) { log("session/close", params); return {}; },
  // `refuse`: config ids and mode ids whose change fails. `quietConfig`: no config_option_update after a change (only its answer).
  async setSessionConfigOption(params) {
    log("session/set_config_option", params);
    if (scenario.setDelay) await new Promise((resolve) => setTimeout(resolve, scenario.setDelay)); // `setDelay`: ms before a change is answered
    const option = config.find((o) => o.id === params.configId);
    if (!option || refused(params.configId)) throw RequestError.internalError({ details: `Unsupported ${params.configId}: ${params.value}` });
    option.currentValue = params.value;
    if (option.category === "mode" && modes) modes.currentModeId = params.value;
    if (!scenario.quietConfig) await update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: config }, false);
    return { configOptions: config };
  },
  async setSessionMode(params) {
    log("session/set_mode", params);
    if (!modes || refused(params.modeId)) throw RequestError.invalidParams({ code: "unsupported" }, `ACP mode ${params.modeId} is not available`);
    modes.currentModeId = params.modeId;
    const option = config.find((o) => o.category === "mode"); if (option) option.currentValue = params.modeId;
    await update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId }, false);
    return {};
  },
  async prompt(params) {
    log("session/prompt", params); cancelled = false;
    prompts++;
    if (mode) return mode.prompt(params, prompts);
    if (scenario.conflict === true || (typeof scenario.conflict === "number" && prompts <= scenario.conflict)) throw new RequestError(-32603, "conflict", { code: "conflict" });
    for (const content of params.prompt) await update(params.sessionId, { sessionUpdate: "user_message_chunk", content });
    for (const action of scenario.actions ?? [{ type: "text", text: "hello" }]) {
      if (cancelled) break;
      if (action.delay) await new Promise((resolve) => setTimeout(resolve, action.delay));
      if (action.type === "wait_cancel") await new Promise((resolve) => { release = resolve; });
      else if (action.type === "exit") process.exit(action.code ?? 1);
      else if (action.type === "permission") {
        const result = await connection.requestPermission({ sessionId: params.sessionId, toolCall: { toolCallId: action.toolCallId ?? "tool", title: "Run tool", kind: "execute" }, options: action.options });
        log("permission/response", result);
      } else if (action.type === "text" || action.type === "thinking") await update(params.sessionId, { sessionUpdate: action.type === "text" ? "agent_message_chunk" : "agent_thought_chunk", content: { type: "text", text: action.text } });
      else if (action.update) await update(params.sessionId, action.update, action.record ?? true);
    }
    return { stopReason: cancelled ? "cancelled" : "end_turn" };
  },
  async cancel(params) { log("session/cancel", params); if (mode) return mode.cancel(params); cancelled = true; release?.(); },
  async extMethod(method, params) { log(method, params); if (mode?.extMethod) return mode.extMethod(method, params); throw RequestError.methodNotFound(method); },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
