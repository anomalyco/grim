// CODE_STORAGE_REPO_PREFIX: every repo id the Code Storage store sends (the JWT's `repo` claim) carries the prefix, so a
// deployment sharing production's org (staging: "stg-") never reads or writes production's repos.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { CodeStorageStore } from "../../src/server/store/codestorage.ts";

const PEM = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** The `repo` claim of each request's bearer JWT. */
const seen: string[] = [];
let fake: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  fake = Bun.serve({
    port: 0,
    fetch(req) {
      const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString() || "{}");
      if (claims.repo) seen.push(claims.repo);
      return Response.json({ message: "nope", code: "boom" }, { status: 500 });
    },
  });
});
afterAll(() => fake.stop(true));

async function idsSent(repoPrefix: string | undefined) {
  seen.length = 0;
  const store = new CodeStorageStore({ org: "o", key: PEM, apiBaseUrl: `http://localhost:${fake.port}`, storageBaseUrl: `localhost:${fake.port}`, repoPrefix });
  const calls: Array<() => Promise<unknown>> = [
    () => store.createRepo("notes", { branch: "main" }),
    () => store.head("notes", "main"),
    () => store.listFiles("notes", "abc"),
    () => store.readFile("notes", "a.md", "abc"),
    () => store.commit({ repo: "notes", branch: "main", expectedHead: null, changes: [{ path: "a.md", content: "x" }], message: "m", author: { name: "n", email: "e@x" } }),
    () => store.history("notes", "main", undefined, 5),
    () => store.deleteRepo("notes"),
  ];
  for (const call of calls) await call().catch(() => {});
  return [...new Set(seen)];
}

describe("Code Storage repo prefix", () => {
  test("every call names the prefixed repo", async () => {
    expect(await idsSent("stg-")).toEqual(["stg-notes"]);
  });

  test("no prefix: the workspace id as is", async () => {
    expect(await idsSent(undefined)).toEqual(["notes"]);
    expect(await idsSent("")).toEqual(["notes"]);
  });

});
