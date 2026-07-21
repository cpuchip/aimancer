// Pure world mechanics shared by the sim's tick AND the oracle's dry-run:
// the seeded schedules (market drift, gremlin pressure/spikes, vein spawns,
// rush windows, contract offers), condition evaluation, and single-verb
// execution. Everything here is a pure function of its inputs — no Date.now,
// no Math.random.

import {
  CHARM_MARKET_MAX,
  CHARM_MARKET_MIN,
  CHARM_MARKET_SHIFT_TICKS,
  CHARM_MARKET_STEP_MAX,
  CONTRACT_BONUS_PER_CHARM,
  CONTRACT_BONUS_PER_WIDGET,
  CONTRACT_FIRST_TICK,
  CONTRACT_PENALTY,
  CONTRACT_PERIOD,
  CONTRACT_QTY_CHARMS_MAX,
  CONTRACT_QTY_CHARMS_MIN,
  CONTRACT_QTY_WIDGETS_MAX,
  CONTRACT_QTY_WIDGETS_MIN,
  CONTRACT_WINDOW_TICKS,
  CRAFT_MATTER_PER_CHARM,
  CRAFT_WIDGETS_PER_CHARM,
  GREMLIN_MAX,
  GREMLIN_RAMP_TICKS,
  MARKET_MAX,
  MARKET_MIN,
  MARKET_SHIFT_TICKS,
  REFINE_RATIO,
  RUSH_FIRST_TICK,
  RUSH_LEN,
  RUSH_MULT_MAX,
  RUSH_MULT_MIN,
  RUSH_PERIOD,
  SPIKE_CHANCE_PER_PRESSURE,
  TOKEN_CAP,
  VEIN_ID_MAX,
  VEIN_RATE_MAX,
  VEIN_RATE_MIN,
  VEIN_RESERVE_FACTOR_MAX,
  VEIN_RESERVE_FACTOR_MIN,
  VEIN_SPAWN_JITTER,
  VEIN_SPAWN_TICKS,
  VEINS_INITIAL,
} from './balance.ts'
import { hashNoise, SALT_CHARM_MARKET, SALT_CONTRACT, SALT_MARKET, SALT_RUSH, SALT_SPIKE, SALT_VEIN } from './noise.ts'
import type { Good, Script, VeinState, Workshop } from './types.ts'

/** The slice of the world the verbs and conditions read. `market` and
 * `marketCharms` are the EFFECTIVE prices right now (rush already applied by
 * the caller) — the tick applies rushAt; the oracle's dry-run deliberately
 * passes BASE prices only (market events are the humans' to see). */
export interface WorldView {
  tick: number
  market: number
  marketCharms: number
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

/** Widget market drift: every MARKET_SHIFT_TICKS the BASE rate steps −1/0/+1. */
export function stepMarket(prev: number, seed: number, tick: number): number {
  if (tick % MARKET_SHIFT_TICKS !== 0) return prev
  const step = (hashNoise(seed, tick, SALT_MARKET) % 3) - 1
  return Math.max(MARKET_MIN, Math.min(MARKET_MAX, prev + step))
}

/** Charm market drift: its own lane, livelier steps (−2..+2), offset by 2
 * ticks so the two goods never move in lockstep. */
export function stepCharmMarket(prev: number, seed: number, tick: number): number {
  if (tick % CHARM_MARKET_SHIFT_TICKS !== 2) return prev
  const step = (hashNoise(seed, tick, SALT_CHARM_MARKET) % (2 * CHARM_MARKET_STEP_MAX + 1)) - CHARM_MARKET_STEP_MAX
  return Math.max(CHARM_MARKET_MIN, Math.min(CHARM_MARKET_MAX, prev + step))
}

// ── RUSH windows (the asymmetry mechanic — see balance.ts) ───────────────────

export interface Rush {
  good: Good
  mult: number
  startTick: number
  endTick: number // inclusive
}

/** The rush active at `tick`, or null. Pure f(seed, tick): window w opens at
 * RUSH_FIRST_TICK + w×RUSH_PERIOD for RUSH_LEN ticks; good and mult are
 * seeded per window. Same seed → same rushes — round 2 replays round 1's. */
export function rushAt(seed: number, tick: number): Rush | null {
  if (tick < RUSH_FIRST_TICK) return null
  const w = Math.floor((tick - RUSH_FIRST_TICK) / RUSH_PERIOD)
  const start = RUSH_FIRST_TICK + w * RUSH_PERIOD
  if (tick >= start + RUSH_LEN) return null
  const good: Good = hashNoise(seed, w, SALT_RUSH) % 2 === 0 ? 'widgets' : 'charms'
  const mult = RUSH_MULT_MIN + (hashNoise(seed, w, SALT_RUSH + 1) % (RUSH_MULT_MAX - RUSH_MULT_MIN + 1))
  return { good, mult, startTick: start, endTick: start + RUSH_LEN - 1 }
}

/** Ticks until the NEXT rush window opens after `tick` (board forecast). */
export function nextRushInTicks(tick: number): number {
  if (tick < RUSH_FIRST_TICK) return RUSH_FIRST_TICK - tick
  const w = Math.floor((tick - RUSH_FIRST_TICK) / RUSH_PERIOD)
  return RUSH_FIRST_TICK + (w + 1) * RUSH_PERIOD - tick
}

/** Effective price of a good right now: base × the active rush multiplier. */
export function effectivePrice(seed: number, tick: number, base: number, good: Good): number {
  const rush = rushAt(seed, tick)
  return rush && rush.good === good ? base * rush.mult : base
}

// ── Vein schedule (pure specs — prospect and replay both lean on this) ───────

export interface VeinSpec {
  id: number
  spawnTick: number
  x: number
  y: number
  rate: number
  reserveMax: number
}

/** Everything about vein k EXCEPT its current reserve — pure f(seed, k), so a
 * prospect can reveal a vein before it surfaces and the round-2 reseed replays
 * the identical field. */
export function veinSpec(seed: number, k: number): VeinSpec {
  const rate = VEIN_RATE_MIN + (hashNoise(seed, k, SALT_VEIN + 1) % (VEIN_RATE_MAX - VEIN_RATE_MIN + 1))
  const factor = VEIN_RESERVE_FACTOR_MIN + (hashNoise(seed, k, SALT_VEIN + 2) % (VEIN_RESERVE_FACTOR_MAX - VEIN_RESERVE_FACTOR_MIN + 1))
  const spawnTick = k <= VEINS_INITIAL ? 0 : (k - VEINS_INITIAL) * VEIN_SPAWN_TICKS + (hashNoise(seed, k, SALT_VEIN + 5) % VEIN_SPAWN_JITTER)
  return {
    id: k,
    spawnTick,
    x: 8 + (hashNoise(seed, k, SALT_VEIN + 3) % 58), // crystal-fields band, left of the stalls
    y: 8 + (hashNoise(seed, k, SALT_VEIN + 4) % 40),
    rate,
    reserveMax: rate * factor,
  }
}

/** A fresh live vein from its spec. */
export function spawnVein(seed: number, k: number): VeinState {
  const sp = veinSpec(seed, k)
  return { id: sp.id, x: sp.x, y: sp.y, rate: sp.rate, reserve: sp.reserveMax, reserveMax: sp.reserveMax, spawnedAt: sp.spawnTick }
}

/** The id of the next vein that has NOT yet surfaced at `tick` (what a
 * prospect reveals), or null when the field is fully surfaced. */
export function nextVeinId(seed: number, tick: number): number | null {
  for (let k = VEINS_INITIAL + 1; k <= VEIN_ID_MAX; k++) {
    if (veinSpec(seed, k).spawnTick > tick) return k
  }
  return null
}

// ── Contract offer schedule (round-2 ticks; pure specs) ──────────────────────

export interface ContractSpec {
  id: number
  offerTick: number
  good: Good
  qty: number
  windowTicks: number
  bonus: number
  penalty: number
}

export function contractSpec(seed: number, j: number): ContractSpec {
  const good: Good = hashNoise(seed, j, SALT_CONTRACT) % 2 === 0 ? 'widgets' : 'charms'
  const qty =
    good === 'widgets'
      ? CONTRACT_QTY_WIDGETS_MIN + (hashNoise(seed, j, SALT_CONTRACT + 1) % (CONTRACT_QTY_WIDGETS_MAX - CONTRACT_QTY_WIDGETS_MIN + 1))
      : CONTRACT_QTY_CHARMS_MIN + (hashNoise(seed, j, SALT_CONTRACT + 1) % (CONTRACT_QTY_CHARMS_MAX - CONTRACT_QTY_CHARMS_MIN + 1))
  return {
    id: j,
    offerTick: CONTRACT_FIRST_TICK + (j - 1) * CONTRACT_PERIOD,
    good,
    qty,
    windowTicks: CONTRACT_WINDOW_TICKS,
    bonus: qty * (good === 'widgets' ? CONTRACT_BONUS_PER_WIDGET : CONTRACT_BONUS_PER_CHARM),
    penalty: CONTRACT_PENALTY,
  }
}

// ── Conditions ───────────────────────────────────────────────────────────────

export function fieldValue(world: WorldView, w: Workshop, field: string): number {
  switch (field) {
    case 'tokens': return w.tokens
    case 'matter': return w.matter
    case 'widgets': return w.widgets
    case 'charms': return w.charms
    case 'gremlin': return world.gremlin
    case 'market': return world.market
    case 'marketCharms': return world.marketCharms
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

/** Numeric param access for statically-valid scripts. */
function num(script: Script, name: string): number {
  const v = script.params[name]
  return typeof v === 'number' ? v : 0
}

/** Which good a sell script moves (the optional enum param, default widgets). */
export function sellGood(script: Script): Good {
  return script.params['good'] === 'charms' ? 'charms' : 'widgets'
}

/** Execute one verb for one workshop this tick. The script must already be
 * statically valid and its condition must have passed. `mult` is the active
 * boost multiplier; `veins` is the LIVE shared vein list (the tick passes the
 * real one and the oracle's dry-run passes a scratch copy — harvest drains
 * reserve). Returns the patch strength contributed (patch verb only).
 * Mutates `w` (and the bound vein's reserve). */
export function runVerb(world: WorldView, w: Workshop, script: Script, mult: number, veins: VeinState[]): number {
  switch (script.verb) {
    case 'harvest': {
      const vein = veins.find((v) => v.id === num(script, 'node'))
      if (!vein || vein.reserve <= 0) return 0 // no vein here / ran dry — idles (lastRun explains)
      const n = Math.min(num(script, 'rate') * mult, vein.rate * mult, vein.reserve)
      vein.reserve -= n
      w.matter += n
      return 0
    }
    case 'refine': {
      const n = Math.min(num(script, 'rate'), Math.floor(w.matter / REFINE_RATIO))
      if (n > 0) {
        w.matter -= n * REFINE_RATIO
        w.widgets += n * mult // inventory only — a widget scores when it SELLS
      }
      return 0
    }
    case 'craft': {
      const n = Math.min(
        num(script, 'rate'),
        Math.floor(w.matter / CRAFT_MATTER_PER_CHARM),
        Math.floor(w.widgets / CRAFT_WIDGETS_PER_CHARM),
      )
      if (n > 0) {
        w.matter -= n * CRAFT_MATTER_PER_CHARM
        w.widgets -= n * CRAFT_WIDGETS_PER_CHARM
        w.charms += n * mult // inventory only — a charm scores when it SELLS
      }
      return 0
    }
    case 'sell': {
      const good = sellGood(script)
      const have = good === 'charms' ? w.charms : w.widgets
      const n = Math.min(num(script, 'amount'), have)
      if (n > 0) {
        const price = good === 'charms' ? world.marketCharms : world.market
        if (good === 'charms') {
          w.charms -= n
          w.charmsSold += n
        } else {
          w.widgets -= n
          w.widgetsSold += n
        }
        w.tokens = Math.min(TOKEN_CAP, w.tokens + n * price) // over the cap is wasted — it's a rate limit
      }
      return 0
    }
    case 'patch': {
      return num(script, 'strength')
    }
    case 'boost': {
      return 0 // the boost pass handles multipliers and blowups
    }
  }
  return 0
}
