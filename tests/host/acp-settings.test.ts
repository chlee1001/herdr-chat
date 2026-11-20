import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAcpAgent } from "../../host/providers/acp/spec.ts";
import { GjcAdapter } from "../../host/providers/gjc/adapter.ts";
import type { NormalizedEvent, ProviderAdapter } from "../../host/providers/types.ts";
import { Host, ROOT } from "./harness.ts";

const FAKE = join(ROOT, "tests/fake-acp/fake-acp.mjs");
const GJC_MODE = join(ROOT, "tests/fake-acp/gjc-mode.mjs");

/** Shaped like GJC 0.21.1's session/new answer (docs/acp-probe/0.21.0 usage-*.jsonl), fewer presets. */
const CONFIG = [
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  { id: "model", name: "Preset", category: "model", type: "select", currentValue: "light-mix", options: [{ value: "light-mix", name: "Light Mix" }, { value: "claude-opus", name: "Claude Opus" }] },
  { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "medium", options: ["off", "minimal", "low", "medium", "high"].map((v) => ({ value: v, name: v })) },
  { id: "steeringMode", name: "Steering", type: "select", currentValue: "one-at-a-time", options: [{ value: "all", name: "All" }, { value: "one-at-a-time", name: "One at a time" }] },
];
const MODES = { availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }], currentModeId: "default" };
const COMMANDS = [{ name: "progress", description: "Show progress" }, { name: "skill:ralplan", description: "Plan by consensus", input: { hint: "[request]" } }];

type Setup = { adapter: ProviderAdapter; events: NormalizedEvent[]; logs: string[]; dir: string; log: () => { method: string; params: any }[]; close: () => Promise<void> };

async function setup(scenario: Record<string, unknown>, { gjc = true, session = null as string | null, dir = mkdtempSync(join(tmpdir(), "acp-settings-")) } = {}): Promise<Setup> {
  const wrapper = join(dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`); chmodSync(wrapper, 0o700);
  const file = join(dir, "scenario.json"); writeFileSync(file, JSON.stringify(scenario));
  const env = { ...(gjc ? { FAKE_ACP_MODE: GJC_MODE, GJC_CODING_AGENT_DIR: join(dir, "agent-dir") } : {}), FAKE_ACP_SCENARIO: file, FAKE_ACP_LOG: join(dir, "log"), FAKE_ACP_STORE: join(dir, "store") };
  const old = { ...process.env };
  Object.assign(process.env, env);
  const events: NormalizedEvent[] = [], logs: string[] = [];
  const opts = { command: wrapper, cwd: dir, stateDir: dir, args: [], log: (s: string) => logs.push(s) };
  const adapter = gjc ? new GjcAdapter(opts) : createAcpAgent({ id: "fake-acp", name: "Fake", command: wrapper, args: [], env: {} }, opts);
  try { await adapter.start(session, { emit: (e) => events.push(e), log: (s) => logs.push(s), running: false, working: false }); } finally {
    Object.keys(process.env).forEach((key) => { if (!(key in old)) delete process.env[key]; }); Object.assign(process.env, old);
  }
  const log = () => existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8").trim().split("\n").map((s) => JSON.parse(s)) : [];
  return { adapter, events, logs, dir, log, close: async () => { await adapter.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
const last = <T extends NormalizedEvent["type"]>(events: NormalizedEvent[], type: T) => events.filter((e): e is Extract<NormalizedEvent, { type: T }> => e.type === type).at(-1);
async function wait(check: () => boolean, timeout = 3000) { const until = Date.now() + timeout; while (!check()) { if (Date.now() > until) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } }

test("configOptions become the model, thinking levels and modes; changes go through session/set_config_option and session/set_mode", async () => {
  const t = await setup({ configOptions: CONFIG, modes: MODES });
  try {
    assert.deepEqual(last(t.events, "model")?.model, { provider: "gjc", id: "light-mix", name: "Light Mix", reasoning: true, contextWindow: null, input: ["text"] });
    assert.equal(last(t.events, "thinking")?.level, "medium");
    assert.equal(last(t.events, "permission_mode")?.mode, "default");
    assert.deepEqual(t.adapter.capabilities.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
    assert.deepEqual(t.adapter.capabilities.permissionModes, [{ id: "default", label: "Default" }, { id: "plan", label: "Plan" }]);
    assert.equal(t.adapter.capabilities.fork, false);
    assert.equal(t.adapter.forkPoints, undefined);
    assert.deepEqual((await t.adapter.listModels()).map((m) => `${m.provider}/${m.id} ${m.name}`), ["gjc/light-mix Light Mix", "gjc/claude-opus Claude Opus"]);

    await t.adapter.setModel("gjc", "claude-opus");
    await t.adapter.setThinking("high");
    await t.adapter.setPermissionMode("plan");
    const sets = t.log().filter((m) => m.method === "session/set_config_option").map((m) => [m.params.configId, m.params.value]);
    assert.deepEqual(sets, [["model", "claude-opus"], ["thinking", "high"]]);
    assert.deepEqual(t.log().filter((m) => m.method === "session/set_mode").map((m) => m.params.modeId), ["plan"]);
    assert.equal(last(t.events, "model")?.model.id, "claude-opus");
    assert.equal(last(t.events, "model")?.model.name, "Claude Opus");
    assert.equal(last(t.events, "thinking")?.level, "high");
    assert.equal(last(t.events, "permission_mode")?.mode, "plan");
    // The answer and the config_option_update that came with it report the model once.
    assert.equal(t.events.filter((e) => e.type === "model" && e.model.id === "claude-opus").length, 1);
    await assert.rejects(t.adapter.setThinking("extreme"), /no thinking level "extreme"/);
    await assert.rejects(t.adapter.setPermissionMode("yolo"), /no mode "yolo"/);
  } finally { await t.close(); }
});

test("the set_config_option answer alone updates the settings (no config_option_update)", async () => {
  const t = await setup({ configOptions: CONFIG, modes: MODES, quietConfig: true });
  try {
    await t.adapter.setModel("gjc", "claude-opus");
    await t.adapter.setThinking("low");
    assert.equal(last(t.events, "model")?.model.id, "claude-opus");
    assert.equal(last(t.events, "thinking")?.level, "low");
  } finally { await t.close(); }
});

test("a refused change shows the setting the agent still has, with one notice", async () => {
  const t = await setup({ configOptions: CONFIG, modes: MODES, refuse: ["model", "plan"] });
  try {
    const before = t.events.filter((e) => e.type === "model").length;
    await assert.rejects(t.adapter.setModel("gjc", "claude-opus"), /Unsupported model: claude-opus/);
    assert.equal(t.events.filter((e) => e.type === "model").length, before + 1);
    assert.equal(last(t.events, "model")?.model.id, "light-mix");
    assert.equal(t.events.filter((e) => e.type === "notice" && e.text.includes("didn't change the model")).length, 1);
    await assert.rejects(t.adapter.setPermissionMode("plan"), /plan is not available/);
    assert.equal(last(t.events, "permission_mode")?.mode, "default");
    assert.equal(t.events.filter((e) => e.type === "notice" && e.text.includes("didn't change the mode:")).length, 1);
  } finally { await t.close(); }
});

test("an agent without configOptions or modes has no model, thinking or mode settings", async () => {
  const t = await setup({}, { gjc: false });
  try {
    assert.deepEqual(await t.adapter.listModels(), []);
    assert.deepEqual(t.adapter.capabilities.thinkingLevels, []);
    assert.deepEqual(t.adapter.capabilities.permissionModes, []);
    assert.ok(!t.events.some((e) => e.type === "model" || e.type === "thinking"));
    await assert.rejects(t.adapter.setModel("fake-acp", "x"), /no model setting/);
    assert.deepEqual(await t.adapter.commands(), []);
  } finally { await t.close(); }
});

test("available_commands_update is the command list; GJC's skill: commands are skills", async () => {
  const t = await setup({ commands: COMMANDS, commandsDelay: 200 });
  try {
    assert.deepEqual(await t.adapter.commands(), [
      { name: "progress", description: "Show progress", source: "extension" },
      { name: "skill:ralplan", description: "Plan by consensus", source: "skill" },
    ]);
  } finally { await t.close(); }
});

test("session/list: Date.parse of updatedAt, newest first, unknown times last, the GJC session file as path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-settings-"));
  const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
  const sessions = [
    { sessionId: id(1), cwd: dir, title: "utc", updatedAt: "2026-11-01T10:00:00Z" },
    { sessionId: id(2), cwd: dir, title: "offset, later", updatedAt: "2026-11-01T20:00:00+09:00" }, // 11:00Z
    { sessionId: id(3), cwd: dir, title: "no time" },
    { sessionId: id(4), cwd: dir, title: "millis", updatedAt: "2026-11-01T10:00:00.500Z" },
    { sessionId: id(5), cwd: dir, title: "bad", updatedAt: "yesterday" },
    { sessionId: id(6), cwd: "/elsewhere", title: "", updatedAt: "2026-11-01T10:00:00Z" },
  ];
  const t = await setup({ sessions }, { dir });
  try {
    if (t.adapter.sessions.kind !== "agent") throw new Error("agent sessions");
    const list = await t.adapter.sessions.list("cwd");
    assert.deepEqual(list.map((s) => s.name), ["offset, later", "millis", "utc", null, "no time", "bad"]);
    assert.deepEqual(list.map((s) => s.modified), [Date.parse("2026-11-01T11:00:00Z"), Date.parse("2026-11-01T10:00:00.500Z"), Date.parse("2026-11-01T10:00:00Z"), Date.parse("2026-11-01T10:00:00Z"), 0, 0]);
    assert.ok(list.every((s) => s.firstMessage === "" && s.messageCount === null));
    assert.equal(list[3]!.cwd, "/elsewhere");
    assert.equal(list[0]!.path, id(2), "no session file: the id");
    assert.ok(t.logs.some((l) => l.includes(`${id(3)}: no usable updatedAt (none)`)) && t.logs.some((l) => l.includes("(yesterday)")));
    assert.deepEqual(t.log().filter((m) => m.method === "session/list").map((m) => m.params), [{ cwd: dir }]);
    await t.adapter.sessions.list("all");
    assert.deepEqual(t.log().filter((m) => m.method === "session/list").at(-1)!.params, {});
  } finally { await t.close(); }
});

test("switchSession loads the other session, replays it, takes its settings and closes the old one; newSession starts empty", async () => {
  const t = await setup({ mode: "basic", configOptions: CONFIG, modes: MODES, commands: COMMANDS });
  try {
    await t.adapter.prompt({ id: "a", text: "first session", images: [], mode: "auto", busy: false });
    const first = last(t.events, "session")!;
    assert.ok(first.file && first.file.endsWith(`_${first.id}.jsonl`), "GJC's own session file");
    await t.adapter.setModel("gjc", "claude-opus");
    await t.adapter.newSession();
    const second = last(t.events, "session")!;
    assert.notEqual(second.id, first.id);
    assert.deepEqual(await t.adapter.history(), []);
    assert.equal(last(t.events, "model")?.model.id, "light-mix", "the new session's own settings");
    await wait(() => t.log().some((m) => m.method === "session/close"));
    assert.deepEqual(t.log().filter((m) => m.method === "session/close").map((m) => m.params.sessionId), [first.id]);

    if (t.adapter.sessions.kind !== "agent") throw new Error("agent sessions");
    const listed = await t.adapter.sessions.list("cwd");
    assert.ok(listed.some((s) => s.path === first.file), "the list gives the session file");
    await t.adapter.switchSession(first.file!);
    assert.equal(last(t.events, "session")?.id, first.id);
    assert.equal(last(t.events, "session")?.file, first.file);
    assert.ok((await t.adapter.history()).some((e) => e.type === "user_message" && e.text === "first session"));
    assert.deepEqual(t.log().filter((m) => m.method === "session/load").map((m) => m.params.sessionId), [first.id]);
    await wait(() => t.log().filter((m) => m.method === "session/close").length === 2);
    assert.equal(t.log().filter((m) => m.method === "session/close").at(-1)!.params.sessionId, second.id);
    assert.ok((await t.adapter.commands()).some((c) => c.source === "skill"));
    await assert.rejects(t.adapter.switchSession("/nowhere/not-a-session"), /not a GJC session/);
    await assert.rejects(t.adapter.switchSession(join(t.dir, "x_00000000-0000-4000-8000-00000000dead.jsonl")));
    assert.equal(last(t.events, "session")?.id, first.id, "a refused load keeps the session");
    const sent = Date.now();
    await t.adapter.prompt({ id: "b", text: "still here", images: [], mode: "auto", busy: false });
    assert.ok(Date.now() - sent < 3000, "GJC's idle hints still settle the run (no 5 s gate timeout)");
    assert.ok(t.logs.some((l) => l === "GJC settle gate passed") && !t.logs.some((l) => l.includes("settle gate timed out")));
    assert.equal(t.log().filter((m) => m.method === "session/prompt").at(-1)!.params.sessionId, first.id);
  } finally { await t.close(); }
});

for (const when of ["stray", "strayDuring"]) {
  test(`output and asks of the session left behind don't reach the chat (${when === "stray" ? "after" : "during"} the change)`, async () => {
    const t = await setup({ [when]: true });
    try {
      await t.adapter.newSession();
      await wait(() => t.log().some((m) => m.method === "permission/response"));
      assert.ok(!t.events.some((e) => e.type === "assistant_delta" && e.delta === "stray"));
      assert.ok(!t.events.some((e) => e.type === "ask"));
      assert.deepEqual(t.log().find((m) => m.method === "permission/response")!.params, { outcome: { outcome: "cancelled" } });
    } finally { await t.close(); }
  });
}

test("a session change stops the running prompt first and drops its queue", async () => {
  const t = await setup({ mode: "steer", delay: 5000, steer: "turn_not_active" });
  try {
    const running = t.adapter.prompt({ id: "a", text: "long", images: [], mode: "auto", busy: false });
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt({ id: "b", text: "queued", images: [], mode: "auto", busy: true });
    const started = Date.now();
    await t.adapter.newSession();
    assert.ok(Date.now() - started < 3000, "it doesn't wait for the turn to end on its own");
    await running;
    assert.ok(t.log().some((m) => m.method === "session/cancel"));
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
    assert.deepEqual(last(t.events, "queue_changed")?.followUp, []);
    assert.deepEqual(t.log().filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text), ["long"], "the queue is not sent");
  } finally { await t.close(); }
});

test("a prompt that ignores the cancel and answers after the session changed opens no run in the new one", async () => {
  const t = await setup({ mode: "steer", delay: 6500, deaf: true });
  try {
    const running = t.adapter.prompt({ id: "a", text: "long", images: [], mode: "auto", busy: false });
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.newSession();
    const settled = t.events.filter((e) => e.type === "run_settled").length;
    const started = t.events.filter((e) => e.type === "run_started").length;
    await running;
    assert.equal(t.events.filter((e) => e.type === "run_started").length, started, "the late answer opens no run");
    assert.equal(settled, 1);
    await t.adapter.prompt({ id: "b", text: "next", images: [], mode: "auto", busy: false });
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 2, "the next prompt's run settles");
    assert.equal(t.log().filter((m) => m.method === "session/prompt").at(-1)!.params.sessionId, last(t.events, "session")!.id);
  } finally { await t.close(); }
});

test("a message sent while the session changes goes to the new session; a second change is refused", async () => {
  const t = await setup({ mode: "basic" });
  try {
    const first = last(t.events, "session")!.id;
    const change = t.adapter.newSession();
    await assert.rejects(t.adapter.newSession(), /already switching sessions/);
    const sent = t.adapter.prompt({ id: "m", text: "during", images: [], mode: "auto", busy: false });
    await change; await sent;
    const second = last(t.events, "session")!.id;
    assert.notEqual(second, first);
    const prompts = t.log().filter((m) => m.method === "session/prompt");
    assert.deepEqual(prompts.map((m) => [m.params.sessionId, m.params.prompt[0].text]), [[second, "during"]]);
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
  } finally { await t.close(); }
});

test("a setting answered after the session changed doesn't show on the new session", async () => {
  const t = await setup({ configOptions: CONFIG, modes: MODES, setDelay: 300 });
  try {
    const slow = t.adapter.setModel("gjc", "claude-opus");
    await wait(() => t.log().some((m) => m.method === "session/set_config_option"));
    await t.adapter.newSession();
    await slow;
    assert.equal(last(t.events, "model")?.model.id, "light-mix", "the new session's own model");
  } finally { await t.close(); }
});

test("a message waiting on a failing change goes to the session the chat is still on", async () => {
  const t = await setup({ mode: "basic" });
  try {
    const first = last(t.events, "session")!.id;
    const bad = join(t.dir, "x_00000000-0000-4000-8000-00000000dead.jsonl");
    const change = t.adapter.switchSession(bad);
    const sent = t.adapter.prompt({ id: "m", text: "waits", images: [], mode: "auto", busy: false });
    await assert.rejects(change);
    await sent;
    assert.deepEqual(t.log().filter((m) => m.method === "session/prompt").map((m) => [m.params.sessionId, m.params.prompt[0].text]), [[first, "waits"]]);
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
  } finally { await t.close(); }
});

test("compact runs compaction.run and reports start and end; a refusal fails it", async () => {
  const t = await setup({ compactDelay: 100 });
  try {
    assert.equal(t.adapter.capabilities.compact, true);
    assert.equal(t.adapter.capabilities.compactInstructions, false);
    await t.adapter.compact();
    const control = t.log().filter((m) => m.method === "_gjc/sdk/control").at(-1)!;
    assert.deepEqual([control.params.operation, control.params.input], ["compaction.run", {}]);
    assert.deepEqual(t.events.filter((e) => e.type === "compaction"), [{ type: "compaction", phase: "start", reason: "manual" }, { type: "compaction", phase: "end", outcome: "done" }]);
  } finally { await t.close(); }
  const f = await setup({ compaction: "failed" });
  try {
    await assert.rejects(f.adapter.compact(), /invalid_state: Nothing to compact/);
    assert.deepEqual(last(f.events, "compaction"), { type: "compaction", phase: "end", outcome: "failed", error: "invalid_state: Nothing to compact" });
    assert.equal(f.adapter.capabilities.compact, true);
  } finally { await f.close(); }
});

test("GJC's own compaction (session_info_update._meta) becomes compaction events", async () => {
  const meta = (m: Record<string, unknown>) => ({ type: "meta", update: { sessionUpdate: "session_info_update", _meta: m }, record: false });
  const t = await setup({ actions: [] });
  try {
    // The fake GJC mode has no scripted actions; drive the updates through the adapter's own handler.
    const update = (m: Record<string, unknown>) => (t.adapter as unknown as { onUpdate(u: unknown): void }).onUpdate(meta(m).update);
    update({ gjcPhase: "compacting", gjcCompactionState: "start", gjcCompactionTrigger: "overflow", gjcRunning: true });
    update({ gjcPhase: "compacting", gjcCompactionState: "start", gjcRunning: true });
    update({ gjcPhase: "responding", gjcCompactionState: "end", gjcCompactionAborted: false, gjcRunning: true });
    update({ gjcPhase: "compacting", gjcCompactionState: "start", gjcCompactionTrigger: "threshold", gjcRunning: true });
    update({ gjcPhase: "idle", gjcCompactionState: "end", gjcCompactionErrorMessage: "model refused", gjcRunning: false });
    update({ gjcPhase: "idle", gjcCompactionState: "end", gjcRunning: false });
    assert.deepEqual(t.events.filter((e) => e.type === "compaction"), [
      { type: "compaction", phase: "start", reason: "overflow" },
      { type: "compaction", phase: "end", outcome: "done" },
      { type: "compaction", phase: "start", reason: "auto" },
      { type: "compaction", phase: "end", outcome: "failed", error: "model refused" },
    ]);
  } finally { await t.close(); }
});

test("setName sends session.rename and names the session", async () => {
  const t = await setup({});
  try {
    assert.equal(t.adapter.capabilities.rename, true);
    await t.adapter.setName("my work");
    const control = t.log().filter((m) => m.method === "_gjc/sdk/control").at(-1)!;
    assert.deepEqual([control.params.operation, control.params.input], ["session.rename", { name: "my work" }]);
    assert.equal(last(t.events, "session")?.name, "my work");
  } finally { await t.close(); }
});

test("usage: context from the last usage_update, cost from usage.get (FINDINGS fact 14)", async () => {
  const t = await setup({ actions: [] });
  try {
    assert.deepEqual(await t.adapter.usage(), { contextTokens: null, contextWindow: null, percent: null, cost: 0.0016124 });
    (t.adapter as unknown as { onUpdate(u: unknown): void }).onUpdate({ sessionUpdate: "usage_update", size: 200000, used: 50000 });
    assert.deepEqual(await t.adapter.usage(), { contextTokens: 50000, contextWindow: 200000, percent: 25, cost: 0.0016124 });
    assert.equal(t.adapter.capabilities.cost, true);
    assert.equal(last(t.events, "capabilities")?.capabilities.cost, true);
    const query = t.log().filter((m) => m.method === "_gjc/sdk/query").at(-1)!;
    assert.equal(query.params.query, "usage.get");
  } finally { await t.close(); }
  const u = await setup({ usage: "unknown_operation" });
  try {
    (u.adapter as unknown as { onUpdate(x: unknown): void }).onUpdate({ sessionUpdate: "usage_update", size: 200000, used: 50000 });
    assert.deepEqual(await u.adapter.usage(), { contextTokens: 50000, contextWindow: 200000, percent: 25, cost: null });
    assert.equal(u.adapter.capabilities.cost, false);
    assert.ok(u.logs.some((l) => l.includes("GJC usage.get gave no cost (unknown_operation)")));
    assert.ok(!u.events.some((e) => e.type === "notice"));
  } finally { await u.close(); }
});

test("a GJC without SDK methods (-32601) turns compaction and renaming off with a notice", async () => {
  const t = await setup({ sdk: "method_not_found" });
  try {
    await assert.rejects(t.adapter.compact(), /method_not_found/);
    assert.equal(t.adapter.capabilities.compact, false);
    assert.ok(t.events.some((e) => e.type === "capabilities" && e.capabilities.compact === false));
    await assert.rejects(t.adapter.setName("x"), /method_not_found/);
    assert.equal(t.adapter.capabilities.rename, false);
    assert.equal(t.events.filter((e) => e.type === "notice" && /This GJC can't/.test(e.text)).length, 2);
    assert.equal((await t.adapter.usage()).cost, null);
    assert.equal(t.adapter.capabilities.cost, false);
  } finally { await t.close(); }
});

async function realHost(name: string, scenario: Record<string, unknown>) {
  const host = new Host({ name, provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`); chmodSync(wrapper, 0o700);
  const file = join(host.dir, "scenario.json"); writeFileSync(file, JSON.stringify(scenario));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: file, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  await host.client.waitFor((c) => c.state.phase === "idle", 5000);
  return host;
}

test("real host: chips, / menu, /compact, /name, /resume and no /fork", async () => {
  const host = await realHost("gjc-settings", { configOptions: CONFIG, modes: MODES, commands: COMMANDS });
  try {
    const c = host.client;
    await c.waitFor((x) => x.state.model?.id === "light-mix" && x.state.thinking === "medium" && x.state.permissionMode === "default", 5000);
    assert.deepEqual(c.state.capabilities.permissionModes.map((m: { label: string }) => m.label), ["Default", "Plan"]);
    await c.waitFor((x) => x.state.commands.some((cmd: { name: string; source: string }) => cmd.name === "skill:ralplan" && cmd.source === "skill"), 5000);
    const names = c.state.commands.map((cmd: { name: string }) => cmd.name);
    assert.ok(names.includes("compact") && names.includes("name") && names.includes("thinking"));
    assert.ok(!names.includes("fork") && !names.includes("tui"));

    await c.req("set_model", { provider: "gjc", modelId: "claude-opus" });
    await c.req("set_thinking", { level: "high" });
    await c.req("set_permission_mode", { mode: "plan" });
    await c.waitFor((x) => x.state.model?.id === "claude-opus" && x.state.thinking === "high" && x.state.permissionMode === "plan", 2000);

    await c.req("send", { text: "/compact" });
    await c.waitFor((x) => x.items.some((i: { kind: string; text?: string }) => i.kind === "notice" && i.text === "Compacted the conversation."), 5000);
    await c.req("send", { text: "/name my work" });
    await c.waitFor((x) => x.state.sessionName === "my work", 2000);

    await c.req("send", { text: "hello" });
    await c.waitFor((x) => x.state.phase === "idle" && x.items.some((i: { kind: string; text?: string }) => i.kind === "assistant" && i.text?.includes("answer")), 5000);
    const first = c.state.sessionFile;
    await c.req("send", { text: "/new" });
    await c.waitFor((x) => x.state.sessionFile !== first && x.state.sessionFile, 5000);
    await c.waitFor((x) => x.state.model?.id === "light-mix", 2000);
    const { sessions } = await c.req("sessions", { scope: "cwd", refresh: true });
    assert.ok(sessions.some((s: { path: string }) => s.path === first), "this cwd's GJC session is listed");
    await c.req("switch_session", { path: first });
    await c.waitFor((x) => x.state.sessionFile === first && x.items.some((i: { kind: string; text?: string }) => i.kind === "user" && i.text === "hello"), 5000);
  } finally { await host.stop(); }
});
