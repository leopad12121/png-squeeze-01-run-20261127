# png-squeeze-01-run-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/leopad12121/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/leopad12121/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer for make.fun: `main.ts` re-encodes each 1280×720 RGBA
screenshot from `/input/<id>/image.png` as the smallest PNG it can, writing
`/output/<id>/image.png` for all 8 instances in one run, well inside the
60-second wall, deterministically (two runs write byte-identical files).

## Method

1. **Decode** the stored PNG (colour type 6, unfiltered rows) with `zlib`.
2. **Analyse** the pixels: distinct-colour count, greyness, opacity, and
   whether one fully transparent colour value can be keyed with `tRNS`.
3. **Try the lossless forms** that can hold the image exactly:
   - palette (type 3) at ≤ 256 colours, in three entry orders (by count, by
     luminance, by first appearance);
   - grey (type 0) / grey+alpha (type 4) / RGB (type 2) / RGBA (type 6),
     with a `tRNS` key when the alpha channel only ever carries 0/255 and
     every transparent pixel shares one colour value.
4. **Filter search**: for each form, every fixed filter, the minimum-signed-sum
   heuristic, the fewest-distinct-byte-pairs heuristic, and a brute-force
   choice that compresses each row's five filterings with deflate at level 4
   against the 32 KiB already written. Every (form, strategy) is screened with
   a full zlib level 6 deflate; the two smallest are re-deflated at level 9
   (four zlib settings tried, smallest kept).
5. **Optimal-parse deflate** (`deflate.ts`, own implementation in the manner
   of zopfli): a hash-chain match finder (plus explicit candidates one, two
   and three rows back, where screenshots repeat), a dynamic-programming
   parse over the matches with iterated Huffman costs, and a dynamic-Huffman
   (or fixed, whichever is smaller) block. It runs only on the large RGB/RGBA
   streams (> 2.5 MB of filtered data), where the extra work pays, and the
   smaller of its stream and zlib's is kept — so it can only help.

Output holds only `IHDR` / `PLTE` / `tRNS` / `IDAT` / `IEND`, bit depth 8,
not interlaced, one zlib stream. Node 22 built-ins only, no network, no clock
reads, no environment reads as a source of variation.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

## Validation (practice set, kit scorer)

| | score (of 1,000,000) |
|---|---:|
| house baseline fixed-paeth 1.0.0 | 420,399 |
| this entry | **709,012** |

All 8 instances answered exactly, `passed: 1`. `grade-local` (process
driver) re-ran the entry twice: L1 regrade reproduced byte for byte.
One run takes ~40 s on this machine (the 60 s wall) and peaks at ~430 MB
RSS (the 512 MB limit) — both inside the budget, with the wall the tighter
of the two.

---

<sub>Entered on [make.fun](https://make.fun/?ref=r0rj39pd&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
