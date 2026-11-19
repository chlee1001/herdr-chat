import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join, normalize, resolve } from "node:path";
import { parseEnv } from "node:util";

const ID = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export function sessionIdOf(ref: string): string | null { return ID.exec(basename(ref))?.[1] ?? null; }

export function sessionsDirectory(cwd: string, env: NodeJS.ProcessEnv): { path: string; rule: string } {
  let project: NodeJS.Dict<string> = {};
  try { project = parseEnv(readFileSync(join(cwd, ".env"), "utf8")); } catch {}
  const trusted = (key: string): string | undefined => {
    const value = env[key];
    const declared = project[key];
    return !value || (declared !== undefined && (declared === value || /[$`]/.test(declared))) ? undefined : value;
  };
  const home = trusted("HOME") ?? (project.HOME !== undefined ? userInfo().homedir : homedir());
  const safeConfig = (s: string | undefined) => s && !normalize(s.trim()).split(/[\\/]/).includes("..") ? s.trim() : undefined;
  const config = safeConfig(trusted("GJC_CONFIG_DIR")) ?? safeConfig(trusted("PI_CONFIG_DIR")) ?? ".gjc";
  const defaultDir = join(home, config, "agent");
  const override = trusted("GJC_CODING_AGENT_DIR") ?? trusted("PI_CODING_AGENT_DIR");
  const agent = override ? resolve(cwd, override) : defaultDir;
  const xdg = trusted("XDG_DATA_HOME");
  if (resolve(agent) === resolve(defaultDir) && xdg && existsSync(join(xdg, "gjc"))) return { path: join(xdg, "gjc", "sessions"), rule: "XDG data" };
  return { path: join(agent, "sessions"), rule: override ? "environment" : "default" };
}

function real(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
export function findSession(dir: string, id: string, cwd: string): { file: string | null; ambiguous: boolean; alternatives: string[] } {
  const candidates: { path: string; cwd: string | null; mtime: number }[] = [];
  let scopes: string[];
  try { scopes = readdirSync(dir); } catch { return { file: null, ambiguous: false, alternatives: [] }; }
  for (const scope of scopes) {
    const folder = join(dir, scope);
    let files: string[];
    try { files = readdirSync(folder); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith(`_${id}.jsonl`)) continue;
      const path = join(folder, name);
      try {
        const header = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]!);
        if (header.id === id) candidates.push({ path, cwd: typeof header.cwd === "string" ? header.cwd : null, mtime: statSync(path).mtimeMs });
      } catch {}
    }
  }
  if (candidates.length === 1) return { file: candidates[0]!.path, ambiguous: false, alternatives: [] };
  const matches = candidates.filter((c) => c.cwd && real(c.cwd) === real(cwd)).sort((a, b) => b.mtime - a.mtime);
  return { file: matches[0]?.path ?? null, ambiguous: candidates.length > 1 && !matches.length, alternatives: matches.slice(1).map((c) => c.path) };
}
