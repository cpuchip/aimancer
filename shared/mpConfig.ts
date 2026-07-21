// Multiplayer knobs shared by the server and the client — ARK PIVOT.
// seedFromCode adapted verbatim from kernel-panic shared/mpConfig.ts;
// PIN alphabet from chips server/tables.ts. Seat cap lives in
// shared/sim/balance.ts (MAX_DYADS) — the sim owns it.

/** World tick length (ms). The ark game runs server-side scripts, so the
 * tick no longer waits on an LLM: 5s default keeps the settlement alive for
 * a ~30-45 min meeting arc; tickMs=1000 makes a ~10-minute fast room. */
export const TICK_MS_DEFAULT = 5_000
export const TICK_MS_MIN = 250 // fast enough for wstest, still a real interval
export const TICK_MS_MAX = 60_000

/** PIN alphabet — no I/O, read-aloud friendly (chips' CODE_ALPHABET). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export const CODE_LENGTH = 4

/** Deterministic seed from a room code — same room code → same world.
 * FNV-1a, stolen verbatim from kernel-panic. */
export function seedFromCode(code: string): number {
  let h = 2166136261
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 0x7fffffff || 1
}
