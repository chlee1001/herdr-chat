import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionUpdate, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { AgentError, type AdapterHost, type AdapterOptions, type AskAnswer, type Capabilities, type Disposition, type ImageBlock, type NormalizedEvent, type PromptMode, type ProviderAdapter, type SessionSource } from "../types.ts";
import { agentEnv } from "../env.ts";
import { AcpConnection } from "./connection.ts";
import { AcpMapper } from "./map.ts";
import { ACP_TOOLS } from "./tools.ts";
import type { AcpAgentSpec } from "./spec.ts";

export type AcpPrompt = { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean };
export type PromptContext = { prompt: AcpPrompt; draining: boolean; accepted: boolean; observedOutput: boolean; attempt: number; stopReason?: string };
export type PromptErrorAction = "retry" | "handled" | "throw" | "proceed";
export type PromptOutcome = { type: "sending" } | { type: "response" } | { type: "error"; error: unknown };
/** A steer's answer: taken into the running turn, refused this time (it waits for the run's end), or never possible with this agent. */
export type SteerResult = { status: "accepted" } | { status: "rejected"; reason: string } | { status: "unsupported" };

export class AcpAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly tools = ACP_TOOLS;
  readonly capabilities: Capabilities;
  readonly sessions: SessionSource = { kind: "agent", list: async () => [] };
  protected readonly spec: AcpAgentSpec;
  protected readonly opts: AdapterOptions;
  protected host: AdapterHost | null = null;
  protected connection: AcpConnection | null = null;
  protected sessionId: string | null = null;
  protected runOpen = false;
  protected pending: PromptContext | null = null;
  protected aborting = false;
  protected queue: AcpPrompt[] = [];
  /** Steers sent to the agent and not answered yet, with their answers. */
  private steering: AcpPrompt[] = [];
  private steerAnswers = new Map<AcpPrompt, Promise<SteerResult>>();
  private clearing = false;
  /** A `session/prompt` of ours is unanswered: its turn is running, so a steer joins it. */
  private promptLive = false;
  private mapper = new AcpMapper();
  private replay: NormalizedEvent[] | null = null;
  private historyEvents: NormalizedEvent[] = [];
  private asks = new Map<string, { resolve: (response: RequestPermissionResponse) => void; tool: string; denied: Set<string> }>();
  private echoId: string | undefined;
  private versionWarned = false;

  constructor(spec: AcpAgentSpec, opts: AdapterOptions) {
    this.spec = spec; this.opts = opts; this.id = spec.id; this.name = spec.name;
    this.capabilities = { steer: Boolean(this.steer), followUp: true, thinkingLevels: [], permissions: true, permissionModes: [], extensionUi: false, compact: false, compactInstructions: false, rename: false, fork: false, images: false, cost: false, tui: Boolean(spec.tui?.length) };
  }
  get alive(): boolean { return this.connection?.alive ?? false; }
  protected emit(event: NormalizedEvent): void { if (this.replay) this.replay.push(event); else this.host?.emit(event); }
  protected openRun(): void { if (!this.runOpen) { this.runOpen = true; this.emit({ type: "run_started" }); } }
  protected settleRun(aborted: boolean): void { if (this.runOpen) { for (const event of this.mapper.finish()) this.emit(event); this.runOpen = false; this.emit({ type: "run_settled", aborted }); this.onRunSettled(); } }
  protected onRunSettled(): void {}
  protected onConnectionClosed(): void {}
  protected queueChanged(): void { this.emit({ type: "queue_changed", steering: this.steering.map((p) => p.text), steeringIds: this.steering.map((p) => p.id), followUp: this.queue.map((p) => p.text), followUpIds: this.queue.map((p) => p.id) }); }
  protected clientMeta(): Record<string, unknown> { return this.spec.clientMeta ?? {}; }
  protected phaseHint(_update: SessionUpdate): "working" | "idle" | null { return null; }
  protected async settleGate(_ctx: PromptContext): Promise<"settle" | "hold"> { return "settle"; }
  protected async onPromptOutcome(outcome: PromptOutcome, _ctx: PromptContext): Promise<PromptErrorAction> { return outcome.type === "error" ? "throw" : "proceed"; }
  protected sessionOpened(): void {}
  /** Sends a message into the turn of an unanswered prompt. Without it, messages sent while the agent works wait in the adapter queue. */
  protected steer?(text: string, id: string): Promise<SteerResult>;
  protected onPhaseHint(_hint: "working" | "idle", _update: SessionUpdate): void {}
  protected async sessionRef(sessionId: string): Promise<string | null> {
    if (!sessionId || sessionId === "." || sessionId === ".." || /[/\\\0]/.test(sessionId) || !/^[\w.-]+$/.test(this.id)) throw new Error("Invalid ACP session identifier");
    const dir = join(this.opts.stateDir ?? join(homedir(), ".local", "state", "herdr-chat"), "acp-sessions", this.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${sessionId}.json`);
    await writeFile(path, JSON.stringify({ agentId: this.id, sessionId, cwd: this.opts.cwd }), { mode: 0o600 });
    return path;
  }
  protected async sessionIdOf(ref: string): Promise<string | null> {
    try { const pointer = JSON.parse(await readFile(ref, "utf8")); return pointer.agentId === this.id && typeof pointer.sessionId === "string" ? pointer.sessionId : null; } catch { return null; }
  }
  tuiCommand(session: string): string[] { if (!this.spec.tui?.length) throw new Error(`${this.name} has no TUI hand-off`); return this.spec.tui.map((arg) => arg.replaceAll("{session}", session)); }

  async start(session: string | null, host: AdapterHost): Promise<{ streaming: boolean; hasHistory: boolean }> {
    this.host = host; this.mapper = new AcpMapper(); this.historyEvents = [];
    this.sessionId = null; this.pending = null; this.runOpen = false; this.aborting = false; this.queue = []; this.steering = []; this.steerAnswers.clear(); this.promptLive = false; this.echoId = undefined;
    this.capabilities.steer = Boolean(this.steer);
    const conn = new AcpConnection(this.opts.command, [...this.spec.args, ...this.opts.args], this.opts.cwd, agentEnv(this.spec.env), {
      sessionUpdate: ({ update }) => this.onUpdate(update),
      requestPermission: (request) => this.permission(request),
    });
    this.connection = conn;
    conn.onExit = (exit) => {
      if (this.connection !== conn) return;
      this.connection = null; this.runOpen = false; this.aborting = false; this.onConnectionClosed();
      // Unsent texts go back before `exited`, so the core's held follow-ups land after them in the composer.
      const unsent = this.pending?.draining && !this.pending.accepted && !this.pending.observedOutput ? [this.pending.prompt.text] : [];
      const texts = [...unsent, ...this.steering.map((p) => p.text), ...this.queue.map((p) => p.text)];
      if (this.queue.length || this.steering.length) { this.queue = []; this.steering = []; this.queueChanged(); }
      if (texts.length) this.emit({ type: "editor_text", text: texts.join("\n\n") });
      this.emit({ type: "exited", ...exit, command: this.opts.command });
    };
    // An agent that dies on launch (an interpreter missing from PATH) breaks the pipe before it
    // closes: wait for its exit, so the core reports the exit and its stderr, not the write error.
    try { return await this.open(conn, session, host); } catch (error) { await conn.exited(1000); throw error; }
  }
  private async open(conn: AcpConnection, session: string | null, host: AdapterHost): Promise<{ streaming: boolean; hasHistory: boolean }> {
    const init = await conn.agent.initialize({ protocolVersion: 1, clientCapabilities: { _meta: this.clientMeta() }, clientInfo: { name: "herdr-chat", version: "0.1.0" } });
    this.emit({ type: "capabilities", capabilities: { images: init.agentCapabilities?.promptCapabilities?.image === true, steer: this.capabilities.steer } });
    const version = init.agentInfo?.version ?? null;
    this.emit({ type: "version", version });
    if (!this.versionWarned && version && this.spec.minimumVersion && !versionAtLeast(version, this.spec.minimumVersion)) { this.versionWarned = true; this.emit({ type: "notice", level: "warning", source: "host", text: `${this.name} ${version} is older than the supported version ${this.spec.minimumVersion}.` }); }
    let resumed = false;
    if (session) {
      const id = await this.sessionIdOf(session);
      if (id) {
        this.replay = [];
        try {
          await conn.agent.loadSession({ sessionId: id, cwd: this.opts.cwd, mcpServers: [] });
          this.replay.push(...this.mapper.finish()); this.historyEvents = this.replay; this.sessionId = id; resumed = true;
        } catch (error) { host.log(`ACP load failed: ${error}`); this.mapper = new AcpMapper(); }
        this.replay = null;
      }
      if (!resumed) this.emit({ type: "notice", level: "warning", source: "host", text: `Could not load the ${this.name} session; starting a new session.` });
    }
    if (!resumed) this.sessionId = (await conn.agent.newSession({ cwd: this.opts.cwd, mcpServers: [] })).sessionId;
    this.sessionOpened();
    const file = await this.sessionRef(this.sessionId!);
    this.emit({ type: "session", id: this.sessionId, file, name: null });
    return { streaming: false, hasHistory: resumed };
  }
  protected onUpdate(update: SessionUpdate): void {
    if (!this.replay) this.emit({ type: "heartbeat" });
    const hint = this.phaseHint(update);
    if (hint) { if (this.pending && hint === "working") this.openRun(); this.onPhaseHint(hint, update); }
    if (!this.replay && this.pending && ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(update.sessionUpdate)) { if (update.sessionUpdate === "user_message_chunk") this.pending.accepted = true; this.pending.observedOutput = true; this.openRun(); }
    const id = update.sessionUpdate === "user_message_chunk" ? this.echoId : undefined;
    if (id) this.echoId = undefined;
    for (const event of this.mapper.update(update, id)) this.emit(event);
  }
  private permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.pending) { this.pending.accepted = true; this.openRun(); }
    const id = randomUUID();
    return new Promise((resolve) => {
      this.asks.set(id, { resolve, tool: request.toolCall.toolCallId, denied: new Set(request.options.filter((o) => o.kind === "reject_once" || o.kind === "reject_always").map((o) => o.optionId)) });
      this.emit({ type: "ask", ask: { id, kind: "permission", title: request.toolCall.title ?? "Permission", tool: { name: request.toolCall.kind ?? "other", args: request.toolCall.rawInput, callId: request.toolCall.toolCallId }, choices: request.options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind === "allow_once" ? "allow" : o.kind === "allow_always" ? "allow_always" : o.kind === "reject_once" || o.kind === "reject_always" ? "deny" : "other" })) } });
    });
  }
  answer(id: string, answer: AskAnswer): void {
    const ask = this.asks.get(id); if (!ask) return; this.asks.delete(id);
    if ("choice" in answer) { if (ask.denied.has(answer.choice)) this.mapper.decline(ask.tool); ask.resolve({ outcome: { outcome: "selected", optionId: answer.choice } }); }
    else { this.mapper.decline(ask.tool); ask.resolve({ outcome: { outcome: "cancelled" } }); }
  }
  async prompt(p: AcpPrompt): Promise<{ disposition: Disposition }> {
    if (!this.connection || !this.sessionId) throw new AgentError(`${this.name} is not running`, !this.alive);
    if (p.busy || this.pending || this.runOpen) {
      // A steer carries text only: a message with images waits for the run's end. So does one sent after our prompt
      // was answered (the run's tail, or a run the agent started itself): an agent may take a steer then and run it
      // as a turn of its own, whose output never reaches this client.
      if (this.steer && this.capabilities.steer && this.promptLive && p.mode !== "followUp" && !p.images.length) return this.steerPrompt(p, this.steer.bind(this));
      this.queue.push(p); this.queueChanged(); return { disposition: "queued" };
    }
    return this.send(p, false);
  }
  private async steerPrompt(p: AcpPrompt, steer: (text: string, id: string) => Promise<SteerResult>): Promise<{ disposition: Disposition }> {
    this.steering.push(p); this.queueChanged();
    const answer = steer(p.text, p.id).catch((error): SteerResult => ({ status: "rejected", reason: error instanceof Error ? error.message : String(error) }));
    this.steerAnswers.set(p, answer);
    const result = await answer;
    this.steerAnswers.delete(p);
    const index = this.steering.indexOf(p);
    // Stopped or exited meanwhile: its text already went back to the composer.
    if (index < 0) {
      if (result.status === "accepted" && this.alive) this.emit({ type: "notice", level: "warning", source: "host", text: `${this.name} took a steer after it went back to the composer: "${p.text.slice(0, 80)}". Sending it again repeats it.` });
      return { disposition: "queued" };
    }
    this.steering.splice(index, 1);
    if (result.status === "accepted") {
      // The agent doesn't echo a steer: the chat shows it here, where it joined the turn.
      for (const event of this.mapper.finish()) this.emit(event);
      this.emit({ type: "user_message", text: p.text, images: 0, clientId: p.id });
      this.queueChanged();
      return { disposition: "queued" };
    }
    if (result.status === "unsupported") {
      this.capabilities.steer = false;
      this.emit({ type: "capabilities", capabilities: { steer: false } });
      this.emit({ type: "notice", level: "warning", source: "host", text: `${this.name} can't steer a running turn: messages sent while it works wait for the run to end.` });
    } else this.host?.log(`${this.name} steer rejected: ${result.reason}`);
    if (this.pending || this.runOpen || this.clearing) {
      this.queue.push(p); this.queueChanged();
      if (result.status === "rejected" && !this.clearing) this.emit({ type: "notice", level: "warning", source: "host", text: `${this.name} didn't take the steer (${result.reason}); it goes after this run.`, once: "run" });
      return { disposition: "queued" };
    }
    // The run ended while the steer was on its way: the message starts the next one.
    this.queueChanged();
    this.emit({ type: "run_cause", text: "Started by a message sent as the last turn ended." });
    return this.send(p, false);
  }
  protected async send(p: AcpPrompt, draining: boolean): Promise<{ disposition: Disposition }> {
    const ctx: PromptContext = { prompt: p, draining, accepted: false, observedOutput: false, attempt: 0 }; this.pending = ctx;
    const conn = this.connection;
    let cancelled = false;
    try {
      while (true) {
        try {
          if (!conn || this.connection !== conn || !conn.alive) throw new AgentError(`${this.name} is not running`, true);
          await this.onPromptOutcome({ type: "sending" }, ctx);
          if (this.connection !== conn || !conn.alive) throw new AgentError(`${this.name} is not running`, true);
          this.echoId = p.id;
          this.promptLive = true;
          const result = await conn.agent.prompt({ sessionId: this.sessionId!, prompt: [{ type: "text", text: p.text }, ...p.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))] }).finally(() => { this.promptLive = false; });
          ctx.stopReason = result.stopReason;
          const action = await this.onPromptOutcome({ type: "response" }, ctx);
          if (action === "handled") return { disposition: "handled" };
          if (action === "retry") { ctx.attempt++; continue; }
          ctx.accepted = true; this.openRun(); cancelled = result.stopReason === "cancelled"; break;
        } catch (error) {
          if (!conn || this.connection !== conn || !conn.alive) {
            if (ctx.accepted || ctx.observedOutput) return { disposition: "started" };
            throw new AgentError(`${this.name} is not running`, true);
          }
          const action = await this.onPromptOutcome({ type: "error", error }, ctx);
          if (action === "retry") { ctx.attempt++; continue; }
          if (action === "handled") return { disposition: "handled" };
          if (ctx.accepted || ctx.observedOutput) {
            this.emit({ type: "notice", level: "error", source: "host", text: `${this.name} failed: ${error instanceof Error ? error.message : String(error)}` });
            if (this.queue.length) {
              this.emit({ type: "editor_text", text: this.queue.map((item) => item.text).join("\n\n") });
              this.queue = []; this.queueChanged();
            }
            if (this.runOpen && await this.waitForGate(conn, ctx) === "settle") this.settleRun(true);
            return { disposition: "started" };
          }
          if (this.runOpen && !draining && await this.waitForGate(conn, ctx) === "settle") this.settleRun(true);
          throw new AgentError(error instanceof Error ? error.message : String(error), !this.alive);
        }
      }
      for (const event of this.mapper.finish()) this.emit(event);
      const gate = await this.waitForGate(conn!, ctx);
      this.pending = null;
      if (gate !== "settle") return { disposition: "started" };
      if (!cancelled && !this.aborting && this.queue.length) {
        this.drainQueue();
      } else { this.settleRun(cancelled || this.aborting); this.aborting = false; }
      return { disposition: "started" };
    } finally { if (this.pending === ctx) { this.pending = null; this.echoId = undefined; } this.aborting = false; }
  }
  private async waitForGate(conn: AcpConnection, ctx: PromptContext): Promise<"settle" | "hold"> {
    if (this.connection !== conn || !conn.alive) return "hold";
    const gate = await Promise.race([this.settleGate(ctx), conn.closed.then(() => "hold" as const)]);
    return this.connection === conn && conn.alive ? gate : "hold";
  }
  protected drainQueue(): void {
    const next = this.queue.shift();
    if (!next) return;
    this.queueChanged();
    void this.send(next, true).catch((error) => {
      if (!this.alive) return; // the exit already gave the texts back
      const texts = [next.text, ...this.queue.map((p) => p.text)];
      this.queue = []; this.queueChanged();
      this.emit({ type: "editor_text", text: texts.join("\n\n") });
      this.emit({ type: "notice", level: "warning", source: "host", text: `Could not send queued messages: ${error instanceof Error ? error.message : String(error)}` });
      this.settleRun(true);
    });
  }
  async clearQueue(): Promise<string[]> {
    // A steer on its way may already be in the turn: wait briefly for its answer, so a taken one isn't also given back.
    const answers = [...this.steerAnswers.values()];
    if (answers.length) {
      this.clearing = true;
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([Promise.all(answers), new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]); } finally { clearTimeout(timer); this.clearing = false; }
    }
    const texts = [...this.steering, ...this.queue].map((p) => p.text); this.steering = []; this.queue = []; this.queueChanged(); return texts;
  }
  canRemoveQueued(id: string): boolean { return this.queue.some((p) => p.id === id); }
  async removeQueued(id: string): Promise<boolean> { const index = this.queue.findIndex((p) => p.id === id); if (index < 0) return false; this.queue.splice(index, 1); this.queueChanged(); return true; }
  abort(): void { this.aborting = true; for (const [id, ask] of this.asks) { ask.resolve({ outcome: { outcome: "cancelled" } }); this.emit({ type: "ask_closed", id }); } this.asks.clear(); if (this.sessionId && this.connection) void this.connection.agent.cancel({ sessionId: this.sessionId }); }
  async history(): Promise<NormalizedEvent[]> { return this.historyEvents; }
  async dispose(): Promise<void> { const conn = this.connection; this.connection = null; if (conn) await conn.stop(); }
  kill(): void { this.connection?.kill(); }
  async listModels(): Promise<[]> { return []; }
  async commands(): Promise<[]> { return []; }
  async usage(): Promise<{ contextTokens: null; contextWindow: null; percent: null; cost: null }> { return { contextTokens: null, contextWindow: null, percent: null, cost: null }; }
  async setModel(): Promise<void> { throw new Error("ACP model selection is not available"); }
  async setThinking(): Promise<void> { throw new Error("ACP thinking selection is not available"); }
  async setPermissionMode(): Promise<void> { throw new Error("ACP permission modes are not available"); }
  async compact(): Promise<void> { throw new Error("ACP compaction is not available"); }
  async newSession(): Promise<void> { throw new Error("ACP session switching is not available"); }
  async switchSession(): Promise<void> { throw new Error("ACP session switching is not available"); }
  async setName(): Promise<void> { throw new Error("ACP session renaming is not available"); }
}

function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const b = minimum.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i++) { if (a[i]! !== b[i]!) return a[i]! > b[i]!; }
  return true;
}
