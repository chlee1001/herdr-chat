import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AdapterHost, AdapterOptions, Disposition } from "../types.ts";
import { agentEnv } from "../env.ts";
import { AcpAdapter, type AcpPrompt, type PromptContext, type PromptErrorAction, type PromptOutcome, type SteerResult } from "../acp/adapter.ts";
import { control, queuedMessages } from "./sdk.ts";
import { findSession, sessionIdOf, sessionsDirectory } from "./sessions.ts";

export class GjcAdapter extends AcpAdapter {
  private directory = "";
  private file: string | null = null;
  private lastSearch = 0;
  private searchTimer: NodeJS.Timeout | null = null;
  private warnedAmbiguous = false;
  private opened = false;
  private suppressed = true;
  private hint: "working" | "idle" | null = null;
  private waiters = new Set<() => void>();
  private conflictStart = 0;
  private retrying = false;
  private retryCancelled = false;
  private promptInFlight = false;
  private cancelSentAfterRestore = false;
  private hintRun = false;
  private cancelNoticed = false;
  private lastCancel = 0;
  private restored: string[] = [];
  private restoredUntil = 0;

  constructor(opts: AdapterOptions) {
    super({ id: "gjc", name: "GJC", command: opts.command, args: ["--mode", "acp"], env: {}, clientMeta: { gjc: { permissionHandling: "prompt" } }, minimumVersion: "0.21.0" }, opts);
    this.capabilities.tui = false;
  }
  async start(session: string | null, host: AdapterHost) {
    const dir = sessionsDirectory(this.opts.cwd, agentEnv(this.spec.env));
    this.directory = dir.path; this.file = null; this.opened = false; this.suppressed = true;
    this.lastSearch = 0; this.warnedAmbiguous = false; this.hint = null; this.hintRun = false; this.cancelNoticed = false;
    this.restored = []; this.restoredUntil = 0; this.retrying = false; this.retryCancelled = false; this.promptInFlight = false; this.lastCancel = 0;
    host.log(`GJC sessions directory ${dir.path} (${dir.rule})`);
    return super.start(session, host);
  }
  protected sessionOpened(): void { this.opened = true; this.suppressed = true; }
  /** `turn.steer` into the running turn; `clientRef` is the host's message id (a UUID, never GJC's reserved `abort-and-prompt:`). */
  protected async steer(text: string, id: string): Promise<SteerResult> {
    if (!this.connection || !this.sessionId) return { status: "rejected", reason: "GJC is not running" };
    const agent = this.connection.agent, session = this.sessionId;
    const answer = await control(agent, session, "turn.steer", { text, clientRef: id });
    if (answer.ok) {
      if (answer.result.status !== "accepted") return { status: "rejected", reason: `status ${String(answer.result.status)}` };
      // GJC accepts a steer between turns too (the loop ended, the prompt not yet answered), as a follow-up it runs as
      // a turn of its own whose output never reaches this client. Take such a one back: it waits in our queue instead.
      const queued = await queuedMessages(agent, session).catch(() => null);
      if (!queued) this.host?.log("GJC queue.messages.list failed; taking the steer as joined");
      const own = queued?.findLast((m) => m.mode === "followUp" && m.text === text);
      if (!own) return { status: "accepted" };
      const removed = await control(agent, session, "queue.message.remove", { id: own.id }).catch(() => null);
      if (removed?.ok) return { status: "rejected", reason: "the turn was ending" };
      this.host?.log(`GJC queued the steer as a follow-up and kept it (${removed && !removed.ok ? removed.code : "no answer"})`);
      this.emit({ type: "notice", level: "warning", source: "host", text: "GJC took the steer after its turn ended and runs it on its own; its answer may not show here.", once: "run" });
      return { status: "accepted" };
    }
    // Only a GJC without the SDK, or without `turn.steer`, turns steering off; a malformed request (`undefined`) is our bug, not its.
    if (answer.code === "method_not_found" || (answer.code === "unknown_operation" && answer.message.includes("turn.steer"))) return { status: "unsupported" };
    return { status: "rejected", reason: answer.message ? `${answer.code}: ${answer.message}` : answer.code };
  }
  protected async sessionIdOf(ref: string): Promise<string | null> { return sessionIdOf(ref); }
  protected async sessionRef(id: string): Promise<string | null> { return this.findFile(id); }
  private findFile(id: string): string | null {
    this.lastSearch = Date.now();
    const result = findSession(this.directory, id, this.opts.cwd);
    if (result.ambiguous && !this.warnedAmbiguous) { this.warnedAmbiguous = true; this.emit({ type: "notice", level: "warning", source: "host", text: "GJC has multiple matching sessions, none in this working directory." }); }
    if (result.alternatives.length) this.host?.log(`GJC session alternatives: ${result.alternatives.join(", ")}`);
    this.file = result.file;
    return this.file;
  }
  private searchFile(): void {
    if (this.file || !this.sessionId || this.searchTimer) return;
    const search = () => { this.searchTimer = null; if (this.file || !this.sessionId) return; const file = this.findFile(this.sessionId); if (file) this.emit({ type: "session", file }); };
    const delay = Math.max(0, 500 - (Date.now() - this.lastSearch));
    if (delay) this.searchTimer = setTimeout(search, delay); else search();
  }
  protected onRunSettled(): void { this.host?.log("GJC run settled"); this.suppressed = false; this.hintRun = false; this.cancelNoticed = false; this.searchFile(); }
  protected onConnectionClosed(): void { for (const wake of [...this.waiters]) wake(); }
  protected onUpdate(update: SessionUpdate): void {
    super.onUpdate(update);
    if (this.retryCancelled && this.pending?.accepted && !this.cancelSentAfterRestore && this.connection && this.sessionId) {
      this.cancelSentAfterRestore = true;
      void this.connection.agent.cancel({ sessionId: this.sessionId });
    }
    if (update.sessionUpdate === "session_info_update") this.searchFile();
  }
  protected phaseHint(update: SessionUpdate): "working" | "idle" | null {
    if (update.sessionUpdate !== "session_info_update" || update._meta?.gjcAgentFailed === true) return null;
    const meta = update._meta;
    if (typeof meta?.gjcRunning === "boolean") return meta.gjcRunning ? "working" : "idle";
    return meta?.gjcPhase === "idle" ? "idle" : ["working", "responding", "compacting", "retrying", "retry_failed"].includes(String(meta?.gjcPhase)) ? "working" : null;
  }
  protected onPhaseHint(hint: "working" | "idle"): void {
    if (!this.opened) return;
    this.restored = []; this.restoredUntil = 0;
    this.hint = hint;
    if (hint === "idle") for (const wake of [...this.waiters]) wake();
    if (this.pending) return;
    if (this.suppressed) { if (hint === "idle") this.suppressed = false; if (!this.hintRun) return; }
    if (hint === "working" && !this.runOpen) {
      this.hintRun = true; this.cancelNoticed = false; this.openRun();
      this.emit({ type: "run_cause", text: "Started by GJC (a background job finished)." });
    } else if (hint === "idle" && this.runOpen && this.hintRun) {
      this.hintRun = false;
      if (this.queue.length && !this.aborting) this.drainQueue();
      else { this.settleRun(false); this.aborting = false; }
    }
  }
  private async waitForIdle(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const finish = (idle: boolean) => { clearTimeout(timer); this.waiters.delete(wake); resolve(idle); };
      const wake = () => finish(true);
      this.waiters.add(wake); timer = setTimeout(() => finish(false), ms);
    });
  }
  protected async settleGate(_ctx: PromptContext): Promise<"settle" | "hold"> {
    let timedOutWorking = false;
    if (this.hint !== "idle") {
      const idle = await this.waitForIdle(5000);
      if (!idle) { timedOutWorking = this.hint === "working"; this.host?.log(`GJC settle gate timed out; ${timedOutWorking ? "keeping run open" : "settling without idle hint"}`); }
    }
    this.suppressed = false;
    this.host?.log("GJC settle gate passed");
    if (timedOutWorking) { this.hintRun = true; return "hold"; }
    return "settle";
  }
  async prompt(p: AcpPrompt): Promise<{ disposition: Disposition }> {
    if (this.restoredUntil > Date.now()) { this.restore(p.text, false); return { disposition: "handled" }; }
    this.restored = []; this.restoredUntil = 0;
    if (!this.pending) { this.retryCancelled = false; this.cancelSentAfterRestore = false; }
    return super.prompt(p);
  }
  private restore(text: string, notice: boolean): void {
    this.restored = this.restored.filter((part) => !text.includes(part));
    this.restored.push(text);
    this.emit({ type: "editor_text", text: this.restored.join("\n\n") });
    if (notice) this.emit({ type: "notice", level: "warning", source: "host", text: "GJC stayed busy and did not take the message; it went back to the composer." });
  }
  protected async onPromptOutcome(outcome: PromptOutcome, ctx: PromptContext): Promise<PromptErrorAction> {
    if (outcome.type === "sending") { this.hint = null; this.promptInFlight = true; if (ctx.attempt === 0) this.conflictStart = 0; return "proceed"; }
    if (outcome.type === "response") {
      this.promptInFlight = false;
      this.host?.log(`GJC prompt response: ${ctx.stopReason}`);
      if (this.retryCancelled) {
        if (!this.cancelSentAfterRestore && ctx.stopReason !== "cancelled" && this.connection && this.sessionId) {
          this.cancelSentAfterRestore = true;
          void this.connection.agent.cancel({ sessionId: this.sessionId });
        }
        if (this.runOpen) { this.hintRun = true; if (this.hint === "idle") this.settleRun(false); }
        return "handled";
      }
      if (!this.aborting && ctx.stopReason === "cancelled" && !ctx.observedOutput && this.lastCancel && Date.now() - this.lastCancel <= 6000 && ctx.attempt === 0) {
        if (this.hint !== "idle") await this.waitForIdle(6000);
        if (!this.retryCancelled && !this.aborting && this.hint === "idle") return "retry";
      }
      return "proceed";
    }
    const error = outcome.error;
    this.promptInFlight = false;
    if (this.retryCancelled) { if (this.runOpen) this.hintRun = true; return "handled"; }
    const data = (error as { data?: { code?: unknown } })?.data;
    if (data?.code !== "conflict") return "throw";
    if (ctx.accepted) return "throw";
    if (!this.conflictStart) this.conflictStart = Date.now();
    if (!ctx.observedOutput && ctx.attempt < 3 && Date.now() - this.conflictStart < 6000) {
      this.retrying = true;
      await this.waitForIdle(Math.min([250, 500, 1000][ctx.attempt]!, 6000 - (Date.now() - this.conflictStart)));
      this.retrying = false;
      if (this.retryCancelled && this.runOpen) this.hintRun = true;
      return this.retryCancelled ? "handled" : "retry";
    }
    if (ctx.draining) {
      const texts = [ctx.prompt.text, ...this.queue.map((item) => item.text)];
      this.queue = []; this.emit({ type: "editor_text", text: texts.join("\n\n") }); this.queueChanged();
      this.emit({ type: "notice", level: "warning", source: "host", text: `GJC stayed busy; ${texts.length} messages went back to the composer.` });
      this.settleRun(true);
    } else {
      this.restore(ctx.prompt.text, true);
      if (this.runOpen) this.hintRun = true;
      else this.restoredUntil = Date.now() + 6000;
    }
    return "handled";
  }
  async clearQueue(): Promise<string[]> {
    const queued = await super.clearQueue();
    if (this.pending && !this.pending.accepted && this.conflictStart > 0 && (this.retrying || this.promptInFlight)) { this.retryCancelled = true; for (const wake of [...this.waiters]) wake(); return [this.pending.prompt.text, ...queued]; }
    return queued;
  }
  abort(): void {
    if (this.retryCancelled && !this.runOpen) return;
    this.lastCancel = Date.now();
    if (this.retryCancelled && this.runOpen) this.hintRun = true;
    if (this.hintRun && (!this.pending || this.retryCancelled)) {
      if (!this.cancelNoticed) { this.cancelNoticed = true; this.emit({ type: "notice", level: "warning", source: "host", text: "GJC started this run itself, so the chat can't stop it. It ends when GJC finishes." }); }
      if (this.connection && this.sessionId) void this.connection.agent.cancel({ sessionId: this.sessionId });
      return;
    }
    super.abort();
  }
  async dispose(): Promise<void> { if (this.searchTimer) clearTimeout(this.searchTimer); this.searchTimer = null; for (const wake of [...this.waiters]) wake(); await super.dispose(); }
}
