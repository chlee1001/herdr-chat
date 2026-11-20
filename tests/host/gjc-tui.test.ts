// GJC's TUI hand-off: the command that opens the session, the session a running
// TUI has open (Continue as chat), and the `gjc.*` labels on the chat's terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GjcAdapter } from "../../host/providers/gjc/adapter.ts";
import { gjcTuiSession } from "../../host/providers/gjc/tui.ts";
import { tuiSession } from "../../host/providers/index.ts";
import type { NormalizedEvent } from "../../host/providers/types.ts";
import { ROOT } from "./harness.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const sessionFile = (agentDir: string, scope: string, id: string, cwd: string): string => {
  const dir = join(agentDir, "sessions", scope);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-01-01T00-00-00_${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", id, cwd }) + "\n");
  return file;
};
const wait = async (check: () => boolean, timeout = 3000) => { const until = Date.now() + timeout; while (!check()) { if (Date.now() > until) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } };

test("a GJC chat opens its TUI on the session id, and `login` runs GJC's own", () => {
  const a = new GjcAdapter({ command: "gjc", cwd: "/work", args: [], log: () => {} });
  assert.equal(a.capabilities.tui, true);
  assert.deepEqual(a.tuiCommand(`/home/x/.gjc/agent/sessions/scope/2026-01-01T00-00-00_${ID}.jsonl`), ["gjc", "--resume", ID]);
  assert.deepEqual(a.tuiCommand(ID), ["gjc", "--resume", ID]);
  assert.deepEqual(a.utilityCommand("login"), ["gjc", "login"]);
  assert.equal(a.utilityCommand("logout"), null);
});

test("Continue as chat: the session file the TUI has open, else the newest in its folder since it started", async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "gjc-tui-")));
  const agentDir = join(d, "agent");
  const cwd = join(d, "repo"), elsewhere = join(d, "other");
  mkdirSync(cwd); mkdirSync(elsewhere);
  const previous = process.env.GJC_CODING_AGENT_DIR;
  process.env.GJC_CODING_AGENT_DIR = agentDir;
  const old = sessionFile(agentDir, "a", "00000000-0000-0000-0000-000000000000", cwd);
  utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  const tui = spawn("sleep", ["30"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200)); // the TUI's start time, before the files below
  try {
    // Written before it started, or in another folder: not its session.
    sessionFile(agentDir, "b", OTHER, elsewhere);
    assert.throws(() => gjcTuiSession({ pid: tui.pid!, cwd, label: null }), /no GJC session in this folder since it started/);
    // The newest one in its folder since it started.
    const mine = sessionFile(agentDir, "a", ID, cwd);
    assert.deepEqual(gjcTuiSession({ pid: tui.pid!, cwd, label: null }), { session: mine });
    assert.deepEqual(tuiSession("gjc", { pid: tui.pid!, cwd, label: null }), { session: mine });
  } finally { tui.kill(); }
  // A TUI with the file open (here `tail -f`): that file, whatever its folder or age.
  const held = sessionFile(agentDir, "c", OTHER, elsewhere);
  utimesSync(held, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  const open = spawn("tail", ["-f", held], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(gjcTuiSession({ pid: open.pid!, cwd, label: null }), { session: held });
  } finally { open.kill(); if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR; else process.env.GJC_CODING_AGENT_DIR = previous; rmSync(d, { recursive: true, force: true }); }
});

/** A GjcAdapter on the fake GJC with `hc` standing in: its label calls are the lines of label.log. */
async function labelled(opts: { terminal?: string | null; fail?: boolean; scenario?: object } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gjc-labels-")));
  const wrapper = join(dir, "agent");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "tests/fake-acp/fake-acp.mjs")}' "$@"\n`); chmodSync(wrapper, 0o700);
  const scenario = join(dir, "scenario.json"); writeFileSync(scenario, JSON.stringify({ mode: "basic", ...opts.scenario }));
  const hc = join(dir, "hc"); mkdirSync(hc);
  const env: Record<string, string> = {
    FAKE_ACP_MODE: join(ROOT, "tests/fake-acp/gjc-mode.mjs"), FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(dir, "log"), FAKE_ACP_STORE: join(dir, "store"),
    GJC_CODING_AGENT_DIR: join(dir, "agent-dir"), HERDR_CHAT_HC: join(ROOT, "tests/fake-hc/hc.mjs"), FAKE_HC_DIR: hc,
    ...(opts.terminal === null ? {} : { HC_TERMINAL_ID: opts.terminal ?? "t7" }), ...(opts.fail ? { FAKE_HC_LABEL_FAIL: "1" } : {}),
  };
  const old = { ...process.env };
  delete process.env.HC_TERMINAL_ID;
  Object.assign(process.env, env);
  const events: NormalizedEvent[] = [], logs: string[] = [];
  const adapter = new GjcAdapter({ command: wrapper, cwd: dir, stateDir: dir, args: [], log: (s) => logs.push(s) });
  await adapter.start(null, { emit: (e) => events.push(e), log: (s) => logs.push(s), running: false, working: false });
  // The host's environment lasts as long as the chat: `hc` runs with it on every label, so it is restored at close.
  const restore = () => { Object.keys(process.env).forEach((key) => { if (!(key in old)) delete process.env[key]; }); Object.assign(process.env, old); };
  const calls = (): { terminal: string; labels: string[] }[] => existsSync(join(hc, "label.log")) ? readFileSync(join(hc, "label.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const acp = (): any[] => existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { adapter, events, logs, dir, calls, acp, close: async () => { await adapter.dispose(); restore(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the chat's terminal is labelled with its session, set again on a rename, and cleared at the end", async () => {
  const t = await labelled();
  try {
    await wait(() => t.calls().length >= 1);
    const first = t.calls()[0]!;
    const sessionId = first.labels.find((l) => l.startsWith("gjc.session="))!.slice("gjc.session=".length);
    assert.equal(first.terminal, "t7");
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(first.labels, [`gjc.session=${sessionId}`, `gjc.cwd=${t.dir}`, `gjc.file=${join(t.dir, "agent-dir/sessions/scope", `2026-01-01T00-00-00_${sessionId}.jsonl`)}`, "gjc.title="]);
    await t.adapter.setName("Fix the parser");
    await wait(() => t.calls().length >= 2);
    assert.equal(t.calls()[1]!.labels[3], "gjc.title=Fix the parser");
    await t.adapter.setName("Fix the parser");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.calls().length, 2, "the same labels are not sent twice");
    await t.adapter.dispose();
    assert.deepEqual(t.calls().at(-1)!.labels, ["gjc.session=", "gjc.cwd=", "gjc.file=", "gjc.title="]);
    assert.equal(t.calls().length, 3);
  } finally { await t.close(); }
});

test("without a terminal there are no labels; a failing `hc label` is one log line and the chat goes on", async () => {
  const none = await labelled({ terminal: null });
  try {
    await new Promise((r) => setTimeout(r, 300));
    await none.adapter.setName("x");
    assert.equal(none.calls().length, 0);
  } finally { await none.close(); }
  const failing = await labelled({ fail: true });
  try {
    await wait(() => failing.logs.some((l) => l.startsWith("hc label t7")));
    assert.equal(failing.logs.filter((l) => l.startsWith("hc label t7")).length, 1);
    await failing.adapter.setName("y");
    assert.equal(failing.events.some((e) => e.type === "session" && e.name === "y"), true);
  } finally { await failing.close(); }
});

const ids = (t: { calls: () => { labels: string[] }[] }) => t.calls().map((c) => c.labels[0]!.slice("gjc.session=".length));

test("a session switch clears the labels, and the new session is labelled once its file is known", async () => {
  const t = await labelled();
  try {
    await wait(() => t.calls().length >= 1);
    const first = ids(t)[0]!;
    await t.adapter.newSession();
    await wait(() => ids(t).some((id) => id && id !== first));
    const second = ids(t).find((id) => id && id !== first)!;
    const order = ids(t);
    assert.ok(order.indexOf("") > order.indexOf(first) && order.indexOf("") < order.indexOf(second), "cleared between the two sessions");
  } finally { await t.close(); }
});

test("a failed switch keeps the session and its labels, title included", async () => {
  const t = await labelled();
  try {
    await wait(() => t.calls().length >= 1);
    await t.adapter.setName("Keep me");
    await wait(() => t.calls().some((c) => c.labels[3] === "gjc.title=Keep me"));
    await assert.rejects(t.adapter.switchSession(join(t.dir, "x_00000000-0000-4000-8000-00000000dead.jsonl")));
    await wait(() => t.calls().at(-1)!.labels[3] === "gjc.title=Keep me" && t.calls().at(-1)!.labels[0] !== "gjc.session=");
    assert.equal(t.calls().at(-1)!.labels[0], t.calls().find((c) => c.labels[3] === "gjc.title=Keep me")!.labels[0]);
  } finally { await t.close(); }
});

test("labels wait for the session file: none before GJC writes it", async () => {
  const t = await labelled({ scenario: { mode: "late-session-file" } });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(t.calls().length, 0, "no file yet, nothing to label");
    await t.adapter.prompt({ id: "a", text: "hi", images: [], mode: "auto", busy: false });
    await wait(() => t.calls().length >= 1);
    assert.match(t.calls()[0]!.labels[2]!, /^gjc\.file=.+\.jsonl$/);
  } finally { await t.close(); }
});

test("dispose closes the session before the process, and a late rename cannot label the terminal again", async () => {
  const t = await labelled();
  try {
    await wait(() => t.calls().length >= 1);
    const rename = t.adapter.setName("Late");
    await t.adapter.dispose();
    await rename.catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(t.calls().at(-1)!.labels, ["gjc.session=", "gjc.cwd=", "gjc.file=", "gjc.title="], "the clear is the last word");
    assert.deepEqual(t.acp().filter((m) => m.method === "session/close").map((m) => m.params.sessionId), [ids(t)[0]]);
  } finally { await t.close(); }
});

test("an agent that exits on its own leaves no labels behind", async () => {
  const t = await labelled({ scenario: { mode: "exit-after-echo" } });
  try {
    await wait(() => t.calls().length >= 1);
    await t.adapter.prompt({ id: "a", text: "hi", images: [], mode: "auto", busy: false }).catch(() => {});
    await wait(() => t.calls().at(-1)!.labels[0] === "gjc.session=");
  } finally { await t.close(); }
});
