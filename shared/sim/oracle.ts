// The ORACLE — deterministic verification of a REAL Starlark script. The
// engine dry-run itself happens SERVER-SIDE (server/engine.ts spawns the Go
// engine); this module is the pure half both sides share:
//   1. staticCheck: source-level checks that need no interpreter (size,
//      emptiness, obvious footguns).
//   2. judgeDryRun: given the engine's dry-run Response, decide the verdict —
//      compile/runtime errors are red, gas overruns are red, unknown or
//      out-of-schema actions are red, an action-less run is green-with-a-note
//      (a watcher script is legal).
// The verdict this produces enters the command log as DATA (oracleResult /
// deploy.verified) — replays re-apply the verdict, never the engine.

import { ACTION_TYPES, type Action, type Verdict } from './types.ts'
import { CONTRIBUTE_RATE_MAX, CRAFT_RATE_MAX, FARM_RATE_MAX, GATHER_RATE_MAX, SOURCE_MAX_BYTES, STORE_RATE_MAX, VEIN_ID_MAX } from './balance.ts'

// ── Layer 1: static source checks ───────────────────────────────────────────

export function staticCheck(source: string): Verdict {
  const reasons: string[] = []
  if (typeof source !== 'string' || source.trim().length === 0) reasons.push('empty script')
  else if (source.length > SOURCE_MAX_BYTES) reasons.push(`script too large (${source.length} bytes, max ${SOURCE_MAX_BYTES})`)
  return { ok: reasons.length === 0, reasons }
}

// ── Layer 2: judge one action against the sim's schema ──────────────────────

const STRUCTURES = ['wall', 'granary', 'beacon', 'ark'] as const

function intOf(a: Action, k: string): number | null {
  const v = a[k]
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null
}

/** Schema-check one emitted action (bounds; the world state is NOT consulted
 * — a dry-run can't know future stock). Returns reasons (empty = fine). */
export function checkAction(a: Action): string[] {
  const reasons: string[] = []
  if (!(ACTION_TYPES as readonly string[]).includes(a.type)) {
    reasons.push(`unknown action '${String(a.type)}' — known: ${ACTION_TYPES.join(', ')}`)
    return reasons
  }
  switch (a.type) {
    case 'gather': {
      const node = intOf(a, 'node')
      const rate = intOf(a, 'rate')
      if (node === null || node < 1 || node > VEIN_ID_MAX) reasons.push(`gather.node must be 1..${VEIN_ID_MAX} (got ${JSON.stringify(a['node'])})`)
      if (rate === null || rate < 1 || rate > GATHER_RATE_MAX) reasons.push(`gather.rate must be 1..${GATHER_RATE_MAX} (got ${JSON.stringify(a['rate'])})`)
      break
    }
    case 'farm': {
      const rate = intOf(a, 'rate')
      if (rate === null || rate < 1 || rate > FARM_RATE_MAX) reasons.push(`farm.rate must be 1..${FARM_RATE_MAX} (got ${JSON.stringify(a['rate'])})`)
      break
    }
    case 'craft': {
      const amount = intOf(a, 'amount')
      if (amount === null || amount < 1 || amount > CRAFT_RATE_MAX) reasons.push(`craft.amount must be 1..${CRAFT_RATE_MAX} (got ${JSON.stringify(a['amount'])})`)
      break
    }
    case 'contribute': {
      const st = a['structure']
      const amount = intOf(a, 'amount')
      if (typeof st !== 'string' || !(STRUCTURES as readonly string[]).includes(st)) reasons.push(`contribute.structure must be ${STRUCTURES.join('|')} (got ${JSON.stringify(st)})`)
      if (amount === null || amount < 1 || amount > CONTRIBUTE_RATE_MAX) reasons.push(`contribute.amount must be 1..${CONTRIBUTE_RATE_MAX} (got ${JSON.stringify(a['amount'])})`)
      break
    }
    case 'store': {
      const amount = intOf(a, 'amount')
      if (amount === null || amount < 1 || amount > STORE_RATE_MAX) reasons.push(`store.amount must be 1..${STORE_RATE_MAX} (got ${JSON.stringify(a['amount'])})`)
      break
    }
  }
  return reasons
}

// ── Layer 3: judge the engine's dry-run response ────────────────────────────

/** What the server's engine dry-run hands back for judgment. */
export interface DryRunOutput {
  actions: Action[]
  logs: string[]
  gasUsed: number
  err: string | null
}

export interface OracleReport extends Verdict {
  /** What the script WOULD do this tick — shown to the seat (own-seat info). */
  actions: Action[]
  logs: string[]
  gasUsed: number
}

/** The full verdict: static + engine result + per-action schema. Errors and
 * schema violations are red; an idle run is green with a note. */
export function judgeDryRun(source: string, out: DryRunOutput): OracleReport {
  const reasons: string[] = []
  const sc = staticCheck(source)
  reasons.push(...sc.reasons)
  if (out.err) {
    reasons.push(out.err.split('\n').slice(0, 3).join(' · ').slice(0, 300))
  }
  for (const a of out.actions) {
    for (const r of checkAction(a)) reasons.push(r)
  }
  const ok = reasons.length === 0
  const notes: string[] = []
  if (ok && out.actions.length === 0) notes.push('note: no actions this tick — a watcher script is legal, but is that what you meant?')
  return { ok, reasons: ok ? notes : reasons, actions: out.actions, logs: out.logs, gasUsed: out.gasUsed }
}
