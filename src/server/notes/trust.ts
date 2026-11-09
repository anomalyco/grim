// Bun/Node build of just-bash: run host code (Git, the database, rooms) outside the defense-in-depth sandbox.
// Workers use the browser build, which has no DefenseInDepthBox; wrangler aliases this file to trust.workers.ts.
import { DefenseInDepthBox } from "just-bash";

export function trusted<T>(fn: () => T): T {
  return DefenseInDepthBox.runTrusted(fn);
}
