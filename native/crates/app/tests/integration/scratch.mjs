// Scratch Grimoire server for W3's Mac integration test, on this box's Tailscale address.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const host = process.env.W3_HOST, port = Number(process.env.W3_PORT);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "w3-scratch-"));
process.env.STORAGE = "local";
process.env.ALLOW_DEV_LOGIN = "1";
process.env.SIGNIN = "open";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.QUIET_MS = "1500";
process.env.PUBLIC_URL = `http://${host}:${port}`;
const { startServer } = await import("/root/projects/multiplayer-notepad/src/server/index.ts");
const app = await startServer({ port, hostname: host, quiet: true });
console.log("DATA_DIR", process.env.DATA_DIR);
console.log("READY", `http://${host}:${port}`, app.server.port);
