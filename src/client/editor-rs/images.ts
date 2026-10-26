// Image sources: which URLs an image may load from. Pure, no DOM.
// http(s) and data:image URLs load directly; anything else with a scheme (javascript:, file:, ...) never loads.
// Relative paths are files in the note's repo: resolved against the note's folder and handed to a resolver.

/** Maps an image's raw source (as written in the Markdown) to a URL to load, or null to show the placeholder. */
export type ImageResolver = (src: string) => string | null;

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;
const SCHEME = /^[a-z][\w+.-]*:/i;

/** The source as written, without surrounding spaces or <angle brackets>. */
export function cleanSrc(raw: string): string {
  const s = raw.trim();
  return s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1).trim() : s;
}

/**
 * A URL that loads as is: http(s) (or protocol-relative, as https) and data:image URLs. Returns null for other
 * schemes and undefined for relative paths.
 */
export function directImageUrl(raw: string): string | null | undefined {
  const src = cleanSrc(raw);
  if (!src || /[\x00-\x1f\x7f]/.test(src)) return null;
  if (/^data:/i.test(src)) return DATA_IMAGE.test(src) ? src : null;
  const abs = src.startsWith("//") ? "https:" + src : SCHEME.test(src) ? src : null;
  if (abs === null) return undefined;
  try {
    const u = new URL(abs);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * A relative source as a path in the repo: relative to the note's folder, or to the repo root when it starts
 * with "/". Query and fragment are dropped and %-escapes decoded. Null if it leaves the repo.
 */
export function repoImagePath(raw: string, notePath: string): string | null {
  let src = cleanSrc(raw).replace(/[?#].*$/, "");
  try {
    src = decodeURIComponent(src);
  } catch {
    // keep it as written
  }
  if (!src || /[\x00-\x1f\x7f\\]/.test(src)) return null;
  const parts = src.startsWith("/") ? [] : notePath.split("/").slice(0, -1);
  for (const seg of src.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

/** Only direct URLs load (no repo to resolve relative paths against). */
export const directImages: ImageResolver = (src) => directImageUrl(src) ?? null;

/** Direct URLs as is; relative paths resolved against `notePath` and turned into a URL by `toUrl`. */
export function repoImages(notePath: string, toUrl: (path: string) => string): ImageResolver {
  return (src) => {
    const direct = directImageUrl(src);
    if (direct !== undefined) return direct;
    const path = repoImagePath(src, notePath);
    return path === null ? null : toUrl(path);
  };
}
