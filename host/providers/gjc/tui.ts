// A GJC TUI's session: the session file its process tree has open, else the
// newest session file of its folder written since it started.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { openFiles, processStart, processTree, type TuiQuery, type TuiSession } from "../tui.ts";
import { sessionIdOf, sessionsDirectory } from "./sessions.ts";

const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

/** The session file's header: its id and folder, or null when it isn't a GJC session file. */
function header(file: string): { id: string; cwd: string | null } | null {
  try {
    const h = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]!);
    return h.id && h.id === sessionIdOf(file) ? { id: h.id, cwd: typeof h.cwd === "string" ? h.cwd : null } : null;
  } catch {
    return null;
  }
}

export function gjcTuiSession(q: TuiQuery): TuiSession {
  const open = openFiles(processTree(q.pid)).find((f) => sessionIdOf(f) && header(f));
  if (open) return { session: open };
  const since = (processStart(q.pid) ?? Date.now() - 86_400_000) - 5000;
  const here = real(q.cwd);
  const root = sessionsDirectory(q.cwd, process.env).path;
  let best: { file: string; mtime: number } | null = null;
  let scopes: string[] = [];
  try { scopes = readdirSync(root); } catch {}
  for (const scope of scopes) {
    let names: string[];
    try { names = readdirSync(join(root, scope)); } catch { continue; }
    for (const name of names) {
      if (!sessionIdOf(name)) continue;
      const file = join(root, scope, name);
      let mtime: number;
      try { mtime = statSync(file).mtimeMs; } catch { continue; }
      if (mtime < since || (best && mtime <= best.mtime)) continue;
      const h = header(file);
      if (h?.cwd && real(h.cwd) === here) best = { file, mtime };
    }
  }
  if (!best) throw new Error("no GJC session in this folder since it started: send it a message first");
  return { session: best.file };
}
