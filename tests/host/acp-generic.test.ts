import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAcpAgent } from "../../host/providers/acp/spec.ts";
import { AcpAdapter, type PromptContext, type PromptOutcome } from "../../host/providers/acp/adapter.ts";
import type { NormalizedEvent } from "../../host/providers/types.ts";

const fake = join(process.cwd(), "tests/fake-acp/fake-acp.mjs");
test("generic ACP streams and resumes via a pointer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-test-"));
  const events: NormalizedEvent[] = [];
  const host = { emit: (event: NormalizedEvent) => events.push(event), log: () => {}, running: false, working: false };
  const spec = { id: "fake-acp", name: "Fake", command: process.execPath, args: [fake], env: { FAKE_ACP_STORE: join(dir, "store.json") } };
  const adapter = createAcpAgent(spec, { cwd: dir, stateDir: dir, args: [], log: () => {} });
  let reopened: ReturnType<typeof createAcpAgent> | null = null;
  try {
    assert.equal(adapter.capabilities.tui, false);
    assert.deepEqual(await adapter.start(null, host), { streaming: false, hasHistory: false });
    const session = events.find((e) => e.type === "session");
    assert.ok(session?.type === "session" && session.file);
    await adapter.prompt({ id: "one", text: "hello", images: [], mode: "auto", busy: false });
    assert.ok(events.some((e) => e.type === "assistant_delta" && e.delta === "hello"));
    assert.equal(events.filter((e) => e.type === "run_settled").length, 1);
    await adapter.dispose();
    reopened = createAcpAgent(spec, { cwd: dir, stateDir: dir, args: [], log: () => {} });
    assert.equal((await reopened.start(session.file, host)).hasHistory, true);
    const history = await reopened.history();
    assert.ok(history.some((e) => e.type === "assistant_delta" && e.delta === "hello"));
    assert.ok(!history.some((e) => e.type === "run_started" || e.type === "run_settled"));
  } finally { await adapter.dispose(); await reopened?.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("foreign pointers fall back to a new session and old versions warn once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-test-"));
  const ref = join(dir, "foreign.json");
  await writeFile(ref, JSON.stringify({ agentId: "other", sessionId: "id", cwd: dir }));
  const events: NormalizedEvent[] = [];
  const host = { emit: (event: NormalizedEvent) => events.push(event), log: () => {}, running: false, working: false };
  const adapter = createAcpAgent({ id: "fake-acp", name: "Fake", command: process.execPath, args: [fake], env: {}, minimumVersion: "2.0.0" }, { cwd: dir, stateDir: dir, args: [], log: () => {} });
  try {
    assert.equal((await adapter.start(ref, host)).hasHistory, false);
    assert.ok(events.some((e) => e.type === "notice" && /Could not load/.test(e.text)));
    await adapter.dispose();
    await adapter.start(null, host);
    assert.equal(events.filter((e) => e.type === "notice" && /older than/.test(e.text)).length, 1);
  } finally { await adapter.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("generic lifecycle hooks and TUI arguments receive the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-hooks-"));
  const calls: string[] = [];
  class CustomAdapter extends AcpAdapter {
    protected async onPromptOutcome(outcome: PromptOutcome, ctx: PromptContext) {
      calls.push(`${outcome.type}:${ctx.prompt.text}`);
      return super.onPromptOutcome(outcome, ctx);
    }
    protected async settleGate(_ctx: PromptContext): Promise<"settle"> { calls.push("gate"); return "settle"; }
    protected onRunSettled(): void { calls.push("settled"); }
  }
  const spec = { id: "fake-acp", name: "Fake", command: process.execPath, args: [fake], env: {}, tui: ["agent", "--resume={session}"] };
  const adapter = new CustomAdapter(spec, { command: process.execPath, cwd: dir, stateDir: dir, args: [], log: () => {} });
  try {
    assert.deepEqual(adapter.tuiCommand("path with spaces"), ["agent", "--resume=path with spaces"]);
    await adapter.start(null, { emit: () => {}, log: () => {}, running: false, working: false });
    await adapter.prompt({ id: "one", text: "one", images: [], mode: "auto", busy: false });
    assert.deepEqual(calls, ["sending:one", "response:one", "gate", "settled"]);
  } finally { await adapter.dispose(); await rm(dir, { recursive: true, force: true }); }
});
