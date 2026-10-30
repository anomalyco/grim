// Link previews (X, LinkedIn, Facebook, Slack, Discord, iMessage, WhatsApp, Bluesky): the title, description and
// Open Graph / Twitter Card tags of the app's HTML, which unfurlers read without running the page's JavaScript.
// index.html carries the landing page's block between <!--share-meta--> and <!--/share-meta--> for grimnotes.app;
// both servers (Bun: assets.ts; Workers: workers/router.ts) replace it per path with the server's own PUBLIC_URL, so a
// self-hosted Grim's previews point at its own /og/ images. The images: src/client/og/ (scripts/make-og.ts).
// Workspace pages get the generic card only: no workspace name, note title or URL in the tags.

/** The images in src/client/og/, served at /og/<name>. */
export const OG_DIR = "src/client/og";
export const OG_IMAGES = ["og-image.png", "twitter-card.png", "og-square.png", "og-demo.png"];

const DESCRIPTION =
  "Grim is a collection of notes shared between you, your agents, and your team. Agents write Markdown in a shared filesystem; you edit it in a live editor; everything is tracked in git.";
const DEMO_DESCRIPTION = "Try Grim in your browser, no sign-in: a notepad for people and agents that anyone in the demo can edit, live.";
const ALT = "Grim: a place to think with your agents. A note being edited live, with an agent's cursor.";

const START = "<!--share-meta-->";
const END = "<!--/share-meta-->";

type Card = { title: string; description: string; url?: string; image: string; width: number; height: number; alt: string; square?: boolean; twitter: string };

const DEMO_PATH = /^\/app\/demo(?:\.[^/]*)?(?:\/|$)/;

function card(path: string): Card {
  const main = { image: "og-image.png", width: 1200, height: 630, alt: ALT, twitter: "twitter-card.png" };
  if (path === "/") return { title: "Grim — A place to think with your agents", description: DESCRIPTION, url: "/", square: true, ...main };
  if (DEMO_PATH.test(path))
    return { title: "Grim — live demo", description: DEMO_DESCRIPTION, url: "/app/demo", image: "og-demo.png", width: 1200, height: 630, alt: "Try the live demo of Grim: the demo's welcome note open in the app.", twitter: "og-demo.png" };
  return { title: "Grim", description: DESCRIPTION, square: true, ...main };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The tags for `path` (a URL path) on the server at `origin` (its PUBLIC_URL, no trailing slash). */
export function shareMeta(origin: string, path: string): string {
  const c = card(path);
  const o = origin.replace(/\/$/, "");
  const tags: string[] = [`<title>${esc(c.title)}</title>`];
  const meta = (attr: "name" | "property", key: string, value: string | number) => tags.push(`<meta ${attr}="${key}" content="${esc(String(value))}" />`);
  meta("name", "description", c.description);
  if (c.url) tags.push(`<link rel="canonical" href="${esc(o + c.url)}" />`);
  meta("property", "og:type", "website");
  meta("property", "og:site_name", "Grim");
  meta("property", "og:title", c.title);
  meta("property", "og:description", c.description);
  if (c.url) meta("property", "og:url", o + c.url);
  meta("property", "og:image", `${o}/og/${c.image}`);
  meta("property", "og:image:type", "image/png");
  meta("property", "og:image:width", c.width);
  meta("property", "og:image:height", c.height);
  meta("property", "og:image:alt", c.alt);
  if (c.square) {
    meta("property", "og:image", `${o}/og/og-square.png`);
    meta("property", "og:image:type", "image/png");
    meta("property", "og:image:width", 1200);
    meta("property", "og:image:height", 1200);
    meta("property", "og:image:alt", "Grim: a place to think with your agents");
  }
  meta("name", "twitter:card", "summary_large_image");
  meta("name", "twitter:title", c.title);
  meta("name", "twitter:description", c.description);
  meta("name", "twitter:image", `${o}/og/${c.twitter}`);
  meta("name", "twitter:image:alt", c.alt);
  return tags.join("\n    ");
}

/** The app's HTML with its share block made for `path` on `origin` (unchanged without the markers). */
export function withShareMeta(html: string, origin: string, path: string): string {
  const a = html.indexOf(START);
  const b = html.indexOf(END, a);
  if (a < 0 || b < 0) return html;
  return html.slice(0, a + START.length) + "\n    " + shareMeta(origin, path) + "\n    " + html.slice(b);
}

/**
 * Link-preview fetchers by User-Agent: they get the app's HTML (and so these tags) on note URLs, which otherwise answer
 * Markdown to anything that doesn't ask for HTML (note-url.ts). iMessage fetches as facebookexternalhit/Twitterbot.
 */
const UNFURLERS = /facebookexternalhit|facebot|twitterbot|slackbot|linkedinbot|discordbot|whatsapp|telegrambot|skypeuripreview|bluesky|cardyb|redditbot|embedly|pinterest|vkshare|applebot|mastodon|iframely|google-pagerenderer/i;

export function isUnfurler(req: Request): boolean {
  return UNFURLERS.test(req.headers.get("user-agent") ?? "");
}
