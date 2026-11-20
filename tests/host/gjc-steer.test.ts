import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GjcAdapter } from "../../host/providers/gjc/adapter.ts";
import type { NormalizedEvent } from "../../host/providers/types.ts";
import { Host, ROOT } from "./harness.ts";

/** The fake ACP agent flavoured like GJC; mode `steer` holds its first turn open and answers turn.steer per `steer`. */
const GJC_MODE = join(ROOT, "tests/fake-acp/gjc-mode.mjs");
const FAKE = join(ROOT, "tests/fake-acp/fake-acp.mjs");

async function setup(extra: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "gjc-steer-"));
  const wrapper = join(dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "steer", ...extra }));
  const old = { ...process.env };
  Object.assign(process.env, { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(dir, "log"), FAKE_ACP_STORE: join(dir, "store"), GJC_CODING_AGENT_DIR: join(dir, "agent-dir") });
  const events: NormalizedEvent[] = [], logs: string[] = [];
  const adapter = new GjcAdapter({ command: wrapper, cwd: dir, stateDir: dir, args: [], log: (s) => logs.push(s) });
  await adapter.start(null, { emit: (e) => events.push(e), log: (s) => logs.push(s), running: false, working: false });
  Object.keys(process.env).forEach((key) => { if (!(key in old)) delete process.env[key]; }); Object.assign(process.env, old);
  const messages = () => readFileSync(join(dir, "log"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
  return {
    adapter, events, logs,
    prompts: () => messages().filter((m: any) => m.method === "session/prompt").map((m: any) => m.params.prompt[0].text),
    steers: () => messages().filter((m: any) => m.method === "_gjc/sdk/control"),
    close: async () => { await adapter.dispose(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const p = (text: string, busy = false, more: { mode?: "auto" | "steer" | "followUp"; images?: { data: string; mimeType: string }[] } = {}) => ({ id: `id-${text}`, text, images: more.images ?? [], mode: more.mode ?? ("auto" as const), busy });
async function wait(check: () => boolean, timeout = 3000) { const until = Date.now() + timeout; while (!check()) { if (Date.now() > until) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } }
const queues = (events: NormalizedEvent[]) => events.filter((e): e is Extract<NormalizedEvent, { type: "queue_changed" }> => e.type === "queue_changed");

test("an accepted steer shows in the steering lane, then joins the turn as the host's own user message", async () => {
  const t = await setup({ delay: 500 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    assert.equal((await t.adapter.prompt(p("steer me", true))).disposition, "queued");
    const [control] = t.steers();
    assert.equal(control.params.operation, "turn.steer");
    assert.deepEqual(control.params.input, { text: "steer me", clientRef: "id-steer me" });
    const lanes = queues(t.events);
    assert.deepEqual(lanes[0], { type: "queue_changed", steering: ["steer me"], steeringIds: ["id-steer me"], followUp: [], followUpIds: [] });
    assert.deepEqual(lanes.at(-1)?.steering, []);
    const echo = t.events.findIndex((e) => e.type === "user_message" && e.text === "steer me");
    assert.ok(echo > t.events.indexOf(lanes[0]!) && echo < t.events.indexOf(lanes.at(-1)!), "echoed before the lane clears");
    assert.equal((t.events[echo] as { clientId?: string }).clientId, "id-steer me");
    await running;
    await wait(() => t.events.some((e) => e.type === "run_settled"));
    assert.deepEqual(t.prompts(), ["first"], "a steer is not a second prompt");
    assert.ok(t.events.some((e) => e.type === "assistant_delta" && e.delta === "answer steer me"));
    assert.equal(t.adapter.capabilities.steer, true);
  } finally { await t.close(); }
});

for (const code of ["turn_not_active", "invalid_input", "client_ref_conflict"]) {
  test(`a ${code} refusal during the run queues the message and keeps steering on`, async () => {
    const t = await setup({ delay: 400, steer: code });
    try {
      const running = t.adapter.prompt(p("first"));
      await wait(() => t.events.some((e) => e.type === "run_started"));
      assert.equal((await t.adapter.prompt(p("later", true))).disposition, "queued");
      assert.deepEqual(queues(t.events).at(-1), { type: "queue_changed", steering: [], steeringIds: [], followUp: ["later"], followUpIds: ["id-later"] });
      assert.equal(t.events.filter((e) => e.type === "notice" && e.text.includes("didn't take the steer")).length, 1);
      assert.ok(!t.events.some((e) => e.type === "user_message" && e.text === "later"));
      assert.ok(!t.events.some((e) => e.type === "capabilities" && e.capabilities.steer === false));
      assert.equal(t.adapter.capabilities.steer, true);
      await running;
      await wait(() => t.prompts().length === 2 && t.events.some((e) => e.type === "run_settled"));
      assert.deepEqual(t.prompts(), ["first", "later"]);
    } finally { await t.close(); }
  });
}

test("a refusal after the run ended sends the message as a new prompt", async () => {
  const t = await setup({ delay: 50, steer: "turn_not_active", steerDelay: 800 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    const late = t.adapter.prompt(p("late", true));
    await running;
    await wait(() => t.events.some((e) => e.type === "run_settled"));
    assert.equal((await late).disposition, "started");
    assert.deepEqual(t.prompts(), ["first", "late"]);
    assert.ok(t.events.some((e) => e.type === "run_cause" && e.text.includes("as the last turn ended")));
    assert.ok(t.events.some((e) => e.type === "user_message" && e.text === "late" && e.clientId === "id-late"), "the prompt's own echo");
    assert.ok(!t.events.some((e) => e.type === "notice" && e.text.includes("didn't take the steer")));
  } finally { await t.close(); }
});

for (const [answer, why] of [["method_not_found", "no _gjc/sdk/control (-32601)"], ["unknown_operation", "no turn.steer"]] as const) {
  test(`${why} turns steering off for the session and queues`, async () => {
    const t = await setup({ delay: 400, steer: answer });
    try {
      const running = t.adapter.prompt(p("first"));
      await wait(() => t.events.some((e) => e.type === "run_started"));
      assert.equal((await t.adapter.prompt(p("one", true))).disposition, "queued");
      assert.equal((await t.adapter.prompt(p("two", true))).disposition, "queued");
      assert.equal(t.steers().length, 1, "no second steer once it is off");
      assert.equal(t.adapter.capabilities.steer, false);
      assert.equal(t.events.filter((e) => e.type === "capabilities" && e.capabilities.steer === false).length, 1);
      assert.equal(t.events.filter((e) => e.type === "notice" && e.text.includes("can't steer")).length, 1);
      assert.deepEqual(queues(t.events).at(-1)?.followUp, ["one", "two"]);
      await running;
      await wait(() => t.prompts().length === 3);
      assert.deepEqual(t.prompts(), ["first", "one", "two"]);
    } finally { await t.close(); }
  });
}

test("an unknown_operation naming undefined is a request bug: steering stays on", async () => {
  const t = await setup({ delay: 400, steer: "unknown_undefined" });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt(p("one", true));
    await t.adapter.prompt(p("two", true));
    assert.equal(t.steers().length, 2);
    assert.equal(t.adapter.capabilities.steer, true);
    assert.ok(t.logs.some((line) => line.includes("steer rejected: unknown_operation: Unknown SDK control: undefined")));
    await running;
  } finally { await t.close(); }
});

test("images and follow-ups skip the steer and wait in the queue", async () => {
  const t = await setup({ delay: 400 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt(p("picture", true, { images: [{ data: "AA==", mimeType: "image/png" }] }));
    await t.adapter.prompt(p("after", true, { mode: "followUp" }));
    assert.equal(t.steers().length, 0);
    assert.deepEqual(queues(t.events).at(-1)?.followUp, ["picture", "after"]);
    await running;
  } finally { await t.close(); }
});

test("Esc while a steer is on its way waits for its answer: a taken steer stays in the timeline", async () => {
  const t = await setup({ delay: 1500, steerDelay: 300 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    const steer = t.adapter.prompt(p("in flight", true));
    await wait(() => t.steers().length === 1);
    assert.deepEqual(await t.adapter.clearQueue(), []);
    assert.ok(t.events.some((e) => e.type === "user_message" && e.text === "in flight" && e.clientId === "id-in flight"));
    assert.deepEqual(queues(t.events).at(-1)?.steering, []);
    assert.equal((await steer).disposition, "queued");
    t.adapter.abort();
    await running;
  } finally { await t.close(); }
});

test("Esc while a steer is on its way gives a refused one back, without a notice", async () => {
  const t = await setup({ delay: 1500, steerDelay: 300, steer: "turn_not_active" });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    const steer = t.adapter.prompt(p("in flight", true));
    await wait(() => t.steers().length === 1);
    assert.deepEqual(await t.adapter.clearQueue(), ["in flight"]);
    assert.equal((await steer).disposition, "queued");
    assert.deepEqual(queues(t.events).at(-1), { type: "queue_changed", steering: [], steeringIds: [], followUp: [], followUpIds: [] });
    assert.ok(!t.events.some((e) => e.type === "notice" && e.text.includes("didn't take the steer")));
    assert.ok(!t.events.some((e) => e.type === "user_message" && e.text === "in flight"));
    t.adapter.abort();
    await running;
  } finally { await t.close(); }
});

test("Esc gives back a steer still unanswered after 2 s, and warns when GJC takes it late", async () => {
  const t = await setup({ delay: 4000, steerDelay: 2600 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    const steer = t.adapter.prompt(p("slow", true));
    await wait(() => t.steers().length === 1);
    assert.deepEqual(await t.adapter.clearQueue(), ["slow"]);
    assert.equal((await steer).disposition, "queued");
    assert.ok(!t.events.some((e) => e.type === "user_message" && e.text === "slow"));
    assert.equal(t.events.filter((e) => e.type === "notice" && e.text.includes("took a steer after it went back")).length, 1);
    t.adapter.abort();
    await running;
  } finally { await t.close(); }
});

test("a steer GJC accepted as a follow-up between turns is taken back and waits in our queue", async () => {
  const t = await setup({ delay: 400, admit: false });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    assert.equal((await t.adapter.prompt(p("between", true))).disposition, "queued");
    const ops = t.steers().map((m: any) => m.params.operation);
    assert.deepEqual(ops, ["turn.steer", "queue.message.remove"]);
    assert.ok(!t.events.some((e) => e.type === "user_message" && e.text === "between"));
    assert.deepEqual(queues(t.events).at(-1)?.followUp, ["between"]);
    assert.equal(t.adapter.capabilities.steer, true);
    await running;
    await wait(() => t.prompts().length === 2);
    assert.deepEqual(t.prompts(), ["first", "between"]);
  } finally { await t.close(); }
});

test("a follow-up GJC won't give back stays accepted, logged, not sent twice", async () => {
  const t = await setup({ delay: 400, admit: false, keep: true });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt(p("kept", true));
    assert.ok(t.events.some((e) => e.type === "user_message" && e.text === "kept"));
    assert.ok(t.logs.some((line) => line.includes("GJC queued the steer as a follow-up and kept it")));
    assert.equal(t.events.filter((e) => e.type === "notice" && e.text.includes("runs it on its own")).length, 1);
    await running;
    await wait(() => t.events.some((e) => e.type === "run_settled"));
    assert.deepEqual(t.prompts(), ["first"]);
  } finally { await t.close(); }
});

test("after GJC answers the prompt, Enter waits in the queue instead of steering the run's tail", async () => {
  const t = await setup({ delay: 50, tail: 600 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await wait(() => t.logs.some((line) => line.includes("GJC prompt response")));
    assert.equal((await t.adapter.prompt(p("after", true))).disposition, "queued");
    assert.equal(t.steers().length, 0);
    assert.deepEqual(queues(t.events).at(-1)?.followUp, ["after"]);
    await running;
    await wait(() => t.prompts().length === 2);
    assert.deepEqual(t.prompts(), ["first", "after"]);
  } finally { await t.close(); }
});

async function realHost(name: string, scenario: Record<string, unknown>) {
  const host = new Host({ name, provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`); chmodSync(wrapper, 0o700);
  const file = join(host.dir, "scenario.json"); writeFileSync(file, JSON.stringify({ mode: "steer", ...scenario }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: file, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  await host.client.waitFor((c) => c.state.phase === "idle", 5000);
  return host;
}

test("real host: Enter while GJC works steers, and the message lands once in the timeline", async () => {
  const host = await realHost("gjc-steer", { delay: 1200, steerDelay: 400 });
  try {
    assert.equal(host.client.state.capabilities.steer, true);
    const first = host.client.req("send", { text: "first" });
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    // The lane shows the steer until GJC answers it (the send's reply waits for that answer).
    const steer = host.client.req("send", { text: "end with BANANA" });
    await host.client.waitFor((c) => c.state.queue.steering.includes("end with BANANA"), 1000);
    assert.equal((await steer).disposition, "queued");
    await first;
    await host.client.waitFor((c) => c.state.phase === "idle" && c.items.some((item) => item.kind === "assistant" && item.text.includes("BANANA")), 5000);
    assert.equal(host.client.items.filter((item) => item.kind === "user" && item.text === "end with BANANA").length, 1);
    assert.deepEqual(host.client.state.queue, { steering: [], followUp: [] });
  } finally { await host.stop(); }
});

test("real host: a refused steer waits as a follow-up, and Esc gives it back to the composer", async () => {
  const host = await realHost("gjc-steer-abort", { delay: 3000, steer: "turn_not_active" });
  try {
    const first = host.client.req("send", { text: "first" });
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    await host.client.req("send", { text: "keep me" });
    await host.client.waitFor((c) => c.state.queue.followUp.includes("keep me"), 1000);
    assert.deepEqual((await host.client.req("abort")).restored, ["keep me"]);
    await first;
    await host.client.waitFor((c) => c.state.phase === "idle", 5000);
    assert.ok(!host.client.items.some((item) => item.kind === "user" && item.text === "keep me"));
  } finally { await host.stop(); }
});

test("real host: steering off shows in capabilities so the composer hint says queues", async () => {
  const host = await realHost("gjc-steer-off", { delay: 600, steer: "method_not_found" });
  try {
    const first = host.client.req("send", { text: "first" });
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    await host.client.req("send", { text: "queued" });
    await host.client.waitFor((c) => c.state.capabilities.steer === false && c.state.queue.followUp.includes("queued"), 1000);
    await first;
    await host.client.waitFor((c) => c.state.phase === "idle" && c.items.some((item) => item.kind === "user" && item.text === "queued"), 5000);
  } finally { await host.stop(); }
});

test("real host: a steer while an approval card is up leaves the card, and joins the turn once it is answered", async () => {
  const host = await realHost("gjc-steer-ask", { ask: true });
  try {
    const first = host.client.req("send", { text: "first" });
    await host.client.waitFor((c) => c.state.dialog?.method === "permission", 5000);
    const dialog = host.client.state.dialog;
    assert.equal((await host.client.req("send", { text: "end with BANANA" })).disposition, "queued");
    assert.equal(host.client.state.dialog?.id, dialog.id, "the card is still up");
    await host.client.waitFor((c) => c.items.some((item) => item.kind === "user" && item.text === "end with BANANA"), 2000);
    assert.equal(host.client.state.dialog?.id, dialog.id);
    const allow = dialog.choices.find((choice: { kind: string }) => choice.kind === "allow");
    await host.client.req("dialog_answer", { dialog: dialog.id, choice: allow.id });
    await first;
    await host.client.waitFor((c) => c.state.phase === "idle" && c.items.some((item) => item.kind === "assistant" && item.text.includes("BANANA")), 5000);
    assert.equal(host.client.items.filter((item) => item.kind === "user" && item.text === "end with BANANA").length, 1);
    assert.equal(host.client.state.dialog, null);
  } finally { await host.stop(); }
});
