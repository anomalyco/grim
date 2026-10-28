// Scratch Grimoire server for the Mac app's QA run (qa_flows_against_a_server): like scratch.mjs, plus a fake
// Google (test/e2e/fake-google.mjs) so an account can be signed into again (name sign-in always makes a new
// one). The fake listens on every interface; its pages say 127.0.0.1, which the Mac's scripted browser
// rewrites to W3_HOST. DATA_DIR may be given to keep the data across a restart.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const web = "/root/projects/multiplayer-notepad";
const host = process.env.W3_HOST, port = Number(process.env.W3_PORT);
const { startFakeGoogle, fakeGoogleEnv } = await import(`${web}/test/e2e/fake-google.mjs`);
const fake = await startFakeGoogle();
fakeGoogleEnv(fake);
process.env.DATA_DIR ||= mkdtempSync(join(tmpdir(), "qa-scratch-"));
process.env.STORAGE = "local";
process.env.ALLOW_DEV_LOGIN = "1";
process.env.SIGNIN = "open";
process.env.ALLOWED_GITHUB_USERS = "*";
process.env.QUIET_MS = "1500";
process.env.PUBLIC_URL = `http://${host}:${port}`;
const { startServer } = await import(`${web}/src/server/index.ts`);
const app = await startServer({ port, hostname: host, quiet: true });
console.log("DATA_DIR", process.env.DATA_DIR);
console.log("GOOGLE", fake.origin);
console.log("READY", `http://${host}:${port}`, app.server.port);
