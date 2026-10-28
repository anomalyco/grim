import { createHash } from "node:crypto";

export function newId(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return prefix + Buffer.from(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
