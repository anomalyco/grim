// Grim's mark: the app icon's three jagged scratches (assets/icon/source-art.png), traced from the art by colour
// and simplified to stay crisp at header size. Drawn in `currentColor`, so it's always the same ink as the text
// beside it (the landing page's header: home.ts).

import { PATH, VIEW } from "../../shared/mark.ts";

export { PATH, VIEW };

/** The mark as an inline SVG, `height` px tall (its width follows), filled with the current text colour. */
export function markSvg(height: number, className = ""): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", VIEW);
  svg.setAttribute("height", String(height));
  svg.setAttribute("width", String(Math.round((height * 628) / 366 * 10) / 10));
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", PATH);
  svg.append(p);
  return svg;
}
