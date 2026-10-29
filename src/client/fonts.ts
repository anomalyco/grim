// Type faces: the platform font (San Francisco on Apple devices: -apple-system / BlinkMacSystemFont) where there is
// one, Inter (our woff2, app.css) everywhere else. app.css lists both in that order, so the browser picks; this only
// tells the page which one it got: `html.sysfont` drops the tracking tuned for Inter (SF tracks itself per size), and
// Inter is fetched (and awaited by the first load) only where it's the face, so Apple devices never download it.

/** San Francisco is the UI face (an Apple device): the system font stack resolves to a real face. */
export const systemFont: boolean = (() => {
  const c = typeof document === "undefined" ? null : document.createElement("canvas").getContext?.("2d");
  if (!c) return false;
  const width = (family: string) => ((c.font = `72px ${family}`), c.measureText("Grimoire mmwli 0123").width);
  return width("-apple-system, BlinkMacSystemFont, monospace") !== width("monospace");
})();

if (typeof document !== "undefined") document.documentElement.classList.toggle("sysfont", systemFont);

/** Inter's faces the page uses, loading (started at once: it replaces the HTML preload); none with the system font. */
export const uiFontsLoaded: Promise<unknown> =
  systemFont || typeof document === "undefined" || !document.fonts
    ? Promise.resolve()
    : Promise.all(["16px Inter", "italic 16px Inter", "bold 16px Inter"].map((f) => document.fonts.load(f))).catch(() => {});
