// Pure world mechanics for the ARK settlement: seeded schedules (vein spawns,
// STORM schedule), milestone gating, and single-ACTION execution (the sim's
// tick and the oracle's action validation both lean on these). Everything here
// is a pure function of its inputs — no Date.now, no Math.random.

import {
  ARK_PARTS_REQUIRED,
  BEACON_PARTS_REQUIRED,
  CONTRIBUTE_RATE_MAX,
  CRAFT_RATE_MAX,
  FARM_RATE_MAX,
  GATHER_RATE_MAX,
  GRANARY_PARTS_REQUIRED,
  ORE_PER_PART,
  STORE_RATE_MAX,
  STORM_FIRST_TICK,
  STORM_JITTER,
  STORM_PERIOD,
  STORM_SEVERITY_BASE,
  STORM_SEVERITY_MAX,
  STORM_SEVERITY_RAMP,
  STRUCTURE_HP_PER_PART,
  VEIN_ID_MAX,
  VEIN_RATE_MAX,
  VEIN_RATE_MIN,
  VEIN_RESERVE_FACTOR_MAX,
  VEIN_RESERVE_FACTOR_MIN,
  VEIN_SPAWN_JITTER,
  VEIN_SPAWN_TICKS,
  VEINS_INITIAL,
  WALL_HP_MAX,
  WALL_HP_PER_PART,
  WALL_PARTS_REQUIRED,
} from './balance.ts'
import { hashNoise, SALT_STORM, SALT_VEIN } from './noise.ts'
import { MILESTONE_ORDER, type Action, type Dyad, type SharedStructure, type SimState, type StormSpec, type StructureKind, type VeinState } from './types.ts'

// ── Vein schedule (pure specs — kept from the depth update) ─────────────────

export interface VeinSpec {
  id: number
  spawnTick: number
  x: number
  y: number
  rate: number
  reserveMax: number
}

/** Everything about vein k EXCEPT its current reserve — pure f(seed, k). */
export function veinSpec(seed: number, k: number): VeinSpec {
  const rate = VEIN_RATE_MIN + (hashNoise(seed, k, SALT_VEIN + 1) % (VEIN_RATE_MAX - VEIN_RATE_MIN + 1))
  const factor = VEIN_RESERVE_FACTOR_MIN + (hashNoise(seed, k, SALT_VEIN + 2) % (VEIN_RESERVE_FACTOR_MAX - VEIN_RESERVE_FACTOR_MIN + 1))
  const spawnTick = k <= VEINS_INITIAL ? 0 : (k - VEINS_INITIAL) * VEIN_SPAWN_TICKS + (hashNoise(seed, k, SALT_VEIN + 5) % VEIN_SPAWN_JITTER)
  return {
    id: k,
    spawnTick,
    x: 6 + (hashNoise(seed, k, SALT_VEIN + 3) % 88), // scattered across the outer field
    y: 6 + (hashNoise(seed, k, SALT_VEIN + 4) % 50),
    rate,
    reserveMax: rate * factor,
  }
}

/** A fresh live vein from its spec. */
export function spawnVein(seed: number, k: number): VeinState {
  const sp = veinSpec(seed, k)
  return { id: sp.id, x: sp.x, y: sp.y, rate: sp.rate, reserve: sp.reserveMax, reserveMax: sp.reserveMax, spawnedAt: sp.spawnTick }
}

export { VEIN_ID_MAX }

// ── Storm schedule (pure f(seed, index) — the visible countdown's source) ───

/** Storm k (1-based): when it lands and how hard. Escalates by index. */
export function stormSpec(seed: number, k: number): StormSpec {
  const tick = STORM_FIRST_TICK + (k - 1) * STORM_PERIOD + (hashNoise(seed, k, SALT_STORM) % STORM_JITTER)
  const severity = Math.min(STORM_SEVERITY_MAX, STORM_SEVERITY_BASE + (k - 1) * STORM_SEVERITY_RAMP)
  return { index: k, tick, severity }
}

/** The NEXT storm strictly after `tick` — the countdown everyone watches. */
export function nextStorm(seed: number, tick: number): StormSpec {
  for (let k = 1; ; k++) {
    const sp = stormSpec(seed, k)
    if (sp.tick > tick) return sp
  }
}

/** The storm landing exactly at `tick`, if any. */
export function stormAt(seed: number, tick: number): StormSpec | null {
  for (let k = 1; ; k++) {
    const sp = stormSpec(seed, k)
    if (sp.tick === tick) return sp
    if (sp.tick > tick) return null
  }
}

// ── Structures + milestones ─────────────────────────────────────────────────

export function newStructures(): Record<StructureKind, SharedStructure> {
  const make = (kind: StructureKind, partsRequired: number, hpMax: number): SharedStructure => ({
    kind,
    parts: 0,
    partsRequired,
    complete: false,
    hp: 0,
    hpMax,
  })
  return {
    wall: make('wall', WALL_PARTS_REQUIRED, WALL_HP_MAX),
    granary: make('granary', GRANARY_PARTS_REQUIRED, GRANARY_PARTS_REQUIRED * STRUCTURE_HP_PER_PART),
    beacon: make('beacon', BEACON_PARTS_REQUIRED, BEACON_PARTS_REQUIRED * STRUCTURE_HP_PER_PART),
    ark: make('ark', ARK_PARTS_REQUIRED, ARK_PARTS_REQUIRED * STRUCTURE_HP_PER_PART),
  }
}

/** Milestones unlock in order: wall → granary → beacon → ark. A structure
 * accepts contributions only when every earlier milestone is complete. */
export function structureUnlocked(s: SimState, kind: StructureKind): boolean {
  const i = MILESTONE_ORDER.indexOf(kind)
  for (let j = 0; j < i; j++) {
    if (!s.structures[MILESTONE_ORDER[j]].complete) return false
  }
  return true
}

/** The current milestone frontier — the first incomplete structure (null when
 * the ark is built and the vote is the frontier). */
export function milestoneFrontier(s: SimState): StructureKind | null {
  for (const kind of MILESTONE_ORDER) {
    if (!s.structures[kind].complete) return kind
  }
  return null
}

// ── Action execution (one emitted action, validated + applied) ──────────────

function intParam(a: Action, name: string): number {
  const v = a[name]
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0
}

export interface ActionOutcome {
  applied: boolean
  note: string
  /** milestone completed by this action (the tick emits the room-wide event) */
  completed?: StructureKind
  contributed?: number
}

/** Execute ONE emitted action for one dyad. `gated` = may this action touch
 * shared structures (scope==='shared' — the scope boundary; FREEDOM UPDATE:
 * verification is storm armor, not a runtime lock)?
 * Mutates dyad / veins / structures / granaryFood via `s`. Deterministic. */
export function runAction(s: SimState, d: Dyad, a: Action, gated: boolean): ActionOutcome {
  switch (a.type) {
    case 'gather': {
      const node = intParam(a, 'node')
      const vein = s.veins.find((v) => v.id === node)
      if (!vein) return { applied: false, note: `no vein #${node} here (yet)` }
      if (vein.reserve <= 0) return { applied: false, note: `vein #${node} is dry — re-target` }
      const n = Math.max(0, Math.min(intParam(a, 'rate'), GATHER_RATE_MAX, vein.rate, vein.reserve))
      if (n <= 0) return { applied: false, note: `gather rate must be 1..${GATHER_RATE_MAX}` }
      vein.reserve -= n
      d.ore += n
      return { applied: true, note: `+${n} ore from vein #${node}` }
    }
    case 'farm': {
      const n = Math.max(0, Math.min(intParam(a, 'rate'), FARM_RATE_MAX))
      if (n <= 0) return { applied: false, note: `farm rate must be 1..${FARM_RATE_MAX}` }
      d.food += n
      return { applied: true, note: `+${n} food` }
    }
    case 'craft': {
      const want = Math.max(0, Math.min(intParam(a, 'amount'), CRAFT_RATE_MAX))
      if (want <= 0) return { applied: false, note: `craft amount must be 1..${CRAFT_RATE_MAX}` }
      const n = Math.min(want, Math.floor(d.ore / ORE_PER_PART))
      if (n <= 0) return { applied: false, note: `starved — a part needs ${ORE_PER_PART} ore` }
      d.ore -= n * ORE_PER_PART
      d.parts += n
      return { applied: true, note: `+${n} part${n === 1 ? '' : 's'} (${n * ORE_PER_PART} ore)` }
    }
    case 'contribute': {
      const kind = a['structure']
      if (kind !== 'wall' && kind !== 'granary' && kind !== 'beacon' && kind !== 'ark') {
        return { applied: false, note: `unknown structure '${String(kind)}' — wall|granary|beacon|ark` }
      }
      if (!gated) return { applied: false, note: `GATE: contribute refused — district scripts stay home; deploy with scope='shared' to touch the shared works` }
      if (!structureUnlocked(s, kind)) return { applied: false, note: `${kind} is locked — finish the earlier milestone first` }
      const st = s.structures[kind]
      const wantRaw = Math.max(0, Math.min(intParam(a, 'amount'), CONTRIBUTE_RATE_MAX))
      if (wantRaw <= 0) return { applied: false, note: `contribute amount must be 1..${CONTRIBUTE_RATE_MAX}` }
      // over-contribution only makes sense on the wall (HP repair); elsewhere cap at need
      const room = kind === 'wall' ? (st.hp >= st.hpMax && st.complete ? 0 : wantRaw) : Math.max(0, st.partsRequired - st.parts)
      const n = Math.min(wantRaw, d.parts, room === 0 ? 0 : room)
      if (n <= 0) {
        return { applied: false, note: d.parts <= 0 ? 'no parts to contribute' : `${kind} needs nothing more` }
      }
      d.parts -= n
      d.contributed += n
      st.parts += n
      if (kind === 'wall') st.hp = Math.min(st.hpMax, st.hp + n * WALL_HP_PER_PART)
      else st.hp = Math.min(st.hpMax, st.hp + n * STRUCTURE_HP_PER_PART)
      let completed: StructureKind | undefined
      if (!st.complete && st.parts >= st.partsRequired) {
        st.complete = true
        completed = kind
      }
      return { applied: true, note: `+${n} part${n === 1 ? '' : 's'} → ${kind}`, completed, contributed: n }
    }
    case 'store': {
      if (!gated) return { applied: false, note: `GATE: store refused — the granary is shared; deploy with scope='shared' to stock it` }
      if (!s.structures.granary.complete) return { applied: false, note: 'the granary is not built yet' }
      const n = Math.max(0, Math.min(intParam(a, 'amount'), STORE_RATE_MAX, d.food))
      if (n <= 0) return { applied: false, note: d.food <= 0 ? 'no food to store' : `store amount must be 1..${STORE_RATE_MAX}` }
      d.food -= n
      s.granaryFood += n
      return { applied: true, note: `+${n} food → granary` }
    }
    default:
      return { applied: false, note: `unknown action '${String(a.type)}' — the settlement doesn't know that move` }
  }
}
