/**
 * XM-PATCH(pending): a page-wide count of the library's async loads in flight (image / SDF fetches, font
 * loads, text rasters waiting on a font). A host rendering frames that must not depend on load timing
 * (offline export) waits for `xmPendingCount() === 0` — then renders once more, since a finished load
 * uploads its data in the next frame's onBeforeRender. Not part of the upstream library (see VENDOR.md).
 */
let pending = 0

/** Count `p` as in flight until it settles; returns `p`. */
export function xmTrack<T>(p: Promise<T>): Promise<T> {
    pending++
    p.then(() => { pending-- }, () => { pending-- })
    return p
}

/** Async loads still in flight, page-wide. */
export function xmPendingCount(): number {
    return pending
}
