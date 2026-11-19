import type { AdapterOptions } from "../types.ts";
import { AcpAdapter } from "./adapter.ts";

export type AcpAgentSpec = {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Arguments containing {session} receive the session reference. */
  tui?: string[];
  clientMeta?: Record<string, unknown>;
  minimumVersion?: string;
};

export function createAcpAgent(spec: AcpAgentSpec, opts: Omit<AdapterOptions, "command"> & { command?: string }): AcpAdapter {
  return new AcpAdapter(spec, { ...opts, command: opts.command ?? spec.command });
}
