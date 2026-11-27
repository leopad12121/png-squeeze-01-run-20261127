// An optimal-parse deflate encoder (own implementation, in the manner of
// zopfli): a hash-chain match finder, a dynamic-programming parse over the
// matches with iterated Huffman costs, and a dynamic-Huffman (or fixed,
// whichever is smaller) block. It beats zlib level 9 by a few percent on the
// large RGB/RGBA streams of this contest, where the extra work pays; the
// caller keeps whichever stream is smaller, so it can only help.
//
// Deterministic: the work is bounded by fixed chain limits and fixed round
// counts, never by the clock. Node 22 built-ins only (no imports at all).

// ------------------------------------------------------- deflate tables --

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// Length symbol (257..285) and extra bits for a match length 3..258.
const LEN_SYM = new Int32Array(259);
const LEN_SYM_EXTRA = new Int32Array(259);
for (let i = 0; i < 29; i++) {
  const hi = i === 28 ? 258 : LEN_BASE[i + 1] - 1;
  for (let l = LEN_BASE[i]; l <= hi; l++) {
    LEN_SYM[l] = 257 + i;
    LEN_SYM_EXTRA[l] = LEN_EXTRA[i];
  }
}
// Distance symbol (0..29) and extra bits for a distance 1..32768.
const DIST_SYM = new Int32Array(32769);
const DIST_SYM_EXTRA = new Int32Array(32769);
for (let i = 0; i < 30; i++) {
  const hi = i === 29 ? 32768 : DIST_BASE[i + 1] - 1;
  for (let d = DIST_BASE[i]; d <= hi; d++) {
    DIST_SYM[d] = i;
    DIST_SYM_EXTRA[d] = DIST_EXTRA[i];
  }
}

// Fixed Huffman lengths (RFC 1951 section 3.2.6).
const FIXED_LIT_LEN = new Int32Array(288);
for (let i = 0; i < 144; i++) FIXED_LIT_LEN[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LIT_LEN[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LIT_LEN[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LIT_LEN[i] = 8;
const FIXED_DIST_LEN = new Int32Array(30).fill(5);

// ------------------------------------------------- length-limited Huffman --

/** Canonical Huffman codes from code lengths (0 = unused); codes are MSB-first values. */
function canonicalCodes(lengths: number[] | Int32Array): number[] {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Array<number>(maxLen + 1).fill(0);
  for (const l of lengths) if (l) blCount[l]++;
  const nextCode = new Array<number>(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Array<number>(lengths.length).fill(0);
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (l) codes[i] = nextCode[l]++;
  }
  return codes;
}

/**
 * Optimal length-limited Huffman code lengths by package-merge (maxLen 15
 * for literal/length and distance codes, 7 for the code-length code).
 * Returns lengths, 0 for unused symbols. Every used symbol gets a length
 * and the Kraft sum is 1.
 */
function huffmanLengths(freqs: number[], maxLen: number): number[] {
  const n = freqs.reduce((a, f) => a + (f > 0 ? 1 : 0), 0);
  const lengths = new Array<number>(freqs.length).fill(0);
  if (n === 0) return lengths;
  if (n === 1) {
    lengths[freqs.findIndex((f) => f > 0)] = 1;
    return lengths;
  }
  interface Item {
    f: number;
    syms: number[];
  }
  let cur: Item[] = freqs.map((f, i) => (f > 0 ? { f, syms: [i] } : null)).filter((x): x is Item => x !== null);
  cur.sort((a, b) => a.f - b.f);
  const orig = cur;
  const keep = 2 * n - 2;
  for (let level = 0; level < maxLen - 1; level++) {
    const packaged: Item[] = [];
    for (let i = 0; i + 1 < cur.length; i += 2) {
      packaged.push({ f: cur[i].f + cur[i + 1].f, syms: cur[i].syms.concat(cur[i + 1].syms) });
    }
    if (cur.length % 2 === 1) packaged.push(cur[cur.length - 1]);
    const merged: Item[] = [];
    let a = 0;
    let b = 0;
    while (merged.length < keep && (a < packaged.length || b < orig.length)) {
      if (b >= orig.length || (a < packaged.length && packaged[a].f <= orig[b].f)) merged.push(packaged[a++]);
      else merged.push(orig[b++]);
    }
    cur = merged;
  }
  for (const item of cur) for (const s of item.syms) lengths[s]++;
  return lengths;
}

// ------------------------------------------------------------ bit writer --

function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

class BitWriter {
  bytes: number[] = [];
  bitBuf = 0;
  bitCnt = 0;
  put(val: number, len: number): void {
    this.bitBuf |= val << this.bitCnt;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  putCode(code: number, len: number): void {
    this.put(reverseBits(code, len), len);
  }
  finish(): Uint8Array {
    if (this.bitCnt > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ----------------------------------------------------------- match finder --

const CHAIN = 64;
const MAX_MATCH = 258;
const WINDOW = 32768;

/**
 * Best match (length, distance) starting at every position. One hash-chain
 * sweep over 3-byte hashes (most recent first, at most CHAIN candidates, a
 * candidate examined only while it can still beat the current best length),
 * plus explicit candidates one, two and three rows back (the same column of
 * the previous rows, where screenshots repeat). The row length is passed in
 * so the row-back distances are exact.
 */
function findMatches(data: Uint8Array, rowLen: number): { bestLen: Int32Array; bestDist: Int32Array } {
  const n = data.length;
  const bestLen = new Int32Array(n);
  const bestDist = new Int32Array(n);
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const r2 = rowLen * 2;
  const r3 = rowLen * 3;
  for (let i = 0; i < n - 2; i++) {
    const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0x7fff;
    let cand = head[h];
    let bl = 0;
    let bd = 0;
    let tries = 0;
    let maxL = n - i;
    if (maxL > MAX_MATCH) maxL = MAX_MATCH;
    while (cand !== -1 && tries < CHAIN) {
      const dist = i - cand;
      if (dist > WINDOW) break;
      if (bl < maxL && (bl === 0 || data[cand + bl] === data[i + bl])) {
        let l = 0;
        while (l < maxL && data[cand + l] === data[i + l]) l++;
        if (l > bl) {
          bl = l;
          bd = dist;
          if (l >= MAX_MATCH) break;
        }
      }
      cand = prev[cand];
      tries++;
    }
    let c2 = i - rowLen;
    if (c2 >= 0 && data[c2] === data[i] && data[c2 + 1] === data[i + 1] && data[c2 + 2] === data[i + 2]) {
      let l = 3;
      while (l < maxL && data[c2 + l] === data[i + l]) l++;
      if (l > bl || (l === bl && rowLen < bd)) {
        bl = l;
        bd = rowLen;
      }
    }
    c2 = i - r2;
    if (c2 >= 0 && data[c2] === data[i] && data[c2 + 1] === data[i + 1] && data[c2 + 2] === data[i + 2]) {
      let l = 3;
      while (l < maxL && data[c2 + l] === data[i + l]) l++;
      if (l > bl || (l === bl && r2 < bd)) {
        bl = l;
        bd = r2;
      }
    }
    c2 = i - r3;
    if (c2 >= 0 && data[c2] === data[i] && data[c2 + 1] === data[i + 1] && data[c2 + 2] === data[i + 2]) {
      let l = 3;
      while (l < maxL && data[c2 + l] === data[i + l]) l++;
      if (l > bl || (l === bl && r3 < bd)) {
        bl = l;
        bd = r3;
      }
    }
    bestLen[i] = bl;
    bestDist[i] = bd;
    prev[i] = head[h];
    head[h] = i;
  }
  return { bestLen, bestDist };
}

// ------------------------------------------------------------ optimal parse --

type Token = [number] | [number, number]; // [literal] or [length, distance]

function matchCost(len: number, dist: number, litCost: Float64Array, distCost: Float64Array): number {
  return litCost[LEN_SYM[len]] + LEN_SYM_EXTRA[len] + distCost[DIST_SYM[dist]] + DIST_SYM_EXTRA[dist];
}

/**
 * The cheapest parse of `data` given the precomputed matches and the cost
 * tables: at each position the options are one literal or the longest match
 * found there. Dynamic programming forward over positions, then walk back.
 * Costs are whole bits, so the table is exact integers.
 */
function dpParse(
  data: Uint8Array,
  bestLen: Int32Array,
  bestDist: Int32Array,
  litCost: Float64Array,
  distCost: Float64Array,
  dp: Int32Array,
  prevPos: Int32Array,
  tokLen: Int32Array,
  tokDist: Int32Array,
): Token[] {
  const n = data.length;
  dp.fill(1 << 30, 0, n + 1);
  dp[0] = 0;
  for (let i = 0; i < n; i++) {
    const base = dp[i];
    const cLit = base + litCost[data[i]];
    if (cLit < dp[i + 1]) {
      dp[i + 1] = cLit;
      prevPos[i + 1] = i;
      tokLen[i + 1] = 0;
    }
    const len = bestLen[i];
    if (len >= 3) {
      const dist = bestDist[i];
      const c = base + matchCost(len, dist, litCost, distCost);
      const j = i + len;
      if (c < dp[j]) {
        dp[j] = c;
        prevPos[j] = i;
        tokLen[j] = len;
        tokDist[j] = dist;
      }
    }
  }
  const tokens: Token[] = [];
  let j = n;
  while (j > 0) {
    const i = prevPos[j];
    if (tokLen[j] === 0) tokens.push([data[i]]);
    else tokens.push([tokLen[j], tokDist[j]]);
    j = i;
  }
  tokens.reverse();
  return tokens;
}

function tokenFreqs(tokens: Token[]): { litFreq: number[]; distFreq: number[] } {
  const litFreq = new Array<number>(288).fill(0);
  const distFreq = new Array<number>(30).fill(0);
  for (const t of tokens) {
    if (t.length === 1) litFreq[t[0]]++;
    else {
      litFreq[LEN_SYM[t[0]]]++;
      distFreq[DIST_SYM[t[1]]]++;
    }
  }
  litFreq[256] = 1; // end of block
  return { litFreq, distFreq };
}

// -------------------------------------------------------------- emit block --

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** One dynamic-Huffman block (BFINAL=1) for the token stream. */
function emitDynamic(tokens: Token[], litLen: number[], distLen: number[], w: BitWriter): void {
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  let hlit = 288;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const seq = litLen.slice(0, hlit).concat(distLen.slice(0, hdist));
  const clFreq = new Array<number>(19).fill(0);
  for (const v of seq) clFreq[v]++;
  const clLen = huffmanLengths(clFreq, 7);
  const clCode = canonicalCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  w.put(1, 1); // BFINAL
  w.put(2, 2); // BTYPE = dynamic
  w.put(hlit - 257, 5);
  w.put(hdist - 1, 5);
  w.put(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.put(clLen[CL_ORDER[k]], 3);
  for (const v of seq) w.putCode(clCode[v], clLen[v]);
  for (const t of tokens) {
    if (t.length === 1) {
      w.putCode(litCode[t[0]], litLen[t[0]]);
    } else {
      const len = t[0];
      const dist = t[1];
      const ls = LEN_SYM[len];
      w.putCode(litCode[ls], litLen[ls]);
      if (LEN_SYM_EXTRA[len] > 0) w.put(len - LEN_BASE[ls - 257], LEN_SYM_EXTRA[len]);
      const ds = DIST_SYM[dist];
      w.putCode(distCode[ds], distLen[ds]);
      if (DIST_SYM_EXTRA[dist] > 0) w.put(dist - DIST_BASE[ds], DIST_SYM_EXTRA[dist]);
    }
  }
  w.putCode(litCode[256], litLen[256]);
}

/** One fixed-Huffman block (BFINAL=1) for the token stream. */
function emitFixed(tokens: Token[], w: BitWriter): void {
  const litCode = canonicalCodes(FIXED_LIT_LEN);
  const distCode = canonicalCodes(FIXED_DIST_LEN);
  w.put(1, 1);
  w.put(1, 2); // BTYPE = fixed
  for (const t of tokens) {
    if (t.length === 1) {
      w.putCode(litCode[t[0]], FIXED_LIT_LEN[t[0]]);
    } else {
      const len = t[0];
      const dist = t[1];
      const ls = LEN_SYM[len];
      w.putCode(litCode[ls], FIXED_LIT_LEN[ls]);
      if (LEN_SYM_EXTRA[len] > 0) w.put(len - LEN_BASE[ls - 257], LEN_SYM_EXTRA[len]);
      const ds = DIST_SYM[dist];
      w.putCode(distCode[ds], FIXED_DIST_LEN[ds]);
      if (DIST_SYM_EXTRA[dist] > 0) w.put(dist - DIST_BASE[ds], DIST_SYM_EXTRA[dist]);
    }
  }
  w.putCode(litCode[256], FIXED_LIT_LEN[256]);
}

// -------------------------------------------------------------- deflater --

/**
 * A zlib stream of `data` from the optimal parse: parse with fixed-Huffman
 * costs, rebuild the Huffman tables from the parse, re-parse, and repeat;
 * emit the token stream as a dynamic block (or a fixed block when that is
 * smaller) inside the zlib wrapper (header 0x78DA, Adler-32). `rowLen` is
 * the filtered row's length in bytes (stride + 1), used for the row-back
 * match candidates.
 */
export function deflateOptimal(data: Uint8Array, rowLen: number): Uint8Array {
  const { bestLen, bestDist } = findMatches(data, rowLen);
  const n = data.length;
  const dp = new Int32Array(n + 1);
  const prevPos = new Int32Array(n + 1);
  const tokLen = new Int32Array(n + 1);
  const tokDist = new Int32Array(n + 1);
  let litCost = new Float64Array(288);
  let distCost = new Float64Array(30);
  for (let i = 0; i < 288; i++) litCost[i] = FIXED_LIT_LEN[i];
  for (let i = 0; i < 30; i++) distCost[i] = FIXED_DIST_LEN[i];
  let tokens: Token[] = [];
  let litLen: number[] = [];
  let distLen: number[] = [];
  for (let round = 0; round < 3; round++) {
    tokens = dpParse(data, bestLen, bestDist, litCost, distCost, dp, prevPos, tokLen, tokDist);
    const { litFreq, distFreq } = tokenFreqs(tokens);
    litLen = huffmanLengths(litFreq, 15);
    distLen = huffmanLengths(distFreq, 15);
    for (let i = 0; i < 288; i++) if (litFreq[i] > 0 && litLen[i] === 0) throw new Error('literal symbol without a code length');
    for (let i = 0; i < 30; i++) if (distFreq[i] > 0 && distLen[i] === 0) throw new Error('distance symbol without a code length');
    litCost = new Float64Array(288);
    distCost = new Float64Array(30);
    for (let i = 0; i < 288; i++) litCost[i] = litLen[i];
    for (let i = 0; i < 30; i++) distCost[i] = distLen[i];
  }
  const wDyn = new BitWriter();
  emitDynamic(tokens, litLen, distLen, wDyn);
  const dyn = wDyn.finish();
  const wFix = new BitWriter();
  emitFixed(tokens, wFix);
  const fix = wFix.finish();
  const body = dyn.length <= fix.length ? dyn : fix;
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(data));
  return out;
}
