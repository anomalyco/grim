"""Builds Grim's icons from the approved art (source-art.png: three jagged scratches on a dark tile).

The tile is redrawn as Apple's continuous-corner squircle on the macOS grid (824 px body centred on a 1024 canvas);
the scratches are taken from the art by colour, kept as drawn, centred and scaled to the new body.

    python3 -m venv /tmp/v && /tmp/v/bin/pip install pillow numpy
    /tmp/v/bin/python assets/icon/make-icons.py      # writes assets/icon/*.png and src/client/icons/*
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
WEB = HERE.parent.parent / "src" / "client" / "icons"
TILE = (0x12, 0x12, 0x12)
INK = (0xFE, 0xFA, 0xF3)
SS = 8  # supersampling for the squircle edge


def squircle_points(x0, y0, w, h, r, steps=64):
    """Apple's continuous-corner rounded rect (the UIBezierPath / macOS icon shape) as a polygon."""
    def cubic(p0, p1, p2, p3):
        t = np.linspace(0, 1, steps)[:, None]
        return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3

    # one corner (top right), in units of r, measured from the corner inward: (dx from right, dy from top)
    seg = [
        ((1.52866471, 0), (1.08849323, 0), (0.86840689, 0.02221360), (0.66993427, 0.06549600)),
        ((0.63149399, 0.07491100), (0.37282392, 0.16905899), (0.16905899, 0.37282392), (0.07491100, 0.63149399)),
        ((0.06549600, 0.66993427), (0.02221360, 0.86840689), (0, 1.08849323), (0, 1.52866471)),
    ]
    corner = np.concatenate([cubic(*[np.array(p, float) for p in s]) for s in seg]) * r
    pts = []
    x1, y1 = x0 + w, y0 + h
    for sx, sy, cx, cy, swap in [(-1, 1, x1, y0, False), (-1, -1, x1, y1, True), (1, -1, x0, y1, False), (1, 1, x0, y0, True)]:
        c = corner[::-1] if swap else corner
        pts += [(cx + sx * dx, cy + sy * dy) for dx, dy in c]
    return pts


def squircle_mask(size, body, radius_frac=0.2257):
    """Coverage (0..1 float) of the squircle body centred on a size×size canvas, anti-aliased by supersampling."""
    big = Image.new("L", (size * SS, size * SS), 0)
    off = (size - body) / 2 * SS
    ImageDraw.Draw(big).polygon(squircle_points(off, off, body * SS, body * SS, body * radius_frac * SS), fill=255)
    return np.asarray(big.reduce(SS), dtype=np.float64) / 255


def scratches_from_art():
    """The scratches' alpha (0..1), cropped to their bounds, and the art tile's mean side, from the source art."""
    a = np.asarray(Image.open(HERE / "source-art.png").convert("RGB"), dtype=np.float64)
    lum = a.mean(axis=2)
    dark = lum < 60
    ys, xs = np.where(dark)
    tile_side = ((xs.max() - xs.min() + 1) + (ys.max() - ys.min() + 1)) / 2
    # only inside the tile (away from its edge), off-white over the dark fill
    inside = np.zeros_like(dark)
    inside[ys.min() + 60 : ys.max() - 60, xs.min() + 60 : xs.max() - 60] = True
    alpha = np.clip((lum - 18) / (252 - 18), 0, 1) * inside
    ys, xs = np.where(alpha > 0.02)
    crop = alpha[ys.min() - 4 : ys.max() + 5, xs.min() - 4 : xs.max() + 5]
    return crop, tile_side


def scale_alpha(alpha, factor):
    h, w = alpha.shape
    img = Image.fromarray((alpha * 65535).astype(np.uint16).astype(np.int32), "I").convert("F")
    out = img.resize((max(1, round(w * factor)), max(1, round(h * factor))), Image.LANCZOS)
    return np.clip(np.asarray(out) / 65535, 0, 1)


def place(canvas_size, alpha):
    """alpha centred on a canvas."""
    out = np.zeros((canvas_size, canvas_size))
    h, w = alpha.shape
    y, x = (canvas_size - h) // 2, (canvas_size - w) // 2
    out[y : y + h, x : x + w] = alpha
    return out


def compose(scr, cover):
    """RGBA: the tile colour with the scratches over it, alpha = tile coverage. No halo: colour is set everywhere."""
    s = scr[..., None]
    rgb = np.array(TILE) * (1 - s) + np.array(INK) * s
    rgba = np.dstack([rgb, cover * 255])
    return Image.fromarray(np.round(rgba).astype(np.uint8), "RGBA")


def fit_strokes(crop):
    """The three scratches as straight centrelines: (offset across, start, end along), with the shared direction."""
    ys, xs = np.where(crop > 0.5)
    pts = np.stack([xs, ys], 1).astype(float)
    centre = pts.mean(0)
    d = pts - centre
    u = np.linalg.eigh(d.T @ d)[1][:, 1]
    u = u if u[0] > 0 else -u
    n = np.array([-u[1], u[0]])
    along, across = d @ u, d @ n
    order = np.sort(across)
    gaps = np.argsort(np.diff(order))[-2:]
    lab = np.digitize(across, np.sort([(order[i] + order[i + 1]) / 2 for i in gaps]))
    strokes = [(np.median(across[lab == k]), along[lab == k].min(), along[lab == k].max()) for k in range(3)]
    return strokes, centre - np.array(crop.shape[::-1]) / 2, u, n


def small_scratches(crop, tile_side, size, body, thickness, spread):
    """The scratches redrawn for 16/32 px: smooth tapered strokes on the same centrelines (bolder, not jagged), their
    spacing widened by `spread`, nudged up/down by a fraction of a pixel to where they land crispest."""
    strokes, base, u, n = fit_strokes(crop)
    k = body / tile_side

    def draw(dy, ss):
        img = Image.new("L", (size * ss, size * ss), 0)
        dr = ImageDraw.Draw(img)
        s = np.linspace(0, 1, 80)
        t = thickness * np.sin(np.pi * s ** 1.36) ** 0.9  # pointed ends, widest a little past the middle, like the art
        for across, a, b in strokes:
            al = a + (b - a) * s
            cx = size / 2 + (base[0] + u[0] * al + n[0] * across * spread) * k
            cy = size / 2 + dy + (base[1] + u[1] * al + n[1] * across * spread) * k
            side = lambda o: list(zip((cx + n[0] * o) * ss, (cy + n[1] * o) * ss))
            dr.polygon(side(t / 2) + side(-t / 2)[::-1], fill=255)
        return np.asarray(img.reduce(ss), dtype=np.float64) / 255

    dy = max(np.arange(-0.5, 0.5, 0.125), key=lambda dy: ((draw(dy, 8) - 0.5) ** 2).sum())
    return draw(dy, 16)


def small_icon(crop, tile_side, size, body, thickness, spread):
    cover = np.asarray(Image.fromarray(np.round(squircle_mask(size * 8, round(body * 8)) * 255).astype(np.uint8)).reduce(8), dtype=np.float64) / 255
    return compose(small_scratches(crop, tile_side, size, body, thickness, spread), cover)


def shadowed(icon):
    """Apple's template drop shadow, kept light: black 25%, 10 px down, 10 px blur (at 1024)."""
    a = icon.getchannel("A")
    sh = Image.new("RGBA", icon.size, (0, 0, 0, 0))
    sh.putalpha(a.point(lambda v: v * 0.25).filter(ImageFilter.GaussianBlur(10)).transform(icon.size, Image.AFFINE, (1, 0, 0, 0, 1, -10)))
    return Image.alpha_composite(sh, icon)


def down(img, size):
    return img.resize((size, size), Image.LANCZOS)


def main():
    crop, tile_side = scratches_from_art()
    N, BODY = 1024, 824
    scr = place(N, scale_alpha(crop, BODY / tile_side))
    cover = squircle_mask(N, BODY)
    master = compose(scr, cover)
    master.save(HERE / "grim-icon-1024.png", optimize=True)
    shadowed(master).save(HERE / "grim-icon-mac-1024.png", optimize=True)

    full = np.ones((N, N))
    # apple-touch: iOS rounds the square itself, so the scratches keep their proportion to the whole tile
    bleed = compose(place(N, scale_alpha(crop, N / tile_side)), full).convert("RGB")
    bleed.save(HERE / "grim-icon-fullbleed-1024.png", optimize=True)
    # maskable: the scratches at the master's size, well inside the 80% safe circle
    maskable = compose(scr, full).convert("RGB")
    maskable.save(HERE / "grim-icon-maskable-1024.png", optimize=True)

    # 16/32 px: too small for the art's thin jagged strokes, so redrawn bolder and smooth (small_scratches).
    # On the macOS grid for the app; filling the square for the favicons.
    small, fav = {}, {}
    for px, thickness, spread in [(16, 1.3, 1.25), (32, 2.4, 1.1)]:
        small[px] = small_icon(crop, tile_side, px, px * BODY / N, thickness, spread)
        small[px].save(HERE / f"grim-icon-{px}.png", optimize=True)
        fav[px] = small_icon(crop, tile_side, px, px, thickness * N / BODY, spread)
    fav48 = master.crop(((N - BODY) // 2,) * 2 + ((N + BODY) // 2,) * 2).resize((48, 48), Image.LANCZOS)

    WEB.mkdir(parents=True, exist_ok=True)
    fav[16].save(WEB / "favicon-16.png", optimize=True)
    fav[32].save(WEB / "favicon-32.png", optimize=True)
    fav48.save(WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=[fav[16], fav[32]])
    down(bleed, 180).save(WEB / "apple-touch-icon.png", optimize=True)
    down(master, 192).save(WEB / "icon-192.png", optimize=True)
    down(master, 512).save(WEB / "icon-512.png", optimize=True)
    down(maskable, 512).save(WEB / "icon-maskable-512.png", optimize=True)
    (WEB / "site.webmanifest").write_text(json.dumps({
        "name": "Grim", "short_name": "Grim", "start_url": "/app", "display": "standalone",
        "background_color": "#121212", "theme_color": "#121212",
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
