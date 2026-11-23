import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "../../../../node_modules/@agentclientprotocol/sdk/dist/acp.js";
const cwd = process.argv[2], mode = process.argv[3], sid = process.argv[4];
const child = spawn("gjc", ["--mode", "acp"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
const client = { async requestPermission(p) { return { outcome: { outcome: "selected", optionId: p.options[0].optionId } }; }, async sessionUpdate() {} };
const conn = new ClientSideConnection(() => client, ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
await conn.initialize({ protocolVersion: 1, clientCapabilities: { _meta: { gjc: { permissionHandling: "prompt" } } } });
if (mode === "new") {
  const s = await conn.newSession({ cwd, mcpServers: [] });
  await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "Reply with the single word ok." }] });
  console.log("SID", s.sessionId);
} else {
  const t0 = Date.now();
  try { const r = await conn.loadSession({ sessionId: sid, cwd, mcpServers: [] }); console.log("LOAD ok", Date.now() - t0, "ms"); }
  catch (e) { console.log("LOAD fail", Date.now() - t0, "ms", String(e).slice(0, 160)); }
}
child.kill(); process.exit(0);
