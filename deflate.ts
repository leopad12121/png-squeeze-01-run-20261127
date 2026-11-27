// Removed in round 2.
//
// This file held an optimal-parse deflate encoder (in the manner of zopfli).
// Round 1 measured it at 5.5-8.4 s per large instance on 1 CPU for only
// 0.4-3% smaller output, and its cheaper chain/round variants scored worse
// than zlib level 9, so round 2 drops it: the entry is zlib-only now and
// finishes the whole 8-instance set in ~10 s on 1 CPU, well inside the
// 60 s wall. main.ts no longer imports this file.
export {};
