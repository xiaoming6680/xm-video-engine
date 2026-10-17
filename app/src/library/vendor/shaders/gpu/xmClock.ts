/**
 * XM-PATCH(host-clock): the clock the library's wall-clock reads use. While a renderer is driven by its host's
 * clock (setClock), each of its frames sets the host time here before its CPU hooks run; `xmNow()` then returns that
 * time in ms instead of `Date.now()` — idle / settle gates, grid sims stepped on the CPU and raster throttles become
 * functions of the host's timeline, not of how fast the machine renders. Frames are synchronous per renderer, so the
 * page-wide value is always the current frame's. Not part of the upstream library (see VENDOR.md).
 */
let hostMs: number | null = null

/** Set by the renderer at the start of each frame: the frame's time (s) when the host drives the clock, else undefined. */
export function xmSetHostTime(seconds: number | undefined): void {
    hostMs = seconds === undefined ? null : seconds * 1000
}

/** True while the frame being rendered is driven by its host's clock. */
export function xmHostDriven(): boolean {
    return hostMs !== null
}

/** Milliseconds: the host's frame time while it drives the clock, else wall clock. */
export function xmNow(): number {
    return hostMs ?? Date.now()
}
