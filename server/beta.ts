// The MIRROR YARD — the beta env (FREEDOM UPDATE). Fork the CURRENT world
// state, run a candidate script through the REAL engine for N ticks, and hand
// back a private report: yields, failures, storm interaction if one lands in
// the window. staging-env as gameplay, oracle-as-service.
//
// NO effect on the real world and NOT in the command log — a beta run is a
// QUERY. (The ⚡ cost alone is logged, as a `spend` command, because the
// economy is sim state and must replay.) Deterministic by construction: the
// engine is deterministic and the fork advances by the same pure tick() the
// live room uses — same fork + same script ⇒ byte-identical report, proven
// by wstest.
//
// Honest mirror, one deliberate simplification: OTHER deployed scripts idle
// in the fork (their actions are live-engine output we don't re-run — the
// same actions-as-data ruling replays follow). The world itself moves: veins
// drain only under YOUR candidate, regen/spawns/storms/survivors all run.

import { checkAction } from '../shared/sim/oracle.ts'
import { apply, tick } from '../shared/sim/sim.ts'
import { milestoneFrontier, nextStorm } from '../shared/sim/world.ts'
import { SCRIPT_GAS_LIMIT, SCRIPT_RUN_COST } from '../shared/sim/balance.ts'
import type { Action, DeployedScript, ScriptScope, SimEvent, SimState } from '../shared/sim/types.ts'
import type { BetaReport, BetaTickView } from '../shared/protocol.ts'
import type { EngineHost } from './engine.ts'

/** FNV-1a of a script source — the beta-pass ledger key (a gate-policy
 * 'beta-pass' requirement matches on EXACTLY this hash + scope). */
export function hashSource(source: string): string {
  let h = 2166136261
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** The world exactly as seat `p`'s scripts see it at s.tick — shared by the
 * live tick loop, the oracle dry-run, and the Mirror Yard (one truth, three
 * consumers). `extra` carries per-seat hidden world-fields (discovery pays
 * forward — see server/registry.ts). */
export function worldViewOf(s: SimState, p: number, extra?: Record<string, unknown>): Record<string, unknown> {
  const d = s.dyads[p]
  const next = nextStorm(s.seed, s.tick)
  return {
    tick: s.tick,
    district: p,
    you: d ? { tokens: d.tokens, ore: d.ore, food: d.food, parts: d.parts, integrity: d.integrity } : null,
    veins: s.veins.map((v) => ({ id: v.id, rate: v.rate, reserve: v.reserve })),
    structures: Object.fromEntries(
      (['wall', 'granary', 'beacon', 'ark'] as const).map((k) => {
        const st = s.structures[k]
        return [k, { parts: st.parts, required: st.partsRequired, complete: st.complete, hp: st.hp, hpMax: st.hpMax }]
      }),
    ),
    granaryFood: s.granaryFood,
    survivors: s.survivors,
    storm: { inTicks: next.tick - s.tick, severity: next.severity },
    frontier: milestoneFrontier(s),
    dyads: s.dyads.map((x) => ({ name: x.name, district: x.district, parts: x.parts, contributed: x.contributed })),
    ...(extra ?? {}),
  }
}

const BETA_SCRIPT_ID = '__beta'

export interface BetaRunInput {
  sim: SimState // the LIVE state — forked here, never mutated
  seat: number
  source: string
  scope: ScriptScope
  ticks: number
  seed: number
  engine: EngineHost
  /** per-seat hidden world-fields (same ones the live runs would see) */
  worldExtra?: Record<string, unknown>
  /** Hidden-verb hook: return a lore line to strip+record the action, null to
   * leave it for the sim's honest "unknown action" note. Discovery side
   * effects (chronicle, notices) belong to the caller — the fork stays pure. */
  onHiddenVerb?: (actionType: string) => string | null
}

/** Run the candidate in a fork of the live world. Throws only on an ENGINE
 * FAULT (timeout/crash) — a script error is a report line, not an exception. */
export async function runBetaFork(input: BetaRunInput): Promise<BetaReport> {
  const fork = structuredClone(input.sim) as SimState
  const d = fork.dyads[input.seat]
  if (!d) throw new Error('no such dyad')
  const script: DeployedScript = {
    id: BETA_SCRIPT_ID,
    name: 'beta candidate',
    source: input.source,
    scope: input.scope,
    verified: false, // the candidate rehearses UNVERIFIED — storm math shows the true price
    lastVerdict: null,
    status: 'running',
    deployedAtTick: fork.tick,
    lastTick: null,
    errStreak: 0,
  }
  d.scripts.push(script)

  const fromTick = fork.tick
  const before = { ore: d.ore, food: d.food, parts: d.parts, contributed: d.contributed, granaryFood: fork.granaryFood }
  const perTick: BetaTickView[] = []
  const failures: string[] = []
  const lore: string[] = []
  let storm: BetaReport['storm'] = null
  let memory: Record<string, unknown> = {}

  for (let i = 0; i < input.ticks; i++) {
    if (d.tokens < SCRIPT_RUN_COST) {
      apply(fork, { t: 'scriptTick', player: input.seat, id: BETA_SCRIPT_ID, actions: [], gasUsed: 0, starved: true })
    } else {
      const out = await input.engine.run({
        script: input.source,
        world: worldViewOf(fork, input.seat, input.worldExtra),
        seed: input.seed,
        tick: fork.tick,
        gasLimit: SCRIPT_GAS_LIMIT,
        memory,
      })
      memory = out.memory ?? {}
      const kept: Action[] = []
      for (const a of out.actions) {
        const loreLine = input.onHiddenVerb?.(String(a.type))
        if (loreLine) {
          if (!lore.includes(loreLine)) lore.push(loreLine)
          continue
        }
        for (const r of checkAction(a)) {
          const line = `tick ${fork.tick}: ${r}`
          if (!failures.includes(line)) failures.push(line)
        }
        kept.push(a)
      }
      if (out.err) failures.push(`tick ${fork.tick}: ${out.err.split('\n')[0].slice(0, 200)}`)
      apply(fork, {
        t: 'scriptTick',
        player: input.seat,
        id: BETA_SCRIPT_ID,
        actions: kept,
        gasUsed: out.gasUsed,
        logs: out.logs.slice(0, 10),
        ...(out.err ? { err: out.err } : {}),
      })
    }
    const lt = d.scripts.find((x) => x.id === BETA_SCRIPT_ID)?.lastTick
    if (lt) perTick.push({ tick: lt.tick, ran: lt.ran, note: lt.note, gasUsed: lt.gasUsed, err: lt.err, logs: lt.logs })
    tick(fork)
    const landed = fork.events.find((e): e is Extract<SimEvent, { t: 'stormLanded' }> => e.t === 'stormLanded')
    if (landed && !storm) {
      storm = { index: landed.index, severity: landed.severity, atTick: fork.tick, absorbed: landed.absorbed, yourDamage: landed.damage[input.seat] ?? 0 }
    }
  }

  return {
    ok: failures.length === 0,
    scope: input.scope,
    fromTick,
    ticks: input.ticks,
    failures,
    lore,
    perTick,
    totals: {
      ore: d.ore - before.ore,
      food: d.food - before.food,
      parts: d.parts - before.parts,
      contributed: d.contributed - before.contributed,
      granaryFood: fork.granaryFood - before.granaryFood,
    },
    storm,
    sourceHash: hashSource(input.source),
  }
}
