// Loaded before every test file (bunfig.toml). Tests must never touch a real instance's data:
// point DATA_DIR at a fresh temp dir unless the test run already chose one under the system temp dir.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : "";
if (!dir || !dir.startsWith(resolve(tmpdir()))) process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "grimoire-test-"));
process.env.STORAGE = "local";
