import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentCapabilities, AvailableCommand, SessionConfigOption, SessionConfigSelectOption, SessionModeState, SessionUpdate, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { AgentError, type AdapterHost, type AdapterOptions, type AgentCommand, type AgentModel, type AskAnswer, type Capabilities, type Disposition, type ImageBlock, type NormalizedEvent, type PermissionMode, type PromptMode, type ProviderAdapter, type SessionInfo, type SessionScope, type SessionSource, type UsageInfo } from "../types.ts";
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
type SelectOption = Extract<SessionConfigOption, { type: "select" }>;
/** How long `commands()` waits for the agent's first `available_commands_update` of a session. */
const COMMANDS_WAIT_MS = 2000;
/** How long a session change waits for the prompt it cancelled to finish. */
const STOP_WAIT_MS = 5000;
const DISPOSE_CLOSE_WAIT_MS = 2000;

export class AcpAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly tools = ACP_TOOLS;
  readonly capabilities: Capabilities;
  /** /resume: the first page of the agent's `session/list` (this folder's, or with `all` every folder's). */
  readonly sessions: SessionSource = { kind: "agent", list: (scope) => this.listSessions(scope) };
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
  /** The session whose `session/load` is under way: its replay is ours although `sessionId` is not it yet. */
  private loadingId: string | null = null;
  /** A session change is under way (`sessionId` is still the old one); `left`: sessions this chat moved away from. */
  private changing = false;
  private left = new Set<string>();
  /** `session/close` requests on their way, by session: loading that session again waits for its close. */
  private closing = new Map<string, Promise<unknown>>();
  /** Bumped by each session change and start: a prompt of an earlier one leaves the current state alone. */
  private epoch = 0;
  /** Resolves when the running `send` is done. */
  private sendDone: Promise<void> = Promise.resolve();
  private agentCaps: AgentCapabilities | undefined;
  /** The session's settings: its `configOptions` (model, thought_level, mode) and its modes. */
  private config: SessionConfigOption[] = [];
  private modes: SessionModeState | null = null;
  protected permissionModeOverride?: { modes: PermissionMode[]; initial: string; set: (conn: AcpConnection, sessionId: string, mode: string) => Promise<void> };
  private overrideMode: string | null = null;
  /** The settings last reported to the host, so an unchanged update says nothing. */
  private shown: { model?: string; thinking?: string; mode?: string | null } = {};
  /** The session's `available_commands_update` (null: none yet). */
  private agentCommands: AvailableCommand[] | null = null;
  private commandWaiters = new Set<() => void>();
  private lastUsage: { used: number; size: number; cost: number | null } | null = null;

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
  /** A session change begins (`newSession`, `switchSession`): forget the agent-specific state of the old session. */
  protected sessionChanging(): void {}
  /** The `session/load` replay is being read: its updates rebuild history, not the live chat. */
  protected get replaying(): boolean { return this.replay !== null; }
  /** Where the agent's command came from, for the `/` menu. */
  protected commandSource(_name: string): AgentCommand["source"] { return "extension"; }
  /** The references of these listed sessions (default: `sessionRef` each); null: only its id. */
  protected async sessionPaths(ids: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const id of ids) out.set(id, await this.sessionRef(id).catch(() => null));
    return out;
  }
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
    this.loadingId = null; this.changing = false; this.switching = null; this.left.clear(); this.closing.clear(); this.epoch++; this.agentCaps = undefined; this.forgetSession();
    this.capabilities.steer = Boolean(this.steer);
    const conn = new AcpConnection(this.opts.command, [...this.spec.args, ...this.opts.args], this.opts.cwd, agentEnv(this.spec.env), {
      // An update of another session (one this chat left, still running in the agent) is not this chat's.
      sessionUpdate: ({ sessionId, update }) => { if (this.accepts(sessionId)) this.onUpdate(update); },
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
    this.agentCaps = init.agentCapabilities;
    this.capabilities.images = init.agentCapabilities?.promptCapabilities?.image === true;
    this.emit({ type: "capabilities", capabilities: { images: this.capabilities.images, steer: this.capabilities.steer } });
    const version = init.agentInfo?.version ?? null;
    this.emit({ type: "version", version });
    if (!this.versionWarned && version && this.spec.minimumVersion && !versionAtLeast(version, this.spec.minimumVersion)) { this.versionWarned = true; this.emit({ type: "notice", level: "warning", source: "host", text: `${this.name} ${version} is older than the supported version ${this.spec.minimumVersion}.` }); }
    let resumed = false;
    if (session) {
      const id = await this.sessionIdOf(session);
      if (id) {
        try { await this.load(conn, id); resumed = true; } catch (error) { host.log(`ACP load failed: ${error}`); }
      }
      if (!resumed) this.emit({ type: "notice", level: "warning", source: "host", text: `Could not load the ${this.name} session; starting a new session.` });
    }
    if (!resumed) await this.create(conn);
    await this.announce();
    return { streaming: false, hasHistory: resumed };
  }
  /** `session/load`: its replay becomes the history, its settings the chat's. Throws (nothing changed) when the agent refuses. */
  private async load(conn: AcpConnection, id: string): Promise<void> {
    this.mapper = new AcpMapper(); this.replay = []; this.loadingId = id;
    try {
      const r = await conn.agent.loadSession({ sessionId: id, cwd: this.opts.cwd, mcpServers: [] });
      this.replay.push(...this.mapper.finish());
      this.historyEvents = this.replay; this.sessionId = id;
      this.applySettings(r?.configOptions, r?.modes);
    } catch (error) { this.mapper = new AcpMapper(); throw error; } finally { this.replay = null; this.loadingId = null; }
  }
  private async create(conn: AcpConnection): Promise<void> {
    const r = await conn.agent.newSession({ cwd: this.opts.cwd, mcpServers: [] });
    this.historyEvents = []; this.sessionId = r.sessionId;
    this.applySettings(r.configOptions, r.modes);
  }
  /** The session is open: its reference and name (a loaded one's title from its replay) go to the host. */
  private async announce(): Promise<void> {
    this.sessionOpened();
    const file = await this.sessionRef(this.sessionId!);
    const named = this.historyEvents.findLast((e): e is Extract<NormalizedEvent, { type: "session" }> => e.type === "session" && e.name !== undefined);
    this.emit({ type: "session", id: this.sessionId, file, name: named?.name ?? null });
  }
  /** An update or ask of this session is the chat's. A new session's id is not known before its answer, so while one is created anything but the old sessions is. */
  private accepts(sessionId: string): boolean {
    if (sessionId === this.loadingId) return true;
    if (this.changing) return this.loadingId === null && sessionId !== this.sessionId && !this.left.has(sessionId);
    return this.sessionId === null || sessionId === this.sessionId;
  }
  /** Forgets the session's settings, commands and usage (a new one reports its own). */
  private forgetSession(): void {
    this.config = []; this.modes = null; this.shown = {}; this.agentCommands = null; this.lastUsage = null;
    this.overrideMode = this.permissionModeOverride?.initial ?? null;
  }
  protected onUpdate(update: SessionUpdate): void {
    if (!this.replay) this.emit({ type: "heartbeat" });
    switch (update.sessionUpdate) {
      case "config_option_update": this.applySettings(update.configOptions, undefined); break;
      case "current_mode_update": this.setCurrentMode(update.currentModeId); break;
      case "available_commands_update": this.agentCommands = update.availableCommands; for (const wake of [...this.commandWaiters]) wake(); break;
      case "usage_update": this.lastUsage = { used: update.used, size: update.size, cost: update.cost?.amount ?? null }; break;
    }
    const hint = this.phaseHint(update);
    if (hint) { if (this.pending && hint === "working") this.openRun(); this.onPhaseHint(hint, update); }
    if (!this.replay && this.pending && ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(update.sessionUpdate)) { if (update.sessionUpdate === "user_message_chunk") this.pending.accepted = true; this.pending.observedOutput = true; this.openRun(); }
    const id = update.sessionUpdate === "user_message_chunk" ? this.echoId : undefined;
    if (id) this.echoId = undefined;
    for (const event of this.mapper.update(update, id)) this.emit(event);
  }
  private permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.accepts(request.sessionId)) { this.host?.log(`${this.name} asked for a session this chat left; cancelled`); return Promise.resolve({ outcome: { outcome: "cancelled" } }); }
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
    if (this.switching) { await this.switching; return this.prompt(p); }
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
    let done!: () => void;
    this.sendDone = new Promise<void>((resolve) => { done = resolve; });
    const conn = this.connection;
    // A session change stopped this prompt and settled its run: whatever the agent answers later belongs to no run now.
    const epoch = this.epoch;
    const stale = () => this.epoch !== epoch;
    let cancelled = false;
    try {
      while (true) {
        try {
          if (!conn || this.connection !== conn || !conn.alive) throw new AgentError(`${this.name} is not running`, true);
          await this.onPromptOutcome({ type: "sending" }, ctx);
          if (this.connection !== conn || !conn.alive) throw new AgentError(`${this.name} is not running`, true);
          // The session changed before it went out: it goes back to the composer.
          if (stale()) { this.emit({ type: "editor_text", text: p.text }); return { disposition: "handled" }; }
          this.echoId = p.id;
          this.promptLive = true;
          const result = await conn.agent.prompt({ sessionId: this.sessionId!, prompt: [{ type: "text", text: p.text }, ...p.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))] }).finally(() => { if (!stale()) this.promptLive = false; });
          if (stale()) return { disposition: "started" };
          ctx.stopReason = result.stopReason;
          const action = await this.onPromptOutcome({ type: "response" }, ctx);
          if (action === "handled") return { disposition: "handled" };
          if (action === "retry") { ctx.attempt++; continue; }
          ctx.accepted = true; this.openRun(); cancelled = result.stopReason === "cancelled"; break;
        } catch (error) {
          // The prompt of a session this chat left (its run already settled): nothing to report.
          if (stale()) return { disposition: "started" };
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
      // A session change stopped this prompt meanwhile: its run is already settled.
      if (stale() || this.pending !== ctx) return { disposition: "started" };
      this.pending = null;
      if (gate !== "settle") return { disposition: "started" };
      if (!cancelled && !this.aborting && this.queue.length) {
        this.drainQueue();
      } else { this.settleRun(cancelled || this.aborting); this.aborting = false; }
      return { disposition: "started" };
    } finally { if (!stale()) { if (this.pending === ctx) { this.pending = null; this.echoId = undefined; } this.aborting = false; } done(); }
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
  /** Closes the open session when the agent can (bounded), then the connection and the process. The connection is dropped first, so nothing resends on it. */
  async dispose(): Promise<void> {
    const conn = this.connection, session = this.sessionId;
    this.connection = null;
    if (!conn) return;
    if (session && this.agentCaps?.sessionCapabilities?.close) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        conn.agent.closeSession({ sessionId: session }).catch((error) => this.host?.log(`${this.name} session/close failed: ${errorText(error)}`)),
        new Promise((resolve) => { timer = setTimeout(resolve, DISPOSE_CLOSE_WAIT_MS); }),
      ]).finally(() => clearTimeout(timer));
    }
    await conn.stop();
  }
  kill(): void { this.connection?.kill(); }

  // ---- settings: the session's configOptions (category model, thought_level, mode) and its modes

  /** Takes the agent's settings (`undefined`: unchanged) and reports what changed. */
  private applySettings(config: SessionConfigOption[] | null | undefined, modes: SessionModeState | null | undefined): void {
    if (config) this.config = config;
    if (modes) this.modes = modes;
    this.showSettings();
  }
  private setCurrentMode(id: string): void {
    if (this.modes) this.modes = { ...this.modes, currentModeId: id };
    const option = this.option("mode");
    if (option) this.config = this.config.map((o) => (o === option ? { ...option, currentValue: id } : o));
    this.showSettings();
  }
  private option(category: string): SelectOption | undefined {
    return this.config.find((o): o is SelectOption => o.category === category && o.type === "select");
  }
  private permissionModes(): PermissionMode[] {
    if (this.permissionModeOverride) return this.permissionModeOverride.modes;
    const list = this.modes?.availableModes.map((m) => ({ id: m.id, name: m.name, description: m.description })) ?? choices(this.option("mode")).map((c) => ({ id: c.value, name: c.name, description: c.description }));
    return list.map((m) => ({ id: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) }));
  }
  private showSettings(): void {
    const model = this.option("model"), thought = this.option("thought_level");
    const changed: Partial<Capabilities> = {};
    const levels = choices(thought).map((c) => c.value);
    if (levels.join("\n") !== this.capabilities.thinkingLevels.join("\n")) changed.thinkingLevels = this.capabilities.thinkingLevels = levels;
    const modes = this.permissionModes();
    if (JSON.stringify(modes) !== JSON.stringify(this.capabilities.permissionModes)) changed.permissionModes = this.capabilities.permissionModes = modes;
    if (Object.keys(changed).length) this.live({ type: "capabilities", capabilities: changed });
    if (model && model.currentValue !== this.shown.model) {
      this.shown.model = model.currentValue;
      const name = choices(model).find((c) => c.value === model.currentValue)?.name ?? model.currentValue;
      this.live({ type: "model", model: { provider: this.id, id: model.currentValue, name, reasoning: Boolean(thought), contextWindow: this.lastUsage?.size ?? null, input: this.capabilities.images ? ["text", "image"] : ["text"] } });
    }
    if (thought && thought.currentValue !== this.shown.thinking) { this.shown.thinking = thought.currentValue; this.live({ type: "thinking", level: thought.currentValue }); }
    const mode = this.permissionModeOverride ? this.overrideMode : this.modes?.currentModeId ?? this.option("mode")?.currentValue ?? null;
    if (mode !== (this.shown.mode ?? null)) { this.shown.mode = mode; this.live({ type: "permission_mode", mode }); }
  }
  /** Settings are the live chat's, also while a replay is read. */
  private live(event: NormalizedEvent): void { this.host?.emit(event); }
  private session(): { conn: AcpConnection; sessionId: string } {
    if (!this.connection || !this.sessionId) throw new AgentError(`${this.name} is not running`, !this.alive);
    return { conn: this.connection, sessionId: this.sessionId };
  }
  /** The agent refused a change: the chat shows the setting it still has, and says why once. */
  private refused(what: string, error: unknown, epoch: number): never {
    const reason = errorText(error);
    if (this.epoch === epoch) { this.shown = {}; this.showSettings(); } // not for a session left meanwhile
    this.emit({ type: "notice", level: "warning", source: "host", text: `${this.name} didn't change the ${what}: ${reason}` });
    throw new Error(reason);
  }
  private async setOption(category: string, value: string, what: string): Promise<void> {
    await this.switching;
    const option = this.option(category);
    if (!option) throw new Error(`${this.name} has no ${what} setting`);
    if (!choices(option).some((c) => c.value === value)) throw new Error(`${this.name} has no ${what} "${value}"`);
    const { conn, sessionId } = this.session();
    const epoch = this.epoch;
    let r;
    try { r = await conn.agent.setSessionConfigOption({ sessionId, configId: option.id, value }); } catch (error) { this.refused(what, error, epoch); }
    if (this.epoch === epoch) this.applySettings(r.configOptions, undefined); // not a session left meanwhile
  }
  async listModels(): Promise<AgentModel[]> {
    const reasoning = Boolean(this.option("thought_level"));
    return choices(this.option("model")).map((c) => ({ provider: this.id, id: c.value, name: c.name, reasoning, enabled: true }));
  }
  async setModel(_provider: string, id: string): Promise<void> { await this.setOption("model", id, "model"); }
  async setThinking(level: string): Promise<void> { await this.setOption("thought_level", level, "thinking level"); }
  async setPermissionMode(mode: string): Promise<void> {
    await this.switching;
    if (this.permissionModeOverride) {
      if (!this.permissionModeOverride.modes.some((m) => m.id === mode)) throw new Error(`${this.name} has no mode "${mode}"`);
      const { conn, sessionId } = this.session();
      const epoch = this.epoch;
      try { await this.permissionModeOverride.set(conn, sessionId, mode); } catch (error) { this.refused("mode", error, epoch); }
      if (this.epoch === epoch) { this.overrideMode = mode; this.showSettings(); }
      return;
    }
    if (!this.modes) return this.setOption("mode", mode, "mode");
    if (!this.modes.availableModes.some((m) => m.id === mode)) throw new Error(`${this.name} has no mode "${mode}"`);
    const { conn, sessionId } = this.session();
    const epoch = this.epoch;
    try { await conn.agent.setSessionMode({ sessionId, modeId: mode }); } catch (error) { this.refused("mode", error, epoch); }
    if (this.epoch === epoch) this.setCurrentMode(mode);
  }

  // ---- commands and usage

  async commands(): Promise<AgentCommand[]> {
    if (!this.agentCommands && this.alive) {
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); this.commandWaiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, COMMANDS_WAIT_MS);
        this.commandWaiters.add(wake);
      });
    }
    return (this.agentCommands ?? []).map((c) => ({ name: c.name, description: c.description, source: this.commandSource(c.name) }));
  }
  /** The last `usage_update`: the context in use and its size, and the cost when the agent sends one. */
  async usage(): Promise<UsageInfo> {
    const u = this.lastUsage;
    return { contextTokens: u?.used ?? null, contextWindow: u?.size ?? null, percent: u && u.size > 0 ? Math.round((u.used / u.size) * 100) : null, cost: u?.cost ?? null };
  }

  // ---- sessions

  private async listSessions(scope: SessionScope): Promise<SessionInfo[]> {
    const conn = this.connection;
    if (!conn) throw new AgentError(`${this.name} is not running`, true);
    if (!this.agentCaps?.sessionCapabilities?.list) return [];
    const { sessions } = await conn.agent.listSessions(scope === "cwd" ? { cwd: this.opts.cwd } : {});
    const paths = await this.sessionPaths(sessions.map((s) => s.sessionId));
    const out = sessions.map((s): SessionInfo => {
      let modified = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
      if (!Number.isFinite(modified)) { this.host?.log(`${this.name} session ${s.sessionId}: no usable updatedAt (${s.updatedAt ?? "none"})`); modified = 0; }
      return { path: paths.get(s.sessionId) ?? s.sessionId, name: s.title || null, firstMessage: "", modified, messageCount: null, cwd: s.cwd ?? null };
    });
    // Newest first (an unknown time, 0, last); the same time keeps the agent's order (a stable sort).
    return out.sort((a, b) => b.modified - a.modified);
  }
  async newSession(): Promise<void> { await this.change(null); }
  /** A message can't go to the session being left: it waits for the change, then goes to the session the chat is on (the old one when the change failed). */
  private switching: Promise<void> | null = null;
  async switchSession(path: string): Promise<void> {
    const id = (await this.sessionIdOf(path)) ?? (/^[\w.-]+$/.test(path) ? path : null);
    if (!id) throw new Error(`"${path}" is not a ${this.name} session`);
    await this.change(id);
  }
  /** Stops this session's run, then loads `id` (null: a new session). The old one is closed when the agent can. */
  private async change(id: string | null): Promise<void> {
    if (this.switching) throw new Error(`${this.name} is already switching sessions`);
    const done = this.changeNow(id);
    const tracked = done.then(() => {}, () => {}).finally(() => { if (this.switching === tracked) this.switching = null; });
    this.switching = tracked;
    return done;
  }
  private async changeNow(id: string | null): Promise<void> {
    const { conn, sessionId: previous } = this.session();
    await this.stopRun(conn, previous);
    this.epoch++;
    const settings = { config: this.config, modes: this.modes, shown: this.shown, commands: this.agentCommands, usage: this.lastUsage, overrideMode: this.overrideMode };
    this.forgetSession(); this.sessionChanging();
    this.changing = true;
    try {
      if (id) { await this.untilClosed(id); await this.load(conn, id); } else await this.create(conn);
    } catch (error) {
      // `sessionId` is still the old one: load and create set it only once the agent answered.
      ({ config: this.config, modes: this.modes, shown: this.shown, commands: this.agentCommands, usage: this.lastUsage, overrideMode: this.overrideMode } = settings);
      this.changing = false; // the old session is the chat's again
      this.sessionOpened();
      await this.sessionRef(previous).catch(() => null);
      this.shown = {}; this.showSettings(); // a failed load may have shown its own settings
      throw error;
    } finally { this.changing = false; }
    if (previous !== this.sessionId) this.left.add(previous);
    this.left.delete(this.sessionId!);
    await this.announce();
    if (previous !== this.sessionId && this.agentCaps?.sessionCapabilities?.close) {
      const closed = conn.agent.closeSession({ sessionId: previous }).catch((error) => this.host?.log(`${this.name} session/close failed: ${errorText(error)}`)).finally(() => { if (this.closing.get(previous) === closed) this.closing.delete(previous); });
      this.closing.set(previous, closed);
    }
  }
  /** Waits (at most 5 s) for the close of a session this chat left, before it loads it again. */
  private async untilClosed(id: string): Promise<void> {
    const closing = this.closing.get(id);
    if (!closing) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([closing, new Promise((resolve) => { timer = setTimeout(resolve, STOP_WAIT_MS); })]).finally(() => clearTimeout(timer));
  }
  /** Ends the run like Codex's switchSession: cancel and wait for the prompt, settle, drop the queue and asks. */
  private async stopRun(conn: AcpConnection, sessionId: string): Promise<void> {
    if (this.pending) {
      if (!this.aborting) void conn.agent.cancel({ sessionId }); // the core's Esc already cancelled it
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.sendDone, new Promise((resolve) => { timer = setTimeout(resolve, STOP_WAIT_MS); })]).finally(() => clearTimeout(timer));
      this.pending = null;
    }
    for (const [id, ask] of this.asks) { ask.resolve({ outcome: { outcome: "cancelled" } }); this.emit({ type: "ask_closed", id }); }
    this.asks.clear();
    this.settleRun(true);
    if (this.queue.length || this.steering.length) { this.queue = []; this.steering = []; this.queueChanged(); }
    this.steerAnswers.clear(); this.aborting = false; this.promptLive = false; this.echoId = undefined;
  }
  async compact(_instructions?: string): Promise<void> { throw new Error(`${this.name} can't compact here`); }
  async setName(_name: string): Promise<void> { throw new Error(`${this.name} can't name sessions here`); }
}

/** A select option's choices, its groups flattened. */
function choices(option: SelectOption | undefined): SessionConfigSelectOption[] {
  return (option?.options ?? []).flatMap((o) => ("group" in o ? o.options : [o]));
}

function errorText(error: unknown): string {
  const data = (error as { data?: { details?: unknown } } | null)?.data;
  if (typeof data?.details === "string" && data.details) return data.details;
  return error instanceof Error ? error.message : String(error);
}

function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const b = minimum.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i++) { if (a[i]! !== b[i]!) return a[i]! > b[i]!; }
  return true;
}
