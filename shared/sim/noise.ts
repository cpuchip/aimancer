// Stateless seeded noise — the sim's ONLY randomness source. A pure hash of
// (seed, tick, salt) means the gremlin schedule, market drift, and blowup
// rolls are identical no matter how commands interleave with ticks: stronger
// determinism than a stateful PRNG (kernel-panic's mulberry32 advances with
// use; ours cannot be advanced at all). murmur3-finalizer mixing.

/** Uniform uint32 from (seed, tick, salt). Pure, deterministic. */
export function hashNoise(seed: number, tick: number, salt: number): number {
  let h = seed >>> 0
  h = mix(h ^ Math.imul((tick + 0x9e3779b9) | 0, 0x85ebca6b))
  h = mix(h ^ Math.imul((salt + 0x7f4a7c15) | 0, 0xc2b2ae35))
  return h
}

function mix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** FNV-1a over a string → uint32 salt (per-script rolls). */
export function saltOf(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Fixed salts — one lane per random decision so lanes never collide.
export const SALT_MARKET = 101
export const SALT_SPIKE = 202
export const SALT_CORRUPT_PICK = 303
export const SALT_CORRUPT_FLAW = 404
export const SALT_CHARM_MARKET = 505
export const SALT_VEIN = 606 // +1..+5 sub-lanes: rate, factor, x, y, spawn jitter
export const SALT_RUSH = 707 // +1 sub-lane: mult
export const SALT_CONTRACT = 808 // +1..+2 sub-lanes: qty, good
