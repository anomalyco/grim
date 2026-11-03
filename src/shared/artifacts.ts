// Web artifacts: HTML pages and their files (CSS, JS, images, JSON, fonts, media) that agents put under `artifacts/`
// at a workspace's root, committed like notes and images. Only Grim for Mac shows them, in its side panel (its own
// grim-artifact: scheme per workspace); the server hands them only to token-authenticated app clients, as downloads
// (attachment, octet-stream, nosniff), so no browser ever renders one on the site's origin. Markdown under
// `artifacts/` is still a note.

/** The reserved folder at the workspace root. */
export const ARTIFACTS_DIR = "artifacts";
/** Largest artifact file. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
/** All artifact files of a workspace together. */
export const MAX_ARTIFACTS_TOTAL_BYTES = 50 * 1024 * 1024;
/** Artifact files in a workspace. */
export const MAX_ARTIFACT_FILES = 2000;

/** What may be stored there, by extension, with the type the Mac app serves it as. */
export const ARTIFACT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  wasm: "application/wasm",
};

const ext = (p: string) => /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase() ?? "";
const isMd = (p: string) => /\.(md|markdown|mdx)$/i.test(p);

/** Whether a clean repo-relative path is under `artifacts/` (any file, Markdown aside). */
export const underArtifacts = (p: string) => p.startsWith(`${ARTIFACTS_DIR}/`) && !isMd(p);

/** Whether a clean repo-relative path is an artifact file that may be stored (allowed extension). */
export const isArtifactPath = (p: string) => underArtifacts(p) && ext(p) in ARTIFACT_TYPES && !p.split("/").some((s) => s.startsWith("."));

/** The content type an artifact is served as in the Mac app (null: not an artifact type). */
export const artifactType = (p: string): string | null => ARTIFACT_TYPES[ext(p)] ?? null;

/** Why `path` can't be an artifact (null: it can): the hint agents get. */
export function artifactPathProblem(p: string): string | null {
  if (!underArtifacts(p)) return `artifacts go under ${ARTIFACTS_DIR}/`;
  if (p.split("/").some((s) => s.startsWith("."))) return "artifact names can't start with a dot";
  if (!(ext(p) in ARTIFACT_TYPES)) return `${ARTIFACTS_DIR}/ takes web files only (${Object.keys(ARTIFACT_TYPES).join(", ")})`;
  return null;
}

/** Executables and scripts for an OS (PE, ELF, Mach-O, fat binaries, `#!` scripts) are refused whatever their name. */
export function looksExecutable(b: Uint8Array): boolean {
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return true; // MZ (PE)
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return true; // #!
  if (b.length < 4) return false;
  const be = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  if (be === 0x7f454c46) return true; // ELF
  // Mach-O 32/64 either endianness, fat (0xcafebabe is also a Java class: refused alike)
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(be);
}
