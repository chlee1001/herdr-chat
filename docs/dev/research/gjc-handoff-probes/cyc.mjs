import { spawn, spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "../../../../node_modules/@agentclientprotocol/sdk/dist/acp.js";
const cwd = process.argv[2], sid = process.argv[3], rounds = +process.argv[4];
const sh = (a) => spawnSync(a[0], a.slice(1), { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function acp(prompt) {
  const child = spawn("gjc", ["--mode", "acp"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
  const client = { async requestPermission(p) { return { outcome: { outcome: "selected", optionId: p.options[0].optionId } }; }, async sessionUpdate() {} };
  const conn = new ClientSideConnection(() => client, ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  await conn.initialize({ protocolVersion: 1, clientCapabilities: { _meta: { gjc: { permissionHandling: "prompt" } } } });
  const t0 = Date.now();
  try { await conn.loadSession({ sessionId: sid, cwd, mcpServers: [] }); console.log("  load ok", Date.now() - t0); }
  catch (e) { console.log("  LOAD FAIL", Date.now() - t0, String(e).slice(0, 110)); child.kill(); return false; }
  if (prompt) { await conn.prompt({ sessionId: sid, prompt: [{ type: "text", text: prompt }] }); console.log("  prompt done"); }
  try { await conn.closeSession({ sessionId: sid }); } catch {}
  child.kill(); return true;
}
for (let i = 1; i <= rounds; i++) {
  console.log("round", i);
  if (!(await acp(`Reply with the single word chat${i}.`))) break;
  const name = `cy${i}`;
  sh(["hc", "run", "--bg", "--json", "--no-parent", "--name", name, "--cwd", cwd, "--", "env", `PATH=${process.env.PATH}`, "gjc", "--resume", sid]);
  await sleep(6000);
  sh(["hc", "send", name, `Reply with the single word tui${i}.`]);
  await sleep(9000);
  sh(["hc", "keys", name, "ctrl+c"]); await sleep(300); sh(["hc", "keys", name, "ctrl+c"]);
  for (let k = 0; k < 40; k++) { if (JSON.parse(sh(["hc", "get", name, "--json"]).stdout).state !== "live") break; await sleep(250); }
  console.log("  tui ended");
  sh(["hc", "rm", name]);
}
process.exit(0);
