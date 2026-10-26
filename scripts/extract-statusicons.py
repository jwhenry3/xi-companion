#!/usr/bin/env python3
"""Pre-extract FFXI status/buff icons from ROM/119/57.DAT into the
addon's data/statusicons/ dir as opaque 32x32 BMPs.

The DAT stores "opaque" as alpha 0x80 — we promote it to 0xFF here so
no runtime code has to touch the alpha channel at all.
"""
import struct, sys, os

DAT = (sys.argv[1] if len(sys.argv) > 1 else
       'C:/Program Files (x86)/PlayOnline/SquareEnix/FINAL FANTASY XI/ROM/119/57.DAT')
OUT = os.path.join(os.path.dirname(__file__), '..', 'addon', 'xicompanion',
                   'data', 'statusicons')
REC = 0x1800
W = H = 32

def bmp_header(px_len):
    # 14B file header + 108B BITMAPV4HEADER (BGRA, BI_BITFIELDS, sRGB)
    total = 122 + px_len
    h = b'BM' + struct.pack('<IHHI', total, 0, 0, 122)
    h += struct.pack('<IiiHHIIiiII', 108, W, H, 1, 32, 3,
                     px_len, 2835, 2835, 0, 0)
    h += struct.pack('<IIII', 0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000)
    h += b'sRGB' + b'\0' * 36 + struct.pack('<III', 0, 0, 0)
    assert len(h) == 122
    return h

def opaque(px):
    b = bytearray(px)
    for i in range(3, len(b), 4):
        if b[i] == 0x80:
            b[i] = 0xFF
    return bytes(b)

def convert(rec):
    length = rec[0x281]
    if length == 16 or length == 4:           # uncompressed / XIVIEW: raw BGRA
        return opaque(rec[0x2BD:0x12BD])
    if length == 8:                            # 256-color palette -> BGRA
        pal = opaque(rec[0x2BD:0x6BD])
        return b''.join(pal[i*4:i*4+4] for i in rec[0x6BD:0xABD])
    return None

os.makedirs(OUT, exist_ok=True)
data = open(DAT, 'rb').read()
n = 0
for icon_id in range(len(data) // REC):
    rec = data[icon_id * REC:(icon_id + 1) * REC]
    px = convert(rec)
    if px and len(px) == W * H * 4:
        open(os.path.join(OUT, f'{icon_id}.bmp'), 'wb').write(
            bmp_header(len(px)) + px)
        n += 1
print(f'wrote {n} icons -> {OUT}')
