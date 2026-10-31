// Launch metrics from the landing page (src/server/metrics.ts): what only the browser knows, a page view and a click,
// sent as a beacon with an event name (and, for a view, the referring site's host). No cookies, no ids.

const REF_KEY = "grim.ref";

/** Report `e` to /api/metrics/hit (the server accepts only its own list of event names). */
export function beacon(e: "landing_view" | "get_started_click" | "mac_download_click", r?: string | null) {
  try {
    navigator.sendBeacon?.("/api/metrics/hit", JSON.stringify(r ? { e, r } : { e }));
  } catch {
    // (metrics never get in the way)
  }
}

/** The site that sent this visitor here (its host), if another one; kept for this tab so a signup can name it too. */
export function externalReferrer(): string | null {
  let host: string | null = null;
  try {
    host = document.referrer ? new URL(document.referrer).hostname : null;
  } catch {
    host = null;
  }
  if (host && host !== location.hostname) {
    try {
      sessionStorage.setItem(REF_KEY, host);
    } catch {
      // storage off
    }
    return host;
  }
  return null;
}

/** The referring host this tab arrived from (externalReferrer), for the sign-in link: "&ref=…", or "". */
export function refParam(): string {
  try {
    const host = sessionStorage.getItem(REF_KEY);
    return host ? `&ref=${encodeURIComponent(host)}` : "";
  } catch {
    return "";
  }
}
