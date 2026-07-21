// Pure world mechanics shared by the sim's tick AND the oracle's dry-run:
// the seeded schedules (market drift, gremlin pressure/spikes), condition
// evaluation, and single-verb execution. Everything here is a pure function of
// its inputs — no Date.now, no Math.random.

import {
  GREMLIN_MAX,
  GREMLIN_RAMP_TICKS,
  MARKET_MAX,
  MARKET_MIN,
  MARKET_SHIFT_TICKS,
  REFINE_RATIO,
  SPIKE_CHANCE_PER_PRESSURE,
  TOKEN_CAP,
} from './balance.ts'
import { hashNoise, SALT_MARKET, SALT_SPIKE } from './noise.ts'
import type { Script, Workshop } from './types.ts'

/** The slice of SimState the schedules and conditions read. */
export interface WorldView {
  tick: number
  market: number
  gremlin: number
}

// ── Seeded schedules ─────────────────────────────────────────────────────────

/** Gremlin pressure ramps on a fixed schedule; spikes ride on top of it. */
export function pressureAt(tick: number): number {
  return Math.min(GREMLIN_MAX, Math.floor(tick / GREMLIN_RAMP_TICKS))
}

/** Does the shared gremlin track spike this tick? Seeded, stateless. */
export function spikeAt(seed: number, tick: number, pressure: number): boolean {
  if (pressure <= 0) return false
  return hashNoise(seed, tick, SALT_SPIKE) % 65536 < pressure * SPIKE_CHANCE_PER_PRESSURE
}

/** Market drift: every MARKET_SHIFT_TICKS the rate steps -1/0/+1, seeded. */
export function stepMarket(prev: number, seed: number, tick: number): number {
  if (tick % MARKET_SHIFT_TICKS !== 0) return prev
  const step = (hashNoise(seed, tick, SALT_MARKET) % 3) - 1
  return Math.max(MARKET_MIN, Math.min(MARKET_MAX, prev + step))
}

// ── Conditions ───────────────────────────────────────────────────────────────

export function fieldValue(world: WorldView, w: Workshop, field: string): number {
  switch (field) {
    case 'tokens': return w.tokens
    case 'matter': return w.matter
    case 'widgets': return w.widgets
    case 'gremlin': return world.gremlin
    case 'market': return world.market
    case 'tick': return world.tick
    default: return 0 // unreachable for statically-valid scripts
  }
}

export function condPasses(world: WorldView, w: Workshop, when?: Script['when']): boolean {
  if (!when) return true
  const v = fieldValue(world, w, when.field)
  switch (when.op) {
    case '<': return v < when.value
    case '<=': return v <= when.value
    case '>': return v > when.value
    case '>=': return v >= when.value
    case '==': return v === when.value
    default: return false
  }
}

// ── Verb execution ───────────────────────────────────────────────────────────

/** Execute one verb for one workshop this tick. The script must already be
 * statically valid and its condition must have passed. `mult` is the active
 * boost multiplier. Returns the patch strength contributed (patch verb only).
 * Mutates `w`. */
export function runVerb(world: WorldView, w: Workshop, script: Script, mult: number): number {
  switch (script.verb) {
    case 'harvest': {
      w.matter += script.params['rate'] * mult
      return 0
    }
    case 'refine': {
      const n = Math.min(script.params['rate'], Math.floor(w.matter / REFINE_RATIO))
      if (n > 0) {
        w.matter -= n * REFINE_RATIO
        const produced = n * mult
        w.widgets += produced
        w.widgetsShipped += produced
      }
      return 0
    }
    case 'sell': {
      const n = Math.min(script.params['amount'], w.widgets)
      if (n > 0) {
        w.widgets -= n
        w.tokens = Math.min(TOKEN_CAP, w.tokens + n * world.market) // over the cap is wasted — it's a rate limit
      }
      return 0
    }
    case 'patch': {
      return script.params['strength']
    }
    case 'boost': {
      return 0 // the boost pass handles multipliers and blowups
    }
  }
  return 0
}
