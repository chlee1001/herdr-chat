// Test-only host entry: inject a provider before loading the normal CLI.
import { PROVIDERS } from "../../host/providers/index.ts";
import { createAcpAgent } from "../../host/providers/acp/spec.ts";
import { fileURLToPath } from "node:url";

PROVIDERS["fake-acp"] = {
  command: process.execPath,
  create: (opts) => createAcpAgent({ id: "fake-acp", name: "Fake ACP", command: opts.command, args: [fileURLToPath(new URL("./fake-acp.mjs", import.meta.url))], env: {} }, opts),
  tuiSession: () => { throw new Error("Fake ACP has no TUI"); },
};
await import("../../host/main.ts");
