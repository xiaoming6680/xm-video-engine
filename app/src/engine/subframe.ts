// Where the engine is inside a motion-blurred frame (Engine.render). Its own module so util.ts can read it without
// pulling in three.js; gl.ts re-exports it.

/**
 * The sub-frame being rendered. `frame`: the time of the frame being averaged (NaN outside a multi-sample render).
 * `k`: 0, 1, … in render order. `s`: where it sits in the shutter, 0..1, while the frame averages sub-frames in sets of
 * 4 (-1 in the preview, single-sample stills and fixed counts that are not a multiple of 4).
 * Things that vary per sub-frame only to be averaged (camera jitter, soft lights) key off `s`, not `k`: a later adaptive
 * set's sub-frames sit next to the ones they refine (ternaryOffsets), so they get nearly the same value and the sets agree
 * where nothing moves; keyed off `k`, every set would differ and the sampler would run to its maximum.
 */
export const SUBFRAME = { frame: NaN, k: -1, s: -1 };
