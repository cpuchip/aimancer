// The ORACLE — deterministic script verification. Two layers:
//   1. staticCheck: unknown verb/field, wrong/missing params, out-of-bounds
//      values, impossible conditions. Pure function of the script.
//   2. oracle: staticCheck + a DRY-RUN against a snapshot of the workshop —
//      predicts the next-3-tick yield (or flags why it would sit idle).
// Every hallucination class flawScript can produce MUST go red here — that
// contract is enforced by smoke.ts. The oracle is the switch.

import { BOOST_RISK_PER_STEP, GREMLIN_MAX, MARKET_MAX, MARKET_MIN, TOKEN_CAP, TOKEN_REGEN, VERB_PARAMS } from './balance.ts'
import { condPasses, pressureAt, runVerb, stepMarket } from './world.ts'
import { CONDITION_FIELDS, CONDITION_OPS, VERBS, type Script, type SimState, type Verdict, type Workshop } from './types.ts'

export interface TickPrediction {
  tick: number
  ran: boolean // did the condition pass this tick?
  tokens: number // deltas the script itself would cause (regen excluded)
  matter: number
  widgets: number
}

export interface OracleReport extends Verdict {
  prediction: TickPrediction[] | null // null when the verdict is red
}

/** Inclusive value range a condition field can ever hold — for detecting
 * conditions that can never be true. */
function fieldRange(field: string): [number, number] {
  switch (field) {
    case 'tokens': return [0, TOKEN_CAP]
    case 'gremlin': return [0, GREMLIN_MAX]
    case 'market': return [MARKET_MIN, MARKET_MAX]
    default: return [0, Infinity] // matter, widgets, tick
  }
}

// ── Layer 1: static validation ───────────────────────────────────────────────

export function staticCheck(script: Script): Verdict {
  const reasons: string[] = []

  if (!(VERBS as readonly string[]).includes(script.verb)) {
    reasons.push(`unknown verb '${script.verb}' — known verbs: ${VERBS.join(', ')}`)
  } else {
    const specs = VERB_PARAMS[script.verb]
    const expected = specs.map((sp) => sp.name)
    for (const sp of specs) {
      const v = script.params[sp.name]
      if (v === undefined) {
        reasons.push(`missing param '${sp.name}' for ${script.verb}`)
        continue
      }
      if (!Number.isInteger(v)) {
        reasons.push(`param '${sp.name}' must be an integer (got ${v})`)
        continue
      }
      if (v < sp.min || v > sp.max) {
        reasons.push(`param '${sp.name}' = ${v} is out of bounds [${sp.min}..${sp.max}]${v === sp.max * 10 || v >= sp.max * 10 ? ' — off by 10x?' : ''}`)
      }
    }
    for (const k of Object.keys(script.params)) {
      if (!expected.includes(k)) {
        reasons.push(`unknown param '${k}' for ${script.verb} (expects: ${expected.join(', ')})`)
      }
    }
  }

  if (script.when !== undefined) {
    const c = script.when
    if (!(CONDITION_FIELDS as readonly string[]).includes(c.field)) {
      reasons.push(`unknown field '${c.field}' in condition — known fields: ${CONDITION_FIELDS.join(', ')}`)
    } else if (!(CONDITION_OPS as readonly string[]).includes(c.op)) {
      reasons.push(`unknown operator '${c.op}' in condition — known: ${CONDITION_OPS.join(' ')}`)
    } else if (!Number.isFinite(c.value)) {
      reasons.push(`condition value must be a finite number`)
    } else {
      const [lo, hi] = fieldRange(c.field)
      const impossible =
        (c.op === '<' && c.value <= lo) ||
        (c.op === '<=' && c.value < lo) ||
        (c.op === '>' && c.value >= hi) ||
        (c.op === '>=' && c.value > hi) ||
        (c.op === '==' && (c.value < lo || c.value > hi || !Number.isInteger(c.value)))
      if (impossible) {
        reasons.push(`condition can never be true (${c.field} is always within [${lo}..${hi === Infinity ? '∞' : hi}], so '${c.field} ${c.op} ${c.value}' never fires)`)
      }
    }
  }

  return { ok: reasons.length === 0, reasons }
}

// ── Layer 2: dry-run against a snapshot ──────────────────────────────────────

/** Full oracle: static verdict + a 3-tick dry-run prediction. Pure — the
 * caller's state is untouched. The prediction models THIS script alone against
 * the moving world schedules (other armed scripts hold still — a D1
 * simplification, noted in the report). */
export function oracle(s: SimState, player: number, script: Script, ticks = 3): OracleReport {
  const v = staticCheck(script)
  if (!v.ok) return { ...v, prediction: null }

  const src = s.players[player]
  const scratch: Workshop = {
    name: src?.name ?? 'dry-run',
    tokens: src?.tokens ?? 0,
    matter: src?.matter ?? 0,
    widgets: src?.widgets ?? 0,
    widgetsSold: 0,
    disasters: 0,
    uptime: 0,
    waste: 0,
    scripts: [],
  }
  let market = s.market
  const prediction: TickPrediction[] = []
  let ranCount = 0
  for (let i = 1; i <= ticks; i++) {
    const t = s.tick + i
    market = stepMarket(market, s.seed, t)
    const world = { tick: t, market, gremlin: pressureAt(t) }
    scratch.tokens = Math.min(TOKEN_CAP, scratch.tokens + TOKEN_REGEN)
    const before = { tokens: scratch.tokens, matter: scratch.matter, widgets: scratch.widgets }
    const ran = condPasses(world, scratch, script.when)
    if (ran) {
      runVerb(world, scratch, script, 1)
      ranCount++
    }
    prediction.push({
      tick: t,
      ran,
      tokens: scratch.tokens - before.tokens,
      matter: scratch.matter - before.matter,
      widgets: scratch.widgets - before.widgets,
    })
  }

  const notes: string[] = []
  if (ranCount === 0) {
    notes.push(`note: the condition holds it idle for the next ${ticks} ticks`)
  } else if (script.verb === 'sell' && prediction.every((pr) => pr.tokens === 0)) {
    notes.push('note: nothing to sell for the next ' + ticks + ' ticks (no widgets on hand)')
  } else if (script.verb === 'refine' && prediction.every((pr) => pr.widgets === 0)) {
    notes.push('note: not enough matter to refine for the next ' + ticks + ' ticks')
  }
  if (script.verb === 'boost') {
    const m = script.params['mult']
    const riskPct = Math.round(((m - 1) * BOOST_RISK_PER_STEP * 100) / 65536)
    notes.push(`note: boosts your other scripts ×${m}; ~${riskPct}% blowup risk per tick`)
  }

  return { ok: true, reasons: notes, prediction }
}
