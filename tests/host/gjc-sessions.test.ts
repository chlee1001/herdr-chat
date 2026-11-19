import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findSession, sessionIdOf, sessionsDirectory } from "../../host/providers/gjc/sessions.ts";

test("session directory follows overrides, XDG eligibility and project dotenv provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "gjc-dirs-"));
  try {
    const home = join(root, "home"), cwd = join(root, "cwd"), xdg = join(root, "xdg");
    mkdirSync(home); mkdirSync(cwd); mkdirSync(join(xdg, "gjc"), { recursive: true });
    const env = { HOME: home };
    assert.equal(sessionsDirectory(cwd, env).path, join(home, ".gjc/agent/sessions"));
    assert.equal(sessionsDirectory(cwd, { ...env, GJC_CONFIG_DIR: ".custom" }).path, join(home, ".custom/agent/sessions"));
    assert.equal(sessionsDirectory(cwd, { ...env, PI_CONFIG_DIR: ".legacy" }).path, join(home, ".legacy/agent/sessions"));
    assert.equal(sessionsDirectory(cwd, { ...env, GJC_CODING_AGENT_DIR: join(root, "custom"), XDG_DATA_HOME: xdg }).path, join(root, "custom/sessions"));
    assert.equal(sessionsDirectory(cwd, { ...env, PI_CODING_AGENT_DIR: join(root, "legacy") }).path, join(root, "legacy/sessions"));
    assert.equal(sessionsDirectory(cwd, { ...env, XDG_DATA_HOME: xdg }).path, join(xdg, "gjc/sessions"));
    assert.equal(sessionsDirectory(cwd, { ...env, GJC_CODING_AGENT_DIR: join(home, ".gjc/agent"), XDG_DATA_HOME: xdg }).path, join(xdg, "gjc/sessions"));
    assert.equal(sessionsDirectory(cwd, { ...env, XDG_DATA_HOME: join(root, "missing") }).path, join(home, ".gjc/agent/sessions"));
    writeFileSync(join(cwd, ".env"), "GJC_CODING_AGENT_DIR=/untrusted\n");
    assert.equal(sessionsDirectory(cwd, { ...env, GJC_CODING_AGENT_DIR: "/untrusted" }).path, join(home, ".gjc/agent/sessions"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session discovery validates header, cwd and mtime", () => {
  const root = mkdtempSync(join(tmpdir(), "gjc-files-"));
  try {
    const id = "3df26b19-e3f7-4c86-8727-1ac031609a4a", cwd = join(root, "cwd");
    mkdirSync(cwd);
    const create = (scope: string, header: object) => { const dir = join(root, scope); mkdirSync(dir); const path = join(dir, `2026_${id}.jsonl`); writeFileSync(path, JSON.stringify(header) + "\n"); return path; };
    const a = create("a", { id, cwd }), b = create("b", { id, cwd }), c = create("c", { id, cwd: "/elsewhere" });
    utimesSync(a, 1, 1); utimesSync(b, 2, 2);
    assert.equal(sessionIdOf(a), id);
    assert.equal(sessionIdOf(join(root, "missing_" + id + ".jsonl")), id);
    assert.equal(findSession(root, id, cwd).file, b);
    assert.deepEqual(findSession(root, id, cwd).alternatives, [a]);
    assert.equal(findSession(root, id, "/unmatched").ambiguous, true);
    writeFileSync(b, JSON.stringify({ id: "wrong", cwd }));
    assert.equal(findSession(root, id, cwd).file, a);
    assert.ok(c);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
