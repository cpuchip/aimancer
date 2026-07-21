// Multiplayer knobs shared by the server and the client.
// seedFromCode adapted verbatim from kernel-panic shared/mpConfig.ts;
// PIN alphabet from chips server/tables.ts.

export const MAX_PLAYERS = 8 // workshop seats per room

/** World tick length (ms). ~25s absorbs LLM latency at show time; a room can
 * be started with a faster tick for dev (see TICK_MS_MIN/MAX clamps). */
export const TICK_MS_DEFAULT = 25_000
export const TICK_MS_MIN = 250 // fast enough for wstest, still a real interval
export const TICK_MS_MAX = 60_000

/** Per-round tick budgets (the 40-minute weave: round 1 "Naive" ~12 ticks,
 * round 2 "Verified" ~19). Host can override at start; dev-fast stays possible. */
export const ROUND1_TICKS_DEFAULT = 12
export const ROUND2_TICKS_DEFAULT = 19
export const ROUND_TICKS_MIN = 1
export const ROUND_TICKS_MAX = 999

/** Auto-advance (room setting `autoAdvance`, DEFAULT ON — pickup games flow;
 * the talk turns it off). When a round's tick budget is spent the room issues
 * the host `phase` command itself after a visible countdown; the intermission
 * gets a fixed dwell first so the summary is readable. Reveal never advances.
 * Server env AUTO_ADVANCE_MS / AUTO_DWELL_MS override (wstest runs fast). */
export const AUTO_ADVANCE_MS = 8_000
export const AUTO_DWELL_MS = 20_000

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
