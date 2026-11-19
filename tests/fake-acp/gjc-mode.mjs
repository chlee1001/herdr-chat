import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";

export function createMode({ scenario, update }) {
  const kind = scenario.mode ?? "basic";
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let session, cwd, cancelling = false, wake, busyUntil = 0;
  const hint = (id, running, extra = {}) => update(id, { sessionUpdate: "session_info_update", _meta: { gjcPhase: running ? "working" : "idle", gjcRunning: running, ...extra } }, false);
  const file = () => {
    const dir = join(process.env.GJC_CODING_AGENT_DIR, "sessions", "scope");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-01-01T00-00-00_${session}.jsonl`), JSON.stringify({ type: "session", id: session, cwd }) + "\n");
  };
  return {
    agentInfo: { name: "fake-gjc", version: "0.21.1" },
    async newSession(id, params) {
      session = id; cwd = params.cwd;
      if (kind !== "late-session-file") file();
      if (kind.startsWith("host-run")) setTimeout(async () => {
        await hint(id, false); await hint(id, true);
        await update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "background output" } });
        await delay(scenario.hostDelay ?? 600); await hint(id, false);
      }, 80);
    },
    async load(id) { session = id; if (kind === "load-working") { await hint(id, false); await hint(id, true); } },
    async loaded(id) { if (kind === "load-working") { setTimeout(async () => { await hint(id, true); await delay(100); await hint(id, false); await hint(id, true); await delay(100); await hint(id, false); }, 50); } },
    async prompt(params, count) {
      session = params.sessionId;
      if (kind === "drain-error" && count > 1) throw new RequestError(-32603, "drain failed");
      if (kind === "drain-exit" && count > 1) { await delay(100); process.exit(9); }
      if (kind === "drain-hang" && count > 1) await new Promise(() => {});
      if (kind === "pre-echo-cancel") {
        await new Promise((resolve) => { wake = resolve; });
        await hint(session, false);
        return { stopReason: "cancelled" };
      }
      const conflict = kind === "persistent-conflict" || (kind === "transient-conflict" && count <= 2) || (kind === "drain-conflict" && count > 1) || (kind === "tail-conflict" && Date.now() < busyUntil);
      if (conflict) {
        if (scenario.hint && count === 1) await hint(session, true);
        if (scenario.hint && count === 4) setTimeout(() => void hint(session, false), 100);
        throw new RequestError(-32603, "conflict", { code: "conflict" });
      }
      if ((kind === "cancel-race" || kind === "cancel-race-esc") && count === 2) {
        setTimeout(() => void hint(session, false), scenario.idleDelay ?? 100);
        return { stopReason: "cancelled" };
      }
      if (kind === "prompt-working-overlap") await hint(session, false);
      await hint(session, true);
      for (const content of params.prompt) await update(session, { sessionUpdate: "user_message_chunk", content });
      if (kind === "exit-after-echo") process.exit(9);
      if (kind === "cancel" || ((kind === "cancel-race" || kind === "cancel-race-esc") && count === 1) || ((kind === "drain-conflict" || kind === "drain-error" || kind === "drain-exit" || kind === "drain-hang") && count === 1) || (kind === "tail-conflict" && count === 1 && scenario.delay)) await new Promise((resolve) => { wake = resolve; setTimeout(resolve, scenario.delay ?? 300); });
      if (kind === "agent-failed" && scenario.delay) await delay(scenario.delay);
      if (kind === "late-session-file") file();
      await update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
      if (kind === "late-session-file") { await hint(session, true); await delay(550); }
      if (kind === "agent-failed") {
        setTimeout(async () => { await hint(session, true, { gjcAgentFailed: true }); await delay(50); await hint(session, false); }, 10);
        throw new RequestError(-32603, "agent failed");
      }
      if (kind === "gate-timeout-working") setTimeout(() => void hint(session, false), 7000);
      else if (kind === "tail-conflict") { busyUntil = Date.now() + 300; setTimeout(() => void hint(session, false), 300); }
      else await hint(session, false);
      const stopReason = cancelling ? "cancelled" : "end_turn";
      cancelling = false;
      return { stopReason };
    },
    async cancel() { cancelling = true; wake?.(); },
  };
}
