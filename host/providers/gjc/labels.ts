// The chat's terminal carries the GJC session it shows as `gjc.*` labels, the
// ones GJC's own herdr-bridge sets for a TUI, so herdr-gajae lists the chat
// beside its other GJC terminals. They are set once the session and its file
// are known, set again when its name changes, and cleared when the chat lets go
// of it (a hand-off to the TUI, a session switch, shutdown).
import { execFile } from "node:child_process";

export type GjcLabel = { session: string; cwd: string; file: string; title: string };
const KEYS = ["session", "cwd", "file", "title"] as const;
const CLEARED = JSON.stringify({ session: "", cwd: "", file: "", title: "" });

export class GjcLabels {
  private shown = CLEARED;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();

  /** `hc` and `terminal` come from HERDR_CHAT_HC and HC_TERMINAL_ID; without a terminal there is nothing to label. */
  private hc: string;
  private terminal: string | null;
  private log: (msg: string) => void;
  constructor(hc: string, terminal: string | null, log: (msg: string) => void) { this.hc = hc; this.terminal = terminal; this.log = log; }

  /** After the final clear nothing more is sent: a late update from a closing agent must not label the terminal again. */
  close(): Promise<void> {
    const cleared = this.set(null);
    this.closed = true;
    return cleared;
  }

  /** Labels the terminal with `label`, or clears the labels for null. A value already shown is not sent again. */
  set(label: GjcLabel | null): Promise<void> {
    const values = label ?? { session: "", cwd: "", file: "", title: "" };
    const key = JSON.stringify(values);
    if (!this.terminal || this.closed || key === this.shown) return this.chain;
    this.shown = key;
    const terminal = this.terminal;
    this.chain = this.chain.then(() => new Promise<void>((resolve) => {
      execFile(this.hc, ["label", terminal, ...KEYS.map((k) => `gjc.${k}=${values[k]}`)], { timeout: 5000 }, (error, _out, stderr) => {
        if (error) this.log(`hc label ${terminal}: ${(stderr || error.message).trim()}`);
        resolve();
      });
    }));
    return this.chain;
  }
}
