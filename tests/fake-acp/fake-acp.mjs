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
  async initialize(params) { log("initialize", params); return { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: mode?.agentInfo ?? { name: "fake-acp", version: "1.0.0" } }; },
  async newSession(params) { log("session/new", params); const sessionId = randomUUID(); saved[sessionId] = []; persist(); await mode?.newSession?.(sessionId, params, connection); return { sessionId }; },
  async loadSession(params) { log("session/load", params); if (!saved[params.sessionId]) throw RequestError.invalidParams(); await mode?.load?.(params.sessionId); for (const item of saved[params.sessionId]) await update(params.sessionId, item, false); await mode?.loaded?.(params.sessionId); return {}; },
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
      else if (action.update) await update(params.sessionId, action.update);
    }
    return { stopReason: cancelled ? "cancelled" : "end_turn" };
  },
  async cancel(params) { log("session/cancel", params); if (mode) return mode.cancel(params); cancelled = true; release?.(); },
  async extMethod(method, params) { log(method, params); if (mode?.extMethod) return mode.extMethod(method, params); throw RequestError.methodNotFound(method); },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
