// png-squeeze: a lossless PNG re-encoder that squeezes 1280x720 RGBA screenshots
// as small as it can. One run answers all 8 instances under /input/<id>/ and
// writes /output/<id>/image.png for each.
//
// Method (all deterministic, budgeted by work, never by the clock):
//   1. Decode the stored PNG (colour type 6, unfiltered rows) with zlib.
//   2. Analyse the pixels: how many distinct colours, whether every pixel is
//      grey, whether every pixel is opaque, and whether a single fully
//      transparent colour value could be keyed with tRNS instead of an alpha
//      channel.
//   3. Try the lossless forms that can hold the image exactly:
//        - palette (type 3) when there are at most 256 colours, in three
//          entry orders (by count, by luminance, by first appearance);
//        - grey (type 0) / grey+alpha (type 4) / RGB (type 2) / RGBA (type 6),
//          with a tRNS key when the alpha channel only ever carries 0/255
//          and every transparent pixel shares one colour value.
//   4. For each form, try filter strategies per row: each fixed filter,
//      the minimum-signed-sum heuristic, the fewest-distinct-byte-pairs
//      heuristic, and a brute-force choice that compresses every row's five
//      filterings with deflate at level 4 against the 32 KiB already written
//      and keeps the smallest. Screen every (form, strategy) with a full
//      zlib level 6 deflate, keep the two smallest, and re-deflate those at
//      level 9 (a few zlib settings tried, smallest kept).
//   5. Write the winner as a PNG holding only IHDR / PLTE / tRNS / IDAT /
//      IEND, bit depth 8, not interlaced, one zlib stream.
//
// Node 22 built-ins only. No network, no clock reads, no environment reads
// as a source of variation (only MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR,
// defaulting to /input and /output as the harness mounts them).

import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateOptimal } from './deflate.ts';

const W = 1280;
const H = 720;
const N = W * H;
const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC-32 --

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ------------------------------------------------------------ PNG decode --

/** The Paeth predictor (PNG spec section 12.6). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode an input PNG to RGBA. The harness stores colour type 6, bit depth 8,
 * unfiltered rows; the decoder below handles the five filters anyway, and
 * rejects anything it cannot read exactly.
 */
export function decodePng(bytes: Uint8Array): Uint8Array {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const idat: Uint8Array[] = [];
  let sawIend = false;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (at + 12 + len > bytes.length) throw new Error('truncated chunk ' + type);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error('bad CRC in ' + type);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      colourType = data[9];
      if (colourType !== 6) throw new Error('input colour type is not 6');
      if (data[12] !== 0) throw new Error('input is interlaced');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }
  if (!sawIend || idat.length === 0) throw new Error('no IDAT/IEND');
  if (width !== W || height !== H) throw new Error('unexpected size ' + width + 'x' + height);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const stride = W * 4;
  if (raw.length !== H * (stride + 1)) throw new Error('unexpected inflated length ' + raw.length);
  const rgba = new Uint8Array(N * 4);
  for (let y = 0; y < H; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    if (ft === 0) {
      rgba.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (i >= 4 ? rgba[o + i - 4] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (y > 0 ? rgba[o - stride + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        rgba[o + i] = raw[src + i] + (((i >= 4 ? rgba[o + i - 4] : 0) + (y > 0 ? rgba[o - stride + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? rgba[o + i - 4] : 0;
        const b = y > 0 ? rgba[o - stride + i] : 0;
        const c = y > 0 && i >= 4 ? rgba[o - stride + i - 4] : 0;
        rgba[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else {
      throw new Error('unknown filter type ' + ft);
    }
  }
  return rgba;
}

// ------------------------------------------------------------- PNG encode --

const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdr(colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, W);
  v.setUint32(4, H);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function pngOf(colourType: number, plte: Uint8Array | null, trns: Uint8Array | null, idat: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [SIG, chunk('IHDR', ihdr(colourType))];
  if (plte !== null) parts.push(chunk('PLTE', plte));
  if (trns !== null) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// -------------------------------------------------------------- analysis --

interface Colour {
  word: number;
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
  first: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null; // null when more than 256 distinct colours
}

/** One pass over the pixels: opacity, greyness, and the colour histogram. */
export function analyse(rgba: Uint8Array): Analysis {
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, N);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  const firstSeen = new Map<number, number>();
  let many = false;
  for (let i = 0; i < N; i++) {
    const d = i * 4;
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const w = u32[i];
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size === 256) {
          many = true;
        } else {
          counts.set(w, 1);
          firstSeen.set(w, i);
        }
      } else {
        counts.set(w, k + 1);
      }
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [...counts.keys()].map((w) => {
      const b = new Uint8Array(Uint32Array.of(w).buffer);
      return { word: w, r: b[0], g: b[1], b: b[2], a: b[3], count: counts.get(w) as number, first: firstSeen.get(w) as number };
    });
  }
  return { opaque, grey, colours };
}

/**
 * The one fully transparent colour value the image may key with tRNS instead
 * of an alpha channel: every non-opaque pixel is that exact value at alpha 0,
 * and no opaque pixel uses the same value. -1 when there is none.
 */
function transparentKey(rgba: Uint8Array, grey: boolean): number {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -1;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return -1;
  }
  if (key === -1) return -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -1;
  }
  return key;
}

// ------------------------------------------------------------------ forms --

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array; // height rows of width*bpp samples, unfiltered
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  strategies: (number | 'minsum' | 'pairs' | 'brute')[];
}

const lumOf = (c: Colour): number => 299 * c.r + 587 * c.g + 114 * c.b;

/** Palette entries in trial order: transparent entries first (by alpha), then by `order`. */
function paletteForm(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance' | 'first'): Form {
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lumOf(x) - lumOf(y) || x.word - y.word;
    if (order === 'first') return x.first - y.first;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, N);
  const indices = new Uint8Array(N);
  for (let i = 0; i < N; i++) indices[i] = index.get(u32[i]) as number;
  const strategies: Form['strategies'] = order === 'luminance' ? [0, 'minsum', 'brute'] : [0, 'minsum'];
  return { colourType: 3, bpp: 1, samples: indices, plte, trns, strategies };
}

/** The image's samples in a channel colour type (0, 2, 4 or 6). */
function channelForm(rgba: Uint8Array, ct: number, trns: Uint8Array | null): Form {
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : ct === 2 ? 3 : 4;
  let samples: Uint8Array;
  if (ct === 6) {
    samples = rgba;
  } else {
    samples = new Uint8Array(N * ch);
    for (let i = 0, d = 0, s = 0; i < N; i++, d += 4, s += ch) {
      if (ct === 0) {
        samples[s] = rgba[d];
      } else if (ct === 4) {
        samples[s] = rgba[d];
        samples[s + 1] = rgba[d + 3];
      } else {
        samples[s] = rgba[d];
        samples[s + 1] = rgba[d + 1];
        samples[s + 2] = rgba[d + 2];
      }
    }
  }
  return { colourType: ct, bpp: ch, samples, plte: null, trns, strategies: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'] };
}

/** Every lossless form that can hold this image, in trial order. */
export function formsOf(rgba: Uint8Array, an: Analysis): Form[] {
  const forms: Form[] = [];
  if (an.colours !== null) {
    forms.push(paletteForm(rgba, an.colours, 'count'));
    forms.push(paletteForm(rgba, an.colours, 'luminance'));
    forms.push(paletteForm(rgba, an.colours, 'first'));
    if (!an.grey) return forms;
  }
  const key = an.opaque ? -1 : transparentKey(rgba, an.grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (an.grey) {
    ct = an.opaque || key !== -1 ? 0 : 4;
    if (key !== -1) trns = Uint8Array.of(0, key);
  } else {
    ct = an.opaque || key !== -1 ? 2 : 6;
    if (key !== -1) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  forms.push(channelForm(rgba, ct, trns));
  return forms;
}

// --------------------------------------------------------------- filtering --

/** Filter one row of `cur` against the row above (`prev`, null on row 0). */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** Sum of a filtered row's bytes read as signed values: the PNG spec's heuristic cost. */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const PAIR_SEEN = new Uint32Array(65536);
let pairStamp = 0;

/** How many distinct neighbouring byte pairs a filtered row holds. */
function pairsOf(row: Uint8Array): number {
  const stamp = ++pairStamp;
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (PAIR_SEEN[pair] !== stamp) {
      PAIR_SEEN[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

/**
 * The filtered data of one form under one strategy: height rows, each behind
 * its filter byte. 'brute' compresses each row's five filterings with deflate
 * at level 4 against the 32 KiB already written and keeps the smallest.
 * When `out` is given, the data is written into it (so one scratch buffer
 * can serve every strategy of a form) and it is returned.
 */
export function filtered(samples: Uint8Array, bpp: number, choice: number | 'minsum' | 'pairs' | 'brute', out?: Uint8Array): Uint8Array {
  const stride = W * bpp;
  const raw = out ?? new Uint8Array(H * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  for (let y = 0; y < H; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1));
      else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: BRUTE_LEVEL, memLevel: 9 }
            : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// --------------------------------------------------------------- squeezing --

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const FINAL_SETTINGS = [
  { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 8, strategy: constants.Z_FILTERED },
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
];

function chunkOverhead(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

/** The smallest PNG of one image: screen every (form, strategy) at level 6, re-deflate the best two at level 9. */
export function squeeze(rgba: Uint8Array): Uint8Array {
  const an = analyse(rgba);
  const forms = formsOf(rgba, an);
  interface Candidate {
    form: Form;
    data: Uint8Array;
    bytes: number;
  }
  const ranked: Candidate[] = [];
  // Keep only the two smallest candidates, so the filtered data of every
  // losing strategy can be reclaimed instead of piling up: one scratch
  // buffer serves every strategy of a form, and only a winner's bytes are
  // copied out of it.
  const consider = (form: Form, data: Uint8Array, bytes: number): void => {
    ranked.push({ form, data, bytes });
    ranked.sort((a, b) => a.bytes - b.bytes);
    if (ranked.length > 2) ranked.pop();
  };
  for (const form of forms) {
    const overhead = chunkOverhead(form);
    const scratch = new Uint8Array(H * (W * form.bpp + 1));
    for (const choice of form.strategies) {
      filtered(form.samples, form.bpp, choice, scratch);
      const zlib = deflateSync(scratch, SCREEN);
      const bytes = zlib.length + overhead;
      if (ranked.length < 2 || bytes < ranked[ranked.length - 1].bytes) {
        consider(form, scratch.slice(), bytes);
      }
    }
  }
  ranked.sort((a, b) => a.bytes - b.bytes);
  let best: Uint8Array | null = null;
  let bestBytes = Infinity;
  let bestForm: Form | null = null;
  let bestData: Uint8Array | null = null;
  const finalists = ranked.slice(0, 2);
  for (const cand of finalists) {
    for (const settings of FINAL_SETTINGS) {
      const zlib = deflateSync(cand.data, settings);
      const total = zlib.length + chunkOverhead(cand.form);
      if (total < bestBytes) {
        bestBytes = total;
        bestForm = cand.form;
        bestData = cand.data;
        best = pngOf(cand.form.colourType, cand.form.plte, cand.form.trns, new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length));
      }
    }
  }
  // The optimal-parse deflater earns its keep only on the large RGB/RGBA
  // streams (about 2.8-3.7 MB of filtered data); on the small palette/grey
  // streams zlib level 9 already wins, so the work is skipped there. It is
  // only an improvement attempt: any failure keeps the zlib stream.
  if (best !== null && bestForm !== null && bestData !== null && bestData.length > 2500000) {
    try {
      const opt = deflateOptimal(bestData, W * bestForm.bpp + 1);
      const total = opt.length + chunkOverhead(bestForm);
      if (total < bestBytes) {
        bestBytes = total;
        best = pngOf(bestForm.colourType, bestForm.plte, bestForm.trns, opt);
      }
    } catch {
      // Keep the zlib stream.
    }
  }
  if (best === null) throw new Error('no candidate');
  return best;
}

// ------------------------------------------------------------------- main --

export function main(): void {
  for (const id of readdirSync(INPUT).sort()) {
    const rgba = decodePng(new Uint8Array(readFileSync(join(INPUT, id, 'image.png'))));
    const png = squeeze(rgba);
    mkdirSync(join(OUTPUT, id), { recursive: true });
    writeFileSync(join(OUTPUT, id, 'image.png'), png);
  }
}

// Run the set when executed directly (node main.ts); importing this file for
// its pipeline (tests, prototypes) runs nothing.
if (process.argv[1] === new URL(import.meta.url).pathname) main();
