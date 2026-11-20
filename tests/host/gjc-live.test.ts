// LIVE=1 uses the operator's authenticated agent and model credits; never run without approval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Host } from "./harness.ts";

test("live GJC permission, session discovery and held follow-up", { skip: process.env.LIVE !== "1", timeout: 180_000 }, async () => {
  const host = new Host({ name: "gjc-live", provider: "gjc", agent: "gjc" });
  await host.start();
  try {
    const client = host.client;
    await client.waitFor((c) => c.state.phase === "idle", 30_000);
    await client.req("send", { text: "Run the shell command `ls` in the current directory, then answer DONE. Ask for approval if required." });
    await client.waitFor((c) => c.state.dialog?.method === "permission", 90_000);
    const dialog = client.state.dialog;
    const allow = dialog.choices.find((choice: { kind: string }) => choice.kind === "allow");
    assert.ok(allow, "the agent offered allow once");
    await client.req("send", { text: "After that, reply with FOLLOWUP_DONE.", mode: "followUp" });
    await client.req("dialog_answer", { dialog: dialog.id, choice: allow.id });
    await client.waitFor((c) => c.state.phase === "idle" && c.items.some((item) => item.kind === "assistant" && /FOLLOWUP_DONE/i.test(item.text)), 120_000);
    assert.ok(client.items.some((item) => item.kind === "tool" && item.status === "done"));
    assert.ok(host.registry?.sessionFile, "session file discovered");
    const log = readFileSync(join(host.stateDir, "logs", `${host.chat}.log`), "utf8");
    assert.match(log, /GJC sessions directory/);
    const response = /^(\S+) .*GJC prompt response:/m.exec(log)?.[1];
    const settled = /^(\S+) .*GJC run settled/m.exec(log)?.[1];
    assert.ok(response && settled, "response and run settled timestamps recorded");
    assert.doesNotMatch(log, /conflict/i);
    host.artifact("gjc-live", { sessionFile: host.registry.sessionFile, responseToSettleMs: Date.parse(settled) - Date.parse(response), sessionDirectory: log.split("\n").find((line) => line.includes("GJC sessions directory")) });
  } finally { await host.stop(); }
});

test("live GJC steer: Enter during a running command changes the answer", { skip: process.env.LIVE !== "1", timeout: 180_000 }, async () => {
  const host = new Host({ name: "gjc-live-steer", provider: "gjc", agent: "gjc" });
  await host.start();
  try {
    const client = host.client;
    await client.waitFor((c) => c.state.phase === "idle", 30_000);
    await client.req("send", { text: "Run the shell command `sleep 6 && echo first`, then answer with its output. Ask for approval if required." });
    await client.waitFor((c) => c.state.dialog?.method === "permission", 90_000);
    const dialog = client.state.dialog;
    const allow = dialog.choices.find((choice: { kind: string }) => choice.kind === "allow");
    assert.ok(allow, "the agent offered allow once");
    await client.req("dialog_answer", { dialog: dialog.id, choice: allow.id });
    const sent = Date.now();
    assert.equal((await client.req("send", { text: "Also: end your final answer with the word BANANA." })).disposition, "queued");
    const steerMs = Date.now() - sent;
    await client.waitFor((c) => c.state.phase === "idle" && c.items.some((item) => item.kind === "assistant" && /BANANA\W*$/.test(item.text.trim())), 150_000);
    assert.equal(client.items.filter((item) => item.kind === "user" && /BANANA/.test(item.text)).length, 1);
    assert.equal(client.state.capabilities.steer, true);
    const log = readFileSync(join(host.stateDir, "logs", `${host.chat}.log`), "utf8");
    assert.doesNotMatch(log, /steer rejected/);
    host.artifact("gjc-live-steer", { steerMs, sessionFile: host.registry?.sessionFile });
  } finally { await host.stop(); }
});
