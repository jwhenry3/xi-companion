// Zone map image resolver. GET /api/map/img returns either a user-dropped
// PNG (image/png — served as-is) or the client's own map DAT
// (application/x-ffxi-map), which we decode here in the WebView — keeps the
// DXT decode off the game frame entirely.
//
// DAT image layout (mirrors Windower ResourceExtractor's ImageParser):
//   0x30  u8   flag
//   0x41  44B  header: u32 len, i32 w, i32 h, u16 planes, u16 bits,
//               u32 comp, u32 size, u32 hres, u32 vres, u32 used,
//               u32 imp, u32 type ('DXT0'+1..5 = DXT1-5, 0x0A = bitmap)
//   DXT:    +8 unknown bytes, then 4x4 texel blocks (row-major)
//   bitmap: 8-bit → 256×4 BGRA palette + w*h indices (bottom-up rows);
//           16-bit RGB565 / 24-bit BGR / 32-bit BGRA, also bottom-up

const DXT0 = 0x44585430; // 'DXT0'
const BITMAP = 0x0a;

const cache = new Map<string, { t: number; p: Promise<string | null> }>();
const RETRY_MS = 30000;

export function resolveMapImage(
  url: string,
  key: string,
): Promise<string | null> {
  const e = cache.get(key);
  if (e && Date.now() - e.t < RETRY_MS) return e.p;
  const p = fetchAndDecode(url);
  cache.set(key, { t: Date.now(), p });
  return p;
}

async function fetchAndDecode(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type.startsWith('image/')) {
      return URL.createObjectURL(await res.blob());
    }
    if (type.startsWith('application/x-ffxi-map')) {
      const rgba = decodeMapDat(await res.arrayBuffer());
      return rgba ? await rgbaToUrl(rgba) : null;
    }
    return null;
  } catch {
    return null;
  }
}

interface Decoded {
  w: number;
  h: number;
  px: Uint8ClampedArray;
}

function decodeMapDat(buf: ArrayBuffer): Decoded | null {
  const d = new DataView(buf);
  if (buf.byteLength < 0x75) return null;
  const w = d.getInt32(0x45, true);
  const h = d.getInt32(0x49, true);
  const bits = d.getUint16(0x4f, true);
  const type = d.getUint32(0x69, true);
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return null;

  if (type >= DXT0 + 1 && type <= DXT0 + 5) {
    return decodeDxt(d, buf.byteLength, 0x75, w, h, type - DXT0);
  }
  if (type === BITMAP) {
    return decodeBitmap(d, 0x41 + 44, w, h, bits);
  }
  return null;
}

function rgb565(c: number): [number, number, number] {
  return [(c >> 8) & 0xf8, (c >> 3) & 0xfc, (c << 3) & 0xff];
}

function decodeDxt(
  d: DataView,
  len: number,
  off: number,
  w: number,
  h: number,
  kind: number,
): Decoded | null {
  const px = new Uint8ClampedArray(w * h * 4);
  const blockBytes = kind === 1 ? 8 : 16;
  const bw = Math.ceil(w / 4);
  const bh = Math.ceil(h / 4);
  if (off + bw * bh * blockBytes > len) return null;
  const hasAlpha = kind >= 2;
  const interpAlpha = kind === 4 || kind === 5; // DXT4/5 interpolated alpha

  let pos = off;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, pos += blockBytes) {
      let alphaBlock = 0n;
      if (hasAlpha) {
        alphaBlock = d.getBigUint64(pos, true);
      }
      const cOff = pos + (hasAlpha ? 8 : 0);
      const c0 = d.getUint16(cOff, true);
      const c1 = d.getUint16(cOff + 2, true);
      const idx = d.getUint32(cOff + 4, true);

      const cols = [rgb565(c0), rgb565(c1)];
      if (c0 > c1 || kind !== 1) {
        cols.push([
          (2 * cols[0][0] + cols[1][0] + 1) / 3,
          (2 * cols[0][1] + cols[1][1] + 1) / 3,
          (2 * cols[0][2] + cols[1][2] + 1) / 3,
        ]);
        cols.push([
          (2 * cols[1][0] + cols[0][0] + 1) / 3,
          (2 * cols[1][1] + cols[0][1] + 1) / 3,
          (2 * cols[1][2] + cols[0][2] + 1) / 3,
        ]);
      } else {
        cols.push([
          (cols[0][0] + cols[1][0]) / 2,
          (cols[0][1] + cols[1][1]) / 2,
          (cols[0][2] + cols[1][2]) / 2,
        ]);
        cols.push([0, 0, 0]); // transparent
      }

      // DXT5-style interpolated alpha table
      let alphaTable: number[] | null = null;
      if (interpAlpha) {
        const a0 = Number(alphaBlock & 0xffn);
        const a1 = Number((alphaBlock >> 8n) & 0xffn);
        alphaTable = [a0, a1, 0, 0, 0, 0, 0, 0];
        if (a0 > a1) {
          for (let i = 1; i <= 6; i++) {
            alphaTable[1 + i] = ((7 - i) * a0 + i * a1 + 3) / 7;
          }
        } else {
          for (let i = 1; i <= 4; i++) {
            alphaTable[1 + i] = ((5 - i) * a0 + i * a1 + 2) / 5;
          }
          alphaTable[6] = 0;
          alphaTable[7] = 255;
        }
      }

      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i & 3);
        const y = by * 4 + (i >> 2);
        if (x >= w || y >= h) continue;
        const ci = (idx >> (2 * i)) & 3;
        let a = 255;
        if (hasAlpha) {
          if (interpAlpha && alphaTable) {
            const sh = 16 + 3 * i;
            a = alphaTable[Number((alphaBlock >> BigInt(sh)) & 7n)];
          } else {
            const nibble = Number((alphaBlock >> BigInt(4 * i)) & 0xfn);
            a = nibble >= 8 ? 255 : nibble << 5;
          }
        } else if (kind === 1 && c0 <= c1 && ci === 3) {
          a = 0;
        }
        const o = (y * w + x) * 4;
        px[o] = cols[ci][0];
        px[o + 1] = cols[ci][1];
        px[o + 2] = cols[ci][2];
        px[o + 3] = a;
      }
    }
  }
  return { w, h, px };
}

function decodeBitmap(
  d: DataView,
  off: number,
  w: number,
  h: number,
  bits: number,
): Decoded | null {
  const px = new Uint8ClampedArray(w * h * 4);
  let pos = off;

  let palette: Uint8Array | null = null;
  if (bits === 8) {
    if (pos + 1024 + w * h > d.byteLength) return null;
    palette = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) palette[i] = d.getUint8(pos + i);
    pos += 1024;
  }

  const stride = { 8: 1, 16: 2, 24: 3, 32: 4 }[bits];
  if (!stride || pos + w * h * stride > d.byteLength) return null;

  // stored bottom-up → write row (h-1-y) from source row y
  for (let y = 0; y < h; y++) {
    const dstRow = (h - 1 - y) * w * 4;
    for (let x = 0; x < w; x++) {
      const s = pos + (y * w + x) * stride;
      const o = dstRow + x * 4;
      if (bits === 8 && palette) {
        const pi = d.getUint8(s) * 4;
        px[o] = palette[pi + 2];
        px[o + 1] = palette[pi + 1];
        px[o + 2] = palette[pi];
        px[o + 3] = 255;
      } else if (bits === 16) {
        const c = d.getUint16(s, true);
        const [r, g, b] = rgb565(c);
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      } else if (bits === 24) {
        px[o] = d.getUint8(s + 2);
        px[o + 1] = d.getUint8(s + 1);
        px[o + 2] = d.getUint8(s);
        px[o + 3] = 255;
      } else {
        px[o] = d.getUint8(s + 2);
        px[o + 1] = d.getUint8(s + 1);
        px[o + 2] = d.getUint8(s);
        px[o + 3] = 255;
      }
    }
  }
  return { w, h, px };
}

async function rgbaToUrl(d: Decoded): Promise<string | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = d.w;
    canvas.height = d.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // the data param is `Uint8ClampedArray` on old libs and
    // `ImageDataArray` (ArrayBuffer-only) on new ones — derive it from
    // the ctor so this compiles under both
    type ImgData = ConstructorParameters<typeof ImageData>[0];
    ctx.putImageData(new ImageData(d.px as ImgData, d.w, d.h), 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}
