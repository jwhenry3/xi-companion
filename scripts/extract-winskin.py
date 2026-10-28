#!/usr/bin/env python3
"""extract-winskin.py — pull the client's window-skin textures out of the
menu DATs (ROM/0/2.DAT baseline, ROM/0/1.DAT for the fuller set).

The archives are streams of `menu    <8ch-name>` records. Texture-bearing
records embed a `xTXD` chunk: [xTXD][u32 size][u32 ?][texels] — DXT3 for
'3TXD', DXT1 for '1TXD'. Record w/h sit at +0x14/+0x18.

Writes PNG atlases to addon/xicompanion/themes/<dat>/<nn>_<name>.png so
the addon can serve them via /api/theme. Also dumps the small layout
records (frames/comwin/windowps piece rects) as JSON for slicing work.

Run from the repo root:  python scripts/extract-winskin.py
"""

import json
import os
import re
import struct
import sys

# WINSKIN_BASE overrides the install dir — point it at an extracted
# XI View / modpack tree to decode those skins instead of retail's
BASE = os.environ.get(
    "WINSKIN_BASE",
    r"C:/Program Files (x86)/PlayOnline/SquareEnix/FINAL FANTASY XI")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTD = os.path.join(ROOT, "icon_dump", "wintheme")
THEMES = os.path.join(ROOT, "addon", "xicompanion", "themes")

# WINSKIN_SRC overrides the default sources — "relpath:tag,relpath:tag"
_src = os.environ.get("WINSKIN_SRC")
SOURCES = (
    [(r.split(":", 1)[0], r.split(":", 1)[1]) for r in _src.split(",")]
    if _src else [
        (r"ROM/0/2.DAT", "base"),
        (r"ROM/0/1.DAT", "base_full"),
    ]
)

MENU_REC = re.compile(rb"menu    ")


def c16(v):
    return ((v >> 11 & 31) * 255 // 31,
            (v >> 5 & 63) * 255 // 63,
            (v & 31) * 255 // 31)


def dxt3(px, w, h):
    out = bytearray(w * h * 4)
    for by in range(h // 4):
        for bx in range(w // 4):
            blk = px[(by * (w // 4) + bx) * 16:(by * (w // 4) + bx) * 16 + 16]
            a = struct.unpack("<Q", blk[:8])[0]
            c0, c1 = struct.unpack_from("<HH", blk, 8)
            C = [c16(c0), c16(c1)]
            C.append(tuple((2 * C[0][i] + C[1][i]) // 3 for i in range(3)))
            C.append(tuple((C[0][i] + 2 * C[1][i]) // 3 for i in range(3)))
            ci = struct.unpack_from("<I", blk, 12)[0]
            for i in range(16):
                o = ((by * 4 + i // 4) * w + bx * 4 + i % 4) * 4
                r, g, b = C[(ci >> (2 * i)) & 3]
                out[o:o + 4] = bytes([r, g, b,
                                      min(255, ((a >> (4 * i)) & 0xF) * 17)])
    return bytes(out)


def dxt1(px, w, h):
    out = bytearray(w * h * 4)
    for by in range(h // 4):
        for bx in range(w // 4):
            blk = px[(by * (w // 4) + bx) * 8:(by * (w // 4) + bx) * 8 + 8]
            c0, c1 = struct.unpack_from("<HH", blk, 0)
            C = [c16(c0), c16(c1)]
            if c0 > c1:
                C.append(tuple((2 * C[0][i] + C[1][i]) // 3 for i in range(3)))
                C.append(tuple((C[0][i] + 2 * C[1][i]) // 3 for i in range(3)))
                alpha = (255,) * 4
            else:
                C.append(tuple((C[0][i] + C[1][i]) // 2 for i in range(3)))
                C.append((0, 0, 0))
                alpha = (255, 255, 255, 0)
            ci = struct.unpack_from("<I", blk, 4)[0]
            for i in range(16):
                o = ((by * 4 + i // 4) * w + bx * 4 + i % 4) * 4
                idx = (ci >> (2 * i)) & 3
                r, g, b = C[idx]
                out[o:o + 4] = bytes([r, g, b, alpha[idx]])
    return bytes(out)


def png(rgba, w, h, path):
    try:
        from PIL import Image
        Image.frombytes("RGBA", (w, h), rgba).save(path)
    except ImportError:
        # minimal PNG writer (zlib only)
        import zlib
        raw = b"".join(b"\x00" + rgba[y * w * 4:(y + 1) * w * 4]
                       for y in range(h))
        def chunk(tag, payload):
            return (struct.pack(">I", len(payload)) + tag + payload +
                    struct.pack(">I", zlib.crc32(tag + payload)))
        ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
        with open(path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
                    chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def records(d):
    offs = [m.start() for m in MENU_REC.finditer(d)] + [len(d)]
    for i in range(len(offs) - 1):
        seg = d[offs[i]:offs[i + 1]]
        if len(seg) < 17:
            continue
        yield seg[8:16].strip().decode("latin1", "replace"), seg[16:], offs[i]


def main():
    os.makedirs(OUTD, exist_ok=True)
    manifest = {}
    for rel, tag in SOURCES:
        path = os.path.join(BASE, rel)
        if not os.path.isfile(path):
            print("missing", path)
            continue
        d = open(path, "rb").read()
        dstdir = os.path.join(OUTD, tag)
        tdir = os.path.join(THEMES, tag)
        os.makedirs(dstdir, exist_ok=True)
        os.makedirs(tdir, exist_ok=True)
        entries, layout = [], []
        n = 0
        for name, p, off in records(d):
            t = re.search(rb"[0-9]TXD", p[:0x60])
            if t:
                # dims from the record header (+0x14/+0x18 rel record start)
                w, h = struct.unpack_from("<ii", p, 4)
                if not (4 <= w <= 4096 and 4 <= h <= 4096):
                    w, h = struct.unpack_from("<ii", p, 0x14)
                if not (4 <= w <= 4096 and 4 <= h <= 4096):
                    continue
                size = struct.unpack_from("<I", p, t.start() + 4)[0]
                px = p[t.start() + 12:t.start() + 12 + size]
                if not px:
                    continue
                rgba = (dxt3 if t.group() == b"3TXD" else dxt1)(px, w, h)
                fn = f"{n:03d}_{name}.png"
                png(rgba, w, h, os.path.join(tdir, fn))
                entries.append({"file": f"{tag}/{fn}", "name": name,
                                "w": w, "h": h, "fmt": t.group().decode()})
                n += 1
            elif len(p) <= 96 and name in ("frames", "comwin", "windowps",
                                           "buttont"):
                layout.append({"name": name, "off": off,
                               "raw": p.hex()})
        manifest[tag] = entries
        open(os.path.join(dstdir, "layout.json"), "w").write(
            json.dumps(layout, indent=1))
        print(tag, "textures:", len(entries), "layout recs:", len(layout))
    open(os.path.join(OUTD, "manifest.json"), "w").write(
        json.dumps(manifest, indent=1))


if __name__ == "__main__":
    sys.exit(main())
