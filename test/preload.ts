// Loaded before every test file (bunfig.toml). Tests must never touch a real instance's data: every test process
// gets one fresh DATA_DIR under the system temp dir (unless the run already chose one there), removed on exit.
// Test files put everything they create under it and never point config at another directory.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const tmp = resolve(tmpdir());
const given = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : "";
if (!given.startsWith(tmp + sep)) {
  const dir = mkdtempSync(join(tmp, "grimoire-test-"));
  process.env.DATA_DIR = dir;
  // A preload's afterAll runs once, after every test file.
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
}
process.env.STORAGE = "local";
