import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GjcAdapter } from "../../host/providers/gjc/adapter.ts";
import type { NormalizedEvent } from "../../host/providers/types.ts";
import { Host, ROOT } from "./harness.ts";

/** The fake ACP agent flavoured like GJC (phase hints, session files, conflicts). */
const GJC_MODE = join(ROOT, "tests/fake-acp/gjc-mode.mjs");

async function setup(mode: string, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gjc-run-"));
  const wrapper = join(dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(process.cwd(), "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode, ...extra }));
  const old = { ...process.env };
  Object.assign(process.env, { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(dir, "log"), FAKE_ACP_STORE: join(dir, "store"), GJC_CODING_AGENT_DIR: join(dir, "agent-dir") });
  const events: NormalizedEvent[] = [], logs: string[] = [];
  const adapter = new GjcAdapter({ command: wrapper, cwd: dir, stateDir: dir, args: [], log: (s) => logs.push(s) });
  await adapter.start(null, { emit: (e) => events.push(e), log: (s) => logs.push(s), running: false, working: false });
  Object.keys(process.env).forEach((key) => { if (!(key in old)) delete process.env[key]; }); Object.assign(process.env, old);
  return { adapter, events, logs, dir, scenario, wrapper, messages: () => readFileSync(join(dir, "log"), "utf8").trim().split("\n").map((s) => JSON.parse(s)), close: async () => { await adapter.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
const p = (text: string, busy = false) => ({ id: text, text, images: [], mode: "auto" as const, busy });
async function wait(check: () => boolean, timeout = 3000) { const until = Date.now() + timeout; while (!check()) { if (Date.now() > until) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } }

test("transient conflicts retry twice and settle once", async () => {
  const t = await setup("transient-conflict");
  try {
    await t.adapter.prompt(p("hello"));
    assert.equal(t.messages().filter((m: any) => m.method === "session/prompt").length, 3);
    assert.equal(t.events.filter((e) => e.type === "run_started").length, 1);
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
  } finally { await t.close(); }
});

test("tail gate holds a queued prompt until idle", async () => {
  const t = await setup("tail-conflict");
  try {
    const first = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt(p("second", true));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.messages().filter((m: any) => m.method === "session/prompt").length, 1);
    await first;
    await wait(() => t.events.some((e) => e.type === "run_settled"));
    assert.equal(t.messages().filter((m: any) => m.method === "session/prompt").length, 2);
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
  } finally { await t.close(); }
});

test("persistent conflict restores direct and cascade messages", async () => {
  const t = await setup("persistent-conflict");
  try {
    assert.equal((await t.adapter.prompt(p("one"))).disposition, "handled");
    assert.equal(t.events.filter((e) => e.type === "editor_text" && e.text === "one").length, 1);
    assert.equal(t.events.filter((e) => e.type === "notice" && e.text.includes("stayed busy")).length, 1);
    assert.equal(t.messages().filter((m: any) => m.method === "session/prompt").length, 4);
    assert.equal((await t.adapter.prompt(p("two"))).disposition, "handled");
    assert.ok(t.events.some((e) => e.type === "editor_text" && e.text === "one\n\ntwo"));
    assert.equal(t.events.filter((e) => e.type === "run_started").length, 0);
  } finally { await t.close(); }
});

test("background hint run renders output and drains queued message", async () => {
  const t = await setup("host-run", { hostDelay: 300 });
  try {
    await wait(() => t.events.some((e) => e.type === "run_cause"));
    assert.equal((await t.adapter.prompt(p("queued", true))).disposition, "queued");
    await wait(() => t.events.some((e) => e.type === "run_settled"));
    assert.ok(t.events.some((e) => e.type === "assistant_delta" && e.delta === "background output"));
    assert.equal(t.messages().filter((m: any) => m.method === "session/prompt").length, 1);
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
  } finally { await t.close(); }
});

test("working hint before echo opens only the prompted run", async () => {
  const t = await setup("prompt-working-overlap");
  try {
    await t.adapter.prompt(p("first"));
    assert.equal(t.events.filter((e) => e.type === "run_started").length, 1);
    assert.equal(t.events.filter((e) => e.type === "run_cause").length, 0);
  } finally { await t.close(); }
});

test("late session file is found on settle", async () => {
  const t = await setup("late-session-file");
  try {
    await t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "session" && !!e.file));
    assert.ok(t.events.findIndex((e) => e.type === "session" && !!e.file) < t.events.findIndex((e) => e.type === "run_settled"));
  } finally { await t.close(); }
});

test("load working hints are suppressed until the first post-load idle", async () => {
  const t = await setup("basic");
  try {
    await t.adapter.prompt(p("first"));
    const ref = t.events.find((e) => e.type === "session" && e.file);
    assert.ok(ref?.type === "session" && ref.file);
    await t.adapter.dispose();
    writeFileSync(t.scenario, JSON.stringify({ mode: "load-working" }));
    const previous = { ...process.env };
    Object.assign(process.env, { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: t.scenario, FAKE_ACP_LOG: join(t.dir, "log"), FAKE_ACP_STORE: join(t.dir, "store"), GJC_CODING_AGENT_DIR: join(t.dir, "agent-dir") });
    const events: NormalizedEvent[] = [];
    const reopened = new GjcAdapter({ command: t.wrapper, cwd: t.dir, stateDir: t.dir, args: [], log: () => {} });
    try {
      await reopened.start(ref.file, { emit: (e) => events.push(e), log: () => {}, running: false, working: false });
      Object.keys(process.env).forEach((key) => { if (!(key in previous)) delete process.env[key]; }); Object.assign(process.env, previous);
      assert.ok((await reopened.history()).some((e) => e.type === "assistant_delta"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(events.filter((e) => e.type === "run_started").length, 0);
      assert.equal(events.filter((e) => e.type === "notice" && /started.*own|background job/i.test(e.text)).length, 0);
      await wait(() => events.some((e) => e.type === "run_settled"));
      assert.equal(events.filter((e) => e.type === "run_started").length, 1);
    } finally { Object.keys(process.env).forEach((key) => { if (!(key in previous)) delete process.env[key]; }); Object.assign(process.env, previous); await reopened.dispose(); }
  } finally { await t.close(); }
});

test("hint run cancel warns once and waits for idle", async () => {
  const t = await setup("host-run", { hostDelay: 350 });
  try {
    await wait(() => t.events.some((e) => e.type === "run_cause"));
    t.adapter.abort(); t.adapter.abort();
    assert.equal(t.events.filter((e) => e.type === "notice" && /can't stop/.test(e.text)).length, 1);
    await wait(() => t.events.some((e) => e.type === "run_settled"));
    assert.equal(t.messages().filter((m: any) => m.method === "session/cancel").length, 2);
  } finally { await t.close(); }
});

test("conflict after working keeps the run open until idle", async () => {
  const t = await setup("persistent-conflict", { hint: true });
  try {
    assert.equal((await t.adapter.prompt(p("first"))).disposition, "handled");
    assert.ok(t.events.some((e) => e.type === "run_started"));
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 0);
    await wait(() => t.events.some((e) => e.type === "run_settled"));
    assert.equal(t.events.filter((e) => e.type === "editor_text" && e.text === "first").length, 1);
    assert.equal(t.events.filter((e) => e.type === "run_settled" && !e.aborted).length, 1);
    assert.equal(t.events.filter((e) => e.type === "run_cause").length, 0);
  } finally { await t.close(); }
});

test("escape during conflict backoff returns the pending text without cancel", async () => {
  const t = await setup("persistent-conflict");
  try {
    const result = t.adapter.prompt(p("first"));
    await wait(() => t.messages().filter((m: any) => m.method === "session/prompt").length >= 2);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(await t.adapter.clearQueue(), ["first"]);
    t.adapter.abort();
    assert.equal((await result).disposition, "handled");
    assert.equal(t.messages().filter((m: any) => m.method === "session/cancel").length, 0);
    assert.equal(t.events.filter((e) => e.type === "editor_text").length, 0);
  } finally { await t.close(); }
});

test("disposing during conflict backoff cannot resend on a closed connection", async () => {
  const t = await setup("persistent-conflict");
  try {
    const result = t.adapter.prompt(p("first")).catch((error) => error);
    await wait(() => t.messages().some((m: any) => m.method === "session/prompt"));
    await t.adapter.dispose();
    const error = await result;
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /null|undefined/i);
    assert.equal(t.messages().filter((m: any) => m.method === "session/prompt").length, 1);
  } finally { await t.close(); }
});

test("agent exit during an accepted run does not wait for the gate or settle after exit", async () => {
  const t = await setup("exit-after-echo");
  try {
    const start = Date.now();
    const result = t.adapter.prompt(p("first")).catch(() => null);
    await wait(() => t.events.some((e) => e.type === "exited"));
    await result;
    assert.ok(Date.now() - start < 3000);
    const exit = t.events.findIndex((e) => e.type === "exited");
    assert.ok(!t.events.slice(exit + 1).some((e) => e.type === "run_settled"));
  } finally { await t.close(); }
});

test("queued conflict returns all messages before aborted settle", async () => {
  const t = await setup("drain-conflict", { delay: 250 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt(p("second", true)); await t.adapter.prompt(p("third", true));
    await running;
    await wait(() => t.events.some((e) => e.type === "run_settled"), 5000);
    const restored = t.events.findIndex((e) => e.type === "editor_text" && e.text === "second\n\nthird");
    const settled = t.events.findIndex((e) => e.type === "run_settled" && e.aborted);
    assert.ok(restored >= 0 && settled > restored);
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
  } finally { await t.close(); }
});

test("settle timeout while working retains the run until idle", async () => {
  const t = await setup("gate-timeout-working");
  try {
    await t.adapter.prompt(p("first"));
    assert.ok(!t.events.some((e) => e.type === "run_settled"));
    assert.ok(t.logs.some((line) => /keeping run open/.test(line)));
    await wait(() => t.events.some((e) => e.type === "run_settled"), 4000);
  } finally { await t.close(); }
});

test("failed-agent hint cannot open another run", async () => {
  const t = await setup("agent-failed");
  try {
    const result = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "notice" && /agent failed/.test(e.text)));
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 0);
    assert.equal((await result).disposition, "started");
    assert.equal(t.events.filter((e) => e.type === "run_started").length, 1);
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
  } finally { await t.close(); }
});

test("normal abort before first echo sends cancel without restoring text", async () => {
  const t = await setup("pre-echo-cancel");
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.messages().some((m: any) => m.method === "session/prompt"));
    assert.deepEqual(await t.adapter.clearQueue(), []);
    t.adapter.abort();
    await running;
    assert.equal(t.messages().filter((m: any) => m.method === "session/cancel").length, 1);
    assert.equal(t.events.filter((e) => e.type === "editor_text").length, 0);
    assert.equal(t.events.filter((e) => e.type === "notice" && /can't stop/.test(e.text)).length, 0);
  } finally { await t.close(); }
});

test("cancel race retries an unacknowledged cancelled prompt after idle", async () => {
  const t = await setup("cancel-race", { delay: 1000 });
  try {
    const first = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    t.adapter.abort(); await first;
    await t.adapter.prompt(p("after"));
    const requests = t.messages().filter((m: any) => m.method === "session/prompt");
    assert.equal(requests.length, 3);
    assert.equal(requests[1].params.prompt[0].text, "after");
    assert.equal(requests[2].params.prompt[0].text, "after");
  } finally { await t.close(); }
});

test("Esc while waiting to resend a cancelled prompt stops the resend", async () => {
  const t = await setup("cancel-race-esc", { delay: 1000, idleDelay: 600 });
  try {
    const first = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    t.adapter.abort(); await first;
    const after = t.adapter.prompt(p("after"));
    await wait(() => t.messages().filter((m: any) => m.method === "session/prompt").length === 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    t.adapter.abort();
    await after;
    assert.equal(t.messages().filter((m: any) => m.method === "session/prompt").length, 2);
  } finally { await t.close(); }
});

test("agent exit during an unaccepted drain gives the queue back before exited", async () => {
  const t = await setup("drain-exit", { delay: 200 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt(p("second", true)); await t.adapter.prompt(p("third", true));
    await running;
    await wait(() => t.events.some((e) => e.type === "exited"), 5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const exited = t.events.findIndex((e) => e.type === "exited");
    const restored = t.events.findIndex((e) => e.type === "editor_text" && e.text === "second\n\nthird");
    assert.ok(restored >= 0 && restored < exited);
    assert.equal(t.events.filter((e) => e.type === "editor_text").length, 1);
  } finally { await t.close(); }
});

test("exit reported before the drained prompt fails still gives the queue back once, before exited", async () => {
  const t = await setup("drain-hang", { delay: 200 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt(p("second", true)); await t.adapter.prompt(p("third", true));
    await running;
    await wait(() => t.messages().filter((m: any) => m.method === "session/prompt").length === 2);
    // The process `close` can be seen before the pending request rejects: report the exit first.
    const conn = (t.adapter as unknown as { connection: { onExit: (exit: object) => void; kill: () => void } }).connection;
    conn.onExit({ code: 9, signal: null, stderrTail: "" });
    conn.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const exited = t.events.findIndex((e) => e.type === "exited");
    const restored = t.events.findIndex((e) => e.type === "editor_text" && e.text === "second\n\nthird");
    assert.ok(exited >= 0 && restored >= 0 && restored < exited);
    assert.equal(t.events.filter((e) => e.type === "editor_text").length, 1);
    assert.ok(!t.events.slice(exited + 1).some((e) => e.type === "run_settled"));
  } finally { await t.close(); }
});

test("real host keeps held follow-ups when GJC exits during a drain", async () => {
  const host = new Host({ name: "gjc-drain-exit", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "drain-exit", delay: 500 }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.state.phase === "idle", 5000);
    const first = host.client.req("send", { text: "first" });
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    await host.client.req("send", { text: "queued" });
    await host.client.req("send", { text: "held", mode: "followUp" });
    await first;
    await host.client.waitFor((c) => c.state.phase === "exited" && c.state.editorText === "queued\n\nheld", 8000);
  } finally { await host.stop(); }
});

test("real host shows background run text and its cause", async () => {
  const host = new Host({ name: "gjc-background", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "host-run", hostDelay: 500 }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.items.some((item) => item.kind === "assistant" && item.text.includes("background output")) && c.state.phase === "idle", 5000);
    assert.ok(host.client.items.some((item) => item.kind === "notice" && item.text.includes("Started by GJC (a background job finished).")));
    assert.ok(host.client.items.some((item) => item.kind === "assistant" && item.text.includes("background output") && !item.streaming));
    assert.ok(host.registry?.sessionFile && existsSync(`${host.registry.sessionFile}.herdr-chat.lock`));
  } finally { await host.stop(); }
});

test("real host queues Enter during a background run and drains it on idle", async () => {
  const host = new Host({ name: "gjc-host-enter", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "host-run", hostDelay: 1100 }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    assert.equal((await host.client.req("send", { text: "queued" })).disposition, "queued");
    await host.client.waitFor((c) => c.state.queue.followUp.includes("queued"), 1000);
    const before = readFileSync(join(host.dir, "log"), "utf8");
    assert.doesNotMatch(before, /session\/prompt/);
    await host.client.waitFor((c) => c.state.phase === "idle" && c.items.some((item) => item.kind === "user" && item.text === "queued"), 5000);
    assert.equal(host.client.items.filter((item) => item.kind === "user" && item.text === "queued").length, 1);
  } finally { await host.stop(); }
});

test("real host stays working after repeated background-run escapes", async () => {
  const host = new Host({ name: "gjc-host-esc", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "host-run", hostDelay: 1100 }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    await host.client.req("abort"); await host.client.req("abort");
    assert.equal(host.client.state.phase, "working");
    await host.client.waitFor((c) => c.state.phase === "idle", 5000);
    const requests = readFileSync(join(host.dir, "log"), "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s));
    assert.equal(requests.filter((m) => m.method === "session/cancel").length, 2);
    assert.equal(host.client.items.filter((item) => item.kind === "notice" && item.text.includes("can't stop")).length, 1);
  } finally { await host.stop(); }
});

test("real host restores a directly rejected message to the composer", async () => {
  const host = new Host({ name: "gjc-conflict", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "persistent-conflict" }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.state.phase === "idle", 5000);
    await host.client.req("send", { text: "restore me" });
    await host.client.waitFor((c) => c.state.phase === "idle" && c.state.editorText === "restore me", 5000);
    assert.ok(!host.client.items.some((item) => item.kind === "user" && item.text === "restore me"));
  } finally { await host.stop(); }
});

test("real host restores held follow-ups in order after a conflict", async () => {
  const host = new Host({ name: "gjc-held", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "drain-conflict", delay: 600 }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.state.phase === "idle", 5000);
    const first = host.client.req("send", { text: "first" });
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    await host.client.req("send", { text: "held one", mode: "followUp" });
    await host.client.req("send", { text: "held two", mode: "followUp" });
    await first;
    await host.client.waitFor((c) => c.state.phase === "idle" && c.state.editorText === "held one\n\nheld two", 8000);
    const requests = readFileSync(join(host.dir, "log"), "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s)).filter((m) => m.method === "session/prompt");
    assert.equal(requests.filter((m) => m.params.prompt[0].text === "held one").length, 4);
    assert.equal(requests.filter((m) => m.params.prompt[0].text === "held two").length, 0);
  } finally { await host.stop(); }
});

test("real host appends held follow-ups after drained queue restoration", async () => {
  const host = new Host({ name: "gjc-drain", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "drain-conflict", delay: 600 }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.state.phase === "idle", 5000);
    const first = host.client.req("send", { text: "first" });
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    await host.client.req("send", { text: "queued" });
    await host.client.req("send", { text: "held", mode: "followUp" });
    await first;
    await host.client.waitFor((c) => c.state.phase === "idle" && c.state.editorText === "queued\n\nheld", 8000);
    assert.ok(host.client.items.some((item) => item.kind === "notice" && item.text.includes("1 messages went back")));
  } finally { await host.stop(); }
});

test("real host preserves held follow-up after non-conflict drain failure", async () => {
  const host = new Host({ name: "gjc-drain-error", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "drain-error", delay: 600 }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.state.phase === "idle", 5000);
    const first = host.client.req("send", { text: "first" });
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    await host.client.req("send", { text: "queued" });
    await host.client.req("send", { text: "held", mode: "followUp" });
    await first;
    await host.client.waitFor((c) => c.state.phase === "idle" && c.state.editorText === "queued\n\nheld", 8000);
  } finally { await host.stop(); }
});

test("accepted failure keeps the user item and returns held text once", async () => {
  const host = new Host({ name: "gjc-accepted-error", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "agent-failed", delay: 500 }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.state.phase === "idle", 5000);
    const sent = host.client.req("send", { text: "accepted" });
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    await host.client.req("send", { text: "held", mode: "followUp" });
    await sent;
    await host.client.waitFor((c) => c.state.phase === "idle" && c.state.editorText === "held", 5000);
    assert.equal(host.client.items.filter((item) => item.kind === "user" && item.text === "accepted").length, 1);
    assert.ok(host.client.items.some((item) => item.kind === "notice" && item.text.includes("agent failed")));
  } finally { await host.stop(); }
});

test("non-conflict drain error restores queue before exactly one settle", async () => {
  const t = await setup("drain-error", { delay: 200 });
  try {
    const running = t.adapter.prompt(p("first"));
    await wait(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt(p("queued", true));
    await running;
    await wait(() => t.events.some((e) => e.type === "run_settled"));
    const restored = t.events.findIndex((e) => e.type === "editor_text" && e.text === "queued");
    const settled = t.events.findIndex((e) => e.type === "run_settled" && e.aborted);
    assert.ok(restored >= 0 && settled > restored);
    assert.equal(t.events.filter((e) => e.type === "editor_text").length, 1);
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
  } finally { await t.close(); }
});

test("real host sends a held follow-up after the tail without a conflict", async () => {
  const host = new Host({ name: "gjc-tail-held", provider: "gjc", agent: "unused" });
  const wrapper = join(host.dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(host.dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "tail-conflict", delay: 500 }));
  host.opts.agent = wrapper;
  host.opts.env = { FAKE_ACP_MODE: GJC_MODE, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(host.dir, "log"), FAKE_ACP_STORE: join(host.dir, "store"), GJC_CODING_AGENT_DIR: join(host.dir, "agent-dir") };
  await host.start();
  try {
    await host.client.waitFor((c) => c.state.phase === "idle", 5000);
    const first = host.client.req("send", { text: "first" });
    await host.client.waitFor((c) => c.state.phase === "working", 5000);
    await host.client.req("send", { text: "held", mode: "followUp" });
    await first;
    await host.client.waitFor((c) => c.state.phase === "idle" && c.items.some((item) => item.kind === "user" && item.text === "held"), 5000);
    const requests = readFileSync(join(host.dir, "log"), "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s));
    assert.equal(requests.filter((m) => m.method === "session/prompt").length, 2);
  } finally { await host.stop(); }
});
