import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

test("ACP implementation is independent of individual agents", async () => {
  const dir = join(process.cwd(), "host/providers/acp");
  for (const entry of await readdir(dir)) assert.doesNotMatch(await readFile(join(dir, entry), "utf8"), /gjc/i, entry);
});
