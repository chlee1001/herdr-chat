import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAcpAgent } from "../../host/providers/acp/spec.ts";
import { applyResult, presentTool } from "../../host/tools.ts";
import type { NormalizedEvent } from "../../host/providers/types.ts";

async function setup(actions: unknown[], conflict?: boolean | number) {
  const dir = await mkdtemp(join(tmpdir(), "acp-turn-"));
  const scenario = join(dir, "scenario.json");
  await writeFile(scenario, JSON.stringify({ actions, conflict }));
  const events: NormalizedEvent[] = [];
  const adapter = createAcpAgent({ id: "fake-acp", name: "Fake", command: process.execPath, args: [join(process.cwd(), "tests/fake-acp/fake-acp.mjs")], env: { FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: join(dir, "log"), FAKE_ACP_STORE: join(dir, "store") } }, { cwd: dir, stateDir: dir, args: [], log: () => {} });
  await adapter.start(null, { emit: (e) => events.push(e), log: () => {}, running: false, working: false });
  return { adapter, events, async log() { return (await readFile(join(dir, "log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); }, async close() { await adapter.dispose(); await rm(dir, { recursive: true, force: true }); } };
}
const prompt = (id: string, busy = false) => ({ id, text: id, images: [], mode: "auto" as const, busy });
async function waitFor(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error("timed out"); }

test("thinking/text switches and tools with a diff", async () => {
  const t = await setup([
    { type: "thinking", text: "think" }, { type: "text", text: "ans" }, { type: "text", text: "wer" },
    { update: { sessionUpdate: "tool_call", toolCallId: "t", title: "edit", kind: "edit", rawInput: { path: "a" } } },
    { update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", content: [{ type: "diff", path: "a", oldText: "old", newText: "new" }] } },
  ]);
  try {
    await t.adapter.prompt(prompt("first"));
    assert.deepEqual(t.events.filter((e) => e.type === "assistant_block_start").map((e) => e.kind), ["thinking", "text"]);
    assert.deepEqual(t.events.flatMap((e) => e.type === "assistant_delta" && e.kind === "text" ? [e.delta] : []), ["ans", "wer"]);
    assert.ok(t.events.some((e) => e.type === "tool_started"));
    const end = t.events.find((e) => e.type === "tool_ended");
    assert.ok(end?.type === "tool_ended" && JSON.stringify(end.result).includes('"type":"diff"'));
    const detail = applyResult(t.adapter.tools, end.name, presentTool(t.adapter.tools, end.name, end.args, "/tmp").detail, end.result, end.isError, end.output, "/tmp");
    assert.ok(detail.type === "edit" && detail.diff?.includes("-old") && detail.diff.includes("+new"));
  } finally { await t.close(); }
});

test("busy messages drain in order in one run", async () => {
  const t = await setup([{ type: "text", text: "ok", delay: 80 }]);
  try {
    const first = t.adapter.prompt(prompt("first"));
    await waitFor(() => t.events.some((e) => e.type === "run_started"));
    assert.equal((await t.adapter.prompt(prompt("second", true))).disposition, "queued");
    assert.equal((await t.adapter.prompt(prompt("third", true))).disposition, "queued");
    await first;
    await waitFor(() => t.events.some((e) => e.type === "run_settled"));
    assert.deepEqual(t.events.filter((e) => e.type === "user_message").map((e) => e.text), ["first", "second", "third"]);
    assert.equal(t.events.filter((e) => e.type === "run_started").length, 1);
    assert.equal(t.events.filter((e) => e.type === "run_settled").length, 1);
  } finally { await t.close(); }
});

test("abort sends cancel and settles aborted", async () => {
  const t = await setup([{ type: "wait_cancel" }]);
  try {
    const running = t.adapter.prompt(prompt("first"));
    await waitFor(() => t.events.some((e) => e.type === "run_started"));
    t.adapter.abort(); await running;
    assert.ok(t.events.some((e) => e.type === "run_settled" && e.aborted));
  } finally { await t.close(); }
});

test("permission kinds map and selections and cancellation reach the agent", async () => {
  const options = [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Allow always", kind: "allow_always" },
    { optionId: "deny", name: "Deny once", kind: "reject_once" },
    { optionId: "never", name: "Always deny", kind: "reject_always" },
  ];
  for (const selected of ["once", "always", "deny", "never", null]) {
    const t = await setup([{ type: "permission", options }]);
    try {
      const running = t.adapter.prompt(prompt("first"));
      await waitFor(() => t.events.some((e) => e.type === "ask"));
      const event = t.events.find((e) => e.type === "ask");
      assert.ok(event?.type === "ask" && event.ask.kind === "permission");
      assert.deepEqual(event.ask.choices.map((c) => c.kind), ["allow", "allow_always", "deny", "deny"]);
      t.adapter.answer(event.ask.id, selected ? { choice: selected } : { cancelled: true });
      await running;
      const response = (await t.log()).find((record: any) => record.method === "permission/response");
      assert.deepEqual(response.params.outcome, selected ? { outcome: "selected", optionId: selected } : { outcome: "cancelled" });
    } finally { await t.close(); }
  }
});

test("unexpected agent exit is reported", async () => {
  const t = await setup([{ type: "exit", code: 7 }]);
  try {
    const running = t.adapter.prompt(prompt("first")).catch(() => null);
    await waitFor(() => t.events.some((e) => e.type === "exited"));
    assert.ok(t.events.some((e) => e.type === "exited" && e.code === 7));
    await running;
    const exit = t.events.findIndex((e) => e.type === "exited");
    assert.ok(!t.events.slice(exit + 1).some((e) => e.type === "run_settled"));
  } finally { await t.close(); }
});

test("an agent that dies on launch reports its exit and stderr, not the broken pipe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-launch-"));
  const events: NormalizedEvent[] = [];
  const adapter = createAcpAgent({ id: "fake-acp", name: "Fake", command: "/bin/sh", args: ["-c", "echo 'env: bun: No such file or directory' >&2; exit 127"], env: {} }, { cwd: dir, stateDir: dir, args: [], log: () => {} });
  try {
    await assert.rejects(adapter.start(null, { emit: (e) => events.push(e), log: () => {}, running: false, working: false }));
    assert.equal(adapter.alive, false);
    const exit = events.find((e) => e.type === "exited");
    assert.ok(exit?.type === "exited" && exit.code === 127 && exit.stderrTail.includes("bun: No such file"));
  } finally { await adapter.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("denied tool failure is marked declined", async () => {
  const t = await setup([
    { update: { sessionUpdate: "tool_call", toolCallId: "tool", title: "$ true", kind: "execute" } },
    { type: "permission", options: [{ optionId: "no", name: "Deny", kind: "reject_once" }] },
    { update: { sessionUpdate: "tool_call_update", toolCallId: "tool", status: "failed" } },
  ]);
  try {
    const running = t.adapter.prompt(prompt("first"));
    await waitFor(() => t.events.some((e) => e.type === "ask"));
    const event = t.events.find((e) => e.type === "ask");
    assert.ok(event?.type === "ask");
    t.adapter.answer(event.ask.id, { choice: "no" });
    await running;
    assert.ok(t.events.some((e) => e.type === "tool_ended" && e.declined && e.isError));
  } finally { await t.close(); }
});

test("conflict rejects without claiming a run", async () => {
  const t = await setup([], true);
  try {
    await assert.rejects(t.adapter.prompt(prompt("first")), /conflict/);
    assert.ok(!t.events.some((e) => e.type === "run_started" || e.type === "run_settled"));
  } finally { await t.close(); }
});

test("queued messages can be removed or returned", async () => {
  const t = await setup([{ type: "wait_cancel" }]);
  try {
    const running = t.adapter.prompt(prompt("first"));
    await waitFor(() => t.events.some((e) => e.type === "run_started"));
    await t.adapter.prompt(prompt("second", true));
    await t.adapter.prompt(prompt("third", true));
    assert.equal(t.adapter.canRemoveQueued("second"), true);
    assert.equal(await t.adapter.removeQueued("second"), true);
    assert.equal(await t.adapter.removeQueued("second"), false);
    assert.deepEqual(await t.adapter.clearQueue(), ["third"]);
    t.adapter.abort(); await running;
  } finally { await t.close(); }
});

test("plan updates are mapped", async () => {
  const t = await setup([{ update: { sessionUpdate: "plan", entries: [{ content: "do it", priority: "high", status: "in_progress" }] } }]);
  try {
    await t.adapter.prompt(prompt("first"));
    assert.ok(t.events.some((e) => e.type === "plan" && e.steps[0]?.text === "do it" && e.steps[0].status === "in_progress"));
  } finally { await t.close(); }
});

// The fake agent is injected into the clone's TypeScript registry (tests/fake-acp/entry.ts); a built host
// has no such seam, so this one runs on the clone only.
test("real host renders an ACP reply", { skip: process.env.HERDR_CHAT_TEST_HOST ? "a built host has no test-only provider injection" : false }, async () => {
  const { acpHost } = await import("../fake-acp/host.ts");
  const host = await acpHost({ name: "acp-host" });
  try {
    await host.client.waitFor((x) => x.state.phase === "idle", 5000);
    await host.client.req("send", { text: "hello" });
    await host.client.waitFor((x) => x.state.phase === "idle" && x.items.some((item) => item.kind === "assistant" && item.text === "hello"), 5000);
    assert.equal(host.messages().filter((m) => m.method === "session/prompt").length, 1);
  } finally { await host.stop(); }
});
