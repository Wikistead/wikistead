import { unzlibSync } from "fflate";

// #389: measuring what the user actually SEES. Geometry pins (getBoundingClientRect) proved useless
// here — the rects matched to 0.008px while the control still looked off-centre, because the ring and
// the dot are separate paint boxes that each round to device pixels independently. So these helpers
// decode a real screenshot and weigh the ink.

export interface Bitmap { width: number; height: number; data: Uint8Array } // RGBA

/** Minimal PNG reader for what Chromium's screenshots actually are: 8-bit RGB(A), no interlace. */
export function decodePng(buf: Buffer): Bitmap {
  let pos = 8; // skip signature
  let width = 0, height = 0, channels = 4;
  const idat: Uint8Array[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8], colorType = body[9], interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`unsupported PNG (depth ${depth}, colorType ${colorType}, interlace ${interlace})`);
      }
      channels = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(new Uint8Array(body));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = unzlibSync(concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    line.set(raw.subarray(p, p + stride));
    p += stride;
    unfilter(filter, line, prev, channels);
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev.set(line);
  }
  return { width, height, data: out };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of parts) { out.set(a, at); at += a.length; }
  return out;
}

function unfilter(filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = line.length;
  switch (filter) {
    case 0: return;
    case 1: for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 0xff; return;
    case 2: for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 0xff; return;
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      return;
    default: throw new Error(`bad PNG filter ${filter}`);
  }
}

export interface Ink { x: number; y: number; weight: number; minX: number; maxX: number; minY: number; maxY: number }

/**
 * Centre of mass of the pixels a predicate accepts, in image (device) pixels. Weighted by how much of
 * the colour each pixel carries, so an antialiased edge pulls its true fraction — that is precisely
 * the sub-pixel drift a boolean threshold would throw away.
 */
export function inkCentroid(bm: Bitmap, weigh: (r: number, g: number, b: number, a: number) => number): Ink {
  let sx = 0, sy = 0, sw = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      const i = (y * bm.width + x) * 4;
      const w = weigh(bm.data[i], bm.data[i + 1], bm.data[i + 2], bm.data[i + 3]);
      if (w <= 0) continue;
      sx += (x + 0.5) * w; sy += (y + 0.5) * w; sw += w;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { x: sx / sw, y: sy / sw, weight: sw, minX, maxX, minY, maxY };
}

/** Same, restricted to pixels whose distance from a centre falls in [min, max) — separates a dot from the ring around it. */
export function inkCentroidInRing(
  bm: Bitmap, cx: number, cy: number, min: number, max: number,
  weigh: (r: number, g: number, b: number, a: number) => number,
): Ink {
  return inkCentroidMasked(bm, (x, y) => {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    return d >= min && d < max;
  }, weigh);
}

export function inkCentroidMasked(
  bm: Bitmap, inside: (x: number, y: number) => boolean,
  weigh: (r: number, g: number, b: number, a: number) => number,
): Ink {
  let sx = 0, sy = 0, sw = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      if (!inside(x, y)) continue;
      const i = (y * bm.width + x) * 4;
      const w = weigh(bm.data[i], bm.data[i + 1], bm.data[i + 2], bm.data[i + 3]);
      if (w <= 0) continue;
      sx += (x + 0.5) * w; sy += (y + 0.5) * w; sw += w;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { x: sx / sw, y: sy / sw, weight: sw, minX, maxX, minY, maxY };
}

/** How much a pixel resembles `target` (0..1), so antialiased edges contribute their real fraction. */
export function closenessTo(target: [number, number, number], tolerance = 90) {
  return (r: number, g: number, b: number) => {
    const d = Math.hypot(r - target[0], g - target[1], b - target[2]);
    return d >= tolerance ? 0 : 1 - d / tolerance;
  };
}

/**
 * The inverse: how much a pixel DIFFERS from `target` (0..1). Weighing every pixel that is not the
 * page background gives the control's whole silhouette, whose centroid is its true centre to
 * sub-pixel precision — unlike a min/max bounding box, which quantises to whole pixels and so cannot
 * resolve the very drift being measured.
 */
export function differenceFrom(target: [number, number, number], tolerance = 40) {
  return (r: number, g: number, b: number) => {
    const d = Math.hypot(r - target[0], g - target[1], b - target[2]);
    return d >= tolerance ? 1 : d / tolerance;
  };
}

export function pixelAt(bm: Bitmap, x: number, y: number): [number, number, number] {
  const i = (y * bm.width + x) * 4;
  return [bm.data[i], bm.data[i + 1], bm.data[i + 2]];
}

export function parseRgb(css: string): [number, number, number] {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  if (!m) throw new Error(`not an rgb color: ${css}`);
  const [r, g, b] = m[1].split(",").map((n) => parseFloat(n));
  return [r, g, b];
}
