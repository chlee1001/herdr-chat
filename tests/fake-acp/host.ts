import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const previous = process.env.HERDR_CHAT_TEST_HOST;
process.env.HERDR_CHAT_TEST_HOST = join(dirname(fileURLToPath(import.meta.url)), "entry.ts");
const { Host } = await import("../host/harness.ts");
if (previous === undefined) delete process.env.HERDR_CHAT_TEST_HOST; else process.env.HERDR_CHAT_TEST_HOST = previous;

export class AcpHost extends Host {
  get acpLog(): string { return join(this.dir, "acp.jsonl"); }
  messages(): any[] { return existsSync(this.acpLog) ? readFileSync(this.acpLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; }
}
export async function acpHost(opts: { name: string; scenario?: object; dir?: string; cwd?: string; session?: string }): Promise<AcpHost> {
  const host = new AcpHost({ name: opts.name, provider: "fake-acp", agent: process.execPath, ...(opts.dir ? { dir: opts.dir } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.session ? { session: opts.session } : {}) });
  const env: Record<string, string> = { FAKE_ACP_LOG: host.acpLog, FAKE_ACP_STORE: join(host.dir, "store.json") };
  if (opts.scenario) {
    const path = join(host.dir, "scenario.json");
    writeFileSync(path, JSON.stringify(opts.scenario));
    env.FAKE_ACP_SCENARIO = path;
  }
  host.opts.env = env;
  await host.start();
  return host;
}
