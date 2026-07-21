// Seeded PRNG — mulberry32, stolen verbatim from kernel-panic shared/rng.ts.
// Used OUTSIDE the sim (flawScript's apprentice-side hallucinations, tests).
// The sim itself uses the stateless hashNoise (shared/sim/noise.ts) so command
// timing can never desync its randomness. shared/ code must never call bare
// Math.random().

export type Rng = () => number // uniform [0, 1)

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
