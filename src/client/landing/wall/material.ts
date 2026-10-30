// The look: a thick, matte, off-white wall drawn like an illustration. One key light from the top left, flat
// banded (cel) shading per face, ink lines on silhouettes and crack edges, soft drop shadows from anything lifted
// off the wall. Face-on and untouched, the wall is exactly the page's paper colour.

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const MATERIAL = {
  /** the wall's face: the page's paper */
  paper: rgb("#fcfcfb"),
  /** the broken inside of the wall: plate sides, the hole's rim */
  core: rgb("#d9d2c5"),
  /** behind the wall */
  dark: rgb("#0c0b0b"),
  /** ink: crack edges and silhouettes */
  ink: rgb("#272422"),
  /** the wall's thickness (px) */
  thickness: 38,
  /** toward the key light (normalised in use): from the top left, in front */
  light: [-0.42, -0.55, 0.72] as [number, number, number],
  /** the bands: a face at least `bands[i][0]` (the facing of the untouched wall is 1) gets brightness `bands[i][1]` */
  bands: [
    [0.94, 1],
    [0.72, 0.935],
    [0.45, 0.85],
    [0.15, 0.74],
    [-0.2, 0.63],
    [-9, 0.55],
  ] as [number, number][],
  /** the view is very slightly oblique: a point this far toward you (px) moves this much across the page (x, y per
   *  px). The wall's face stays exactly on the page; anything raised shows its lower right sides, and gaps and the
   *  hole show the wall's depth. */
  oblique: [-0.15, -0.23] as [number, number],
  /** the camera's distance from the wall (px): near-orthographic, so the wall is flat on the page but things that
   *  come toward you grow a little */
  distance: 2200,
  /** ink widths (CSS px): silhouettes of lifted pieces, cracks in the wall, the far edges of slabs */
  inkEdge: 1.5,
  inkCrack: 1.5,
  inkBack: 1.05,
  /** the dark gap either side of a crack's ink (px, alpha) */
  gap: 3.6,
  gapAlpha: 0.4,
  /** drop shadows: strength, the colour they multiply by, blur (px, at full resolution) */
  shadow: 0.5,
  shadowTint: rgb("#6a6156"),
  shadowBlur: 5,
  /** device pixel ratio caps */
  dprCap: 2,
  dprCapLow: 1.25,
};

/** The banded shading of a face colour by its normal (GLSL). */
export function celGlsl() {
  const L = MATERIAL.light;
  const l = Math.hypot(...L);
  const lv = L.map((x) => (x / l).toFixed(5)).join(", ");
  const rest = (L[2] / l).toFixed(5);
  const b = MATERIAL.bands;
  let chain = b[b.length - 1]![1].toFixed(3);
  for (let i = b.length - 2; i >= 0; i--) chain = `f >= ${b[i]![0].toFixed(3)} ? ${b[i]![1].toFixed(3)} : (${chain})`;
  return `
const vec3 LIGHT = vec3(${lv});
vec3 cel(vec3 base, vec3 n) {
  float f = dot(normalize(n), LIGHT) / ${rest};
  return base * (${chain});
}`;
}
