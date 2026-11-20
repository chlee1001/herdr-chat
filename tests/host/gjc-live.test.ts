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

test("live GJC settings: a model preset change, a reply, /compact, and the preset back", { skip: process.env.LIVE !== "1", timeout: 240_000 }, async () => {
  const host = new Host({ name: "gjc-live-settings", provider: "gjc", agent: "gjc" });
  await host.start();
  const client = host.client;
  let original: { provider: string; id: string } | null = null;
  try {
    await client.waitFor((c) => c.state.phase === "idle" && c.state.model, 30_000);
    original = { provider: client.state.model.provider, id: client.state.model.id };
    const { models } = await client.req("models");
    // A light preset when GJC has one: the change costs a reply on it.
    const other = models.find((m: { id: string }) => m.id !== original!.id && /lite|eco|light/i.test(m.id)) ?? models.find((m: { id: string }) => m.id !== original!.id);
    assert.ok(other, "GJC offers another preset");
    await client.req("set_model", { provider: other.provider, modelId: other.id });
    await client.waitFor((c) => c.state.model?.id === other.id, 15_000);
    await client.req("send", { text: "Reply with the single word KIWI." });
    await client.waitFor((c) => c.state.phase === "idle" && c.items.some((item) => item.kind === "assistant" && /KIWI/.test(item.text)), 120_000);
    await client.req("send", { text: "/compact" });
    await client.waitFor((c) => c.items.some((item) => item.kind === "notice" && /^Compact(ed the conversation|ion failed)/.test(item.text)), 120_000);
    const notice = client.items.findLast((item) => item.kind === "notice" && /^Compact/.test(item.text));
    host.artifact("gjc-live-settings", { from: original.id, to: other.id, compaction: notice?.text, usage: client.state.usage });
    assert.match(notice.text, /^Compacted the conversation/);
  } finally {
    // The preset is GJC's own setting: put it back.
    if (original && client.state.model?.id !== original.id) await client.req("set_model", { provider: original.provider, modelId: original.id }).catch(() => {});
    await host.stop();
  }
});
