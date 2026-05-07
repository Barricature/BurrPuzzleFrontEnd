// @ts-nocheck

/**
 * Mulberry32: a small, fast, deterministic 32-bit PRNG.
 *
 * Used by the CBiRRT planner so that planning runs are reproducible across
 * sessions when a fixed seed is supplied. Returns a function that yields a
 * uniform float in [0, 1) on each call.
 *
 * Reference: https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
 */
export function createMulberry32(seed = 1) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
