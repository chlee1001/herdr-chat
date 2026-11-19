import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, type Client } from "@agentclientprotocol/sdk";

export type AcpExit = { code: number | null; signal: NodeJS.Signals | null; stderrTail: string; spawnError?: string };

/** One ACP connection and its process group. */
export class AcpConnection {
  readonly agent: ClientSideConnection;
  readonly process: ChildProcessWithoutNullStreams;
  private stderr = "";
  private spawnError: string | undefined;
  private stopping = false;
  private ended = false;
  private done: Promise<void>;
  onExit: (exit: AcpExit) => void = () => {};

  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, client: Client) {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: "pipe" });
    this.process = child;
    child.stderr.on("data", (data: Buffer) => { this.stderr = (this.stderr + data.toString()).slice(-16_384); });
    child.on("error", (error) => { this.spawnError = error.message; });
    // An early spawn failure may also close stdin while the SDK is writing.
    child.stdin.on("error", () => {});
    this.done = new Promise((resolve) => child.once("close", (code, signal) => {
      this.ended = true;
      if (!this.stopping) this.onExit({ code, signal, stderrTail: this.stderr, ...(this.spawnError ? { spawnError: this.spawnError } : {}) });
      resolve();
    }));
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    this.agent = new ClientSideConnection(() => client, stream);
  }

  get alive(): boolean { return !this.ended; }
  get closed(): Promise<void> { return this.done; }

  private signal(signal: NodeJS.Signals): void {
    if (!this.process.pid || this.ended) return;
    try { process.kill(-this.process.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  /** Waits up to `ms` for the process to end; whether it did. */
  async exited(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    if (timer) clearTimeout(timer);
    return this.ended;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.process.stdin.end();
    if (!(await this.exited(500))) { this.signal("SIGTERM"); await this.exited(500); }
    if (!this.ended) { this.signal("SIGKILL"); await this.exited(500); }
  }

  kill(): void { this.stopping = true; this.signal("SIGKILL"); }
}
