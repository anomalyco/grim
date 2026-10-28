#!/usr/bin/env python3
"""Pixel checks on snapshots (no dependencies): `pixel.py same FILE X Y1 Y2 [Y3…]` fails unless the pixels at
(X, Y1), (X, Y2)… (device pixels) are the same colour; `pixel.py at FILE X Y` prints one; `pixel.py pill FILE Y X0 X1
R G B` fails if, on row Y between X0 and X1, the background (R, G, B) shows between two runs of another colour's
pill: one pill, no gaps (glyphs inside it are fine)."""
import struct, sys, zlib


def load(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", path
    pos, idat, w, h, ct, bd = 8, b"", 0, 0, 0, 0
    while pos < len(data):
        n = struct.unpack(">I", data[pos:pos + 4])[0]
        t, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + n]
        if t == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", body[:10])
        elif t == b"IDAT":
            idat += body
        pos += 12 + n
    assert bd == 8 and ct in (2, 6), "8-bit RGB(A) only"
    bpp = 4 if ct == 6 else 3
    raw, stride = zlib.decompress(idat), w * bpp
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    return lambda x, y: tuple(rows[y][x * bpp:x * bpp + 3])


def pill(path, y, x0, x1, paper):
    px = load(path)
    row = [px(x, y) for x in range(x0, x1)]
    inside = [i for i, c in enumerate(row) if c != paper]
    if not inside:
        sys.exit(f"{path}: no pill on row {y} between x={x0} and {x1}")
    gaps = [x0 + i for i in range(inside[0], inside[-1]) if row[i] == paper]
    if gaps:
        sys.exit(f"{path}: the pill on row {y} has gaps at x={gaps[:8]}")
    print(f"{path}: one pill on row {y}: x={x0 + inside[0]}..{x0 + inside[-1]}")


if __name__ == "__main__":
    if sys.argv[1] == "pill":
        a = sys.argv[2:]
        pill(a[0], int(a[1]), int(a[2]), int(a[3]), tuple(int(v) for v in a[4:7]))
        sys.exit(0)
    cmd, path, x, ys = sys.argv[1], sys.argv[2], int(sys.argv[3]), [int(v) for v in sys.argv[4:]]
    px = load(path)
    got = [px(x, y) for y in ys]
    if cmd == "at":
        print(got[0])
    elif len(set(got)) != 1:
        sys.exit(f"{path}: not one colour at x={x}: " + ", ".join(f"y={y} {c}" for y, c in zip(ys, got)))
    else:
        print(f"{path}: x={x} y={ys}: {got[0]}")
