// The ORACLE — deterministic script verification. Two layers:
//   1. staticCheck: unknown verb/field, wrong/missing params, out-of-bounds
//      values, bad vein ids, phantom goods, impossible conditions. Pure
//      function of the script.
//   2. oracle: staticCheck + a DRY-RUN against a snapshot of the workshop —
//      predicts the next-3-tick yield (or flags why it would sit idle), models
//      the bound vein's reserve ("vein exhausts in ~5"), and quotes BASE
//      prices ONLY: market events (rushes) are announced on the room board,
//      never through this API — the asymmetry is a rule, not an oversight.
// Every hallucination class flawScript can produce MUST go red here — that
// contract is enforced by smoke.ts. The oracle is the switch.

import {
  BOOST_RISK_PER_STEP,
  CHARM_MARKET_MAX,
  CHARM_MARKET_MIN,
  CRAFT_MATTER_PER_CHARM,
  CRAFT_WIDGETS_PER_CHARM,
  GREMLIN_MAX,
  MARKET_MAX,
  MARKET_MIN,
  RUSH_MULT_MAX,
  TOKEN_CAP,
  TOKEN_REGEN,
  VERB_PARAMS,
} from './balance.ts'
import { condPasses, pressureAt, runVerb, sellGood, stepCharmMarket, stepMarket } from './world.ts'
import { CONDITION_FIELDS, CONDITION_OPS, VERBS, type Script, type SimState, type VeinState, type Verdict, type Workshop } from './types.ts'

export interface TickPrediction {
  tick: number
  ran: boolean // did the condition pass this tick?
  tokens: number // deltas the script itself would cause (regen excluded)
  matter: number
  widgets: number
  charms: number
}

export interface OracleReport extends Verdict {
  prediction: TickPrediction[] | null // null when the verdict is red
}

/** Inclusive value range a condition field can ever hold — for detecting
 * conditions that can never be true. Market fields range up to max × the top
 * rush multiplier (conditions read EFFECTIVE prices — a sell gate above base
 * max can legitimately fire during a rush the board announced). */
function fieldRange(field: string): [number, number] {
  switch (field) {
    case 'tokens': return [0, TOKEN_CAP]
    case 'gremlin': return [0, GREMLIN_MAX]
    case 'market': return [MARKET_MIN, MARKET_MAX * RUSH_MULT_MAX]
    case 'marketCharms': return [CHARM_MARKET_MIN, CHARM_MARKET_MAX * RUSH_MULT_MAX]
    default: return [0, Infinity] // matter, widgets, charms, tick
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
        if (!sp.optional) reasons.push(`missing param '${sp.name}' for ${script.verb}`)
        continue
      }
      if (sp.values) {
        if (typeof v !== 'string' || !sp.values.includes(v)) {
          reasons.push(`param '${sp.name}' must be one of ${sp.values.join('|')} (got ${JSON.stringify(v)})`)
        }
        continue
      }
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        reasons.push(`param '${sp.name}' must be an integer (got ${JSON.stringify(v)})`)
        continue
      }
      const min = sp.min ?? 0
      const max = sp.max ?? Infinity
      if (v < min || v > max) {
        reasons.push(`param '${sp.name}' = ${v} is out of bounds [${min}..${max}]${v === max * 10 || v >= max * 10 ? ' — off by 10x?' : ''}`)
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
 * simplification, noted in the report). Harvest drains a SCRATCH copy of the
 * bound vein; prices are BASE drift only — rush windows live on the board. */
export function oracle(s: SimState, player: number, script: Script, ticks = 3): OracleReport {
  const v = staticCheck(script)
  if (!v.ok) return { ...v, prediction: null }

  const src = s.players[player]
  const scratch: Workshop = {
    name: src?.name ?? 'dry-run',
    tokens: src?.tokens ?? 0,
    matter: src?.matter ?? 0,
    widgets: src?.widgets ?? 0,
    charms: src?.charms ?? 0,
    widgetsSold: 0,
    charmsSold: 0,
    contractScore: 0,
    prospects: [],
    disasters: 0,
    uptime: 0,
    waste: 0,
    scripts: [],
    pending: [],
  }
  const scratchVeins: VeinState[] = s.veins.map((vn) => ({ ...vn }))
  let market = s.market
  let marketCharms = s.marketCharms
  const prediction: TickPrediction[] = []
  let ranCount = 0
  for (let i = 1; i <= ticks; i++) {
    const t = s.tick + i
    market = stepMarket(market, s.seed, t)
    marketCharms = stepCharmMarket(marketCharms, s.seed, t)
    // BASE prices on purpose — the rush forecast is the humans' information
    const world = { tick: t, market, marketCharms, gremlin: pressureAt(t) }
    scratch.tokens = Math.min(TOKEN_CAP, scratch.tokens + TOKEN_REGEN)
    const before = { tokens: scratch.tokens, matter: scratch.matter, widgets: scratch.widgets, charms: scratch.charms }
    const ran = condPasses(world, scratch, script.when)
    if (ran) {
      runVerb(world, scratch, script, 1, scratchVeins)
      ranCount++
    }
    prediction.push({
      tick: t,
      ran,
      tokens: scratch.tokens - before.tokens,
      matter: scratch.matter - before.matter,
      widgets: scratch.widgets - before.widgets,
      charms: scratch.charms - before.charms,
    })
  }

  const notes: string[] = []
  if (ranCount === 0) {
    notes.push(`note: the condition holds it idle for the next ${ticks} ticks`)
  } else if (script.verb === 'sell' && prediction.every((pr) => pr.tokens === 0)) {
    notes.push(`note: nothing to sell for the next ${ticks} ticks (no ${sellGood(script)} on hand)`)
  } else if (script.verb === 'refine' && prediction.every((pr) => pr.widgets === 0)) {
    notes.push('note: not enough matter to refine for the next ' + ticks + ' ticks')
  } else if (script.verb === 'craft' && prediction.every((pr) => pr.charms === 0)) {
    notes.push(`note: starved for the next ${ticks} ticks (a charm needs ${CRAFT_MATTER_PER_CHARM} matter + ${CRAFT_WIDGETS_PER_CHARM} widget)`)
  }
  if (script.verb === 'harvest') {
    const node = script.params['node']
    const vein = s.veins.find((vn) => vn.id === node)
    if (!vein) {
      notes.push(`note: vein #${node} has not surfaced — it would idle until it does (prospect scouts the next one)`)
    } else if (vein.reserve <= 0) {
      notes.push(`note: vein #${node} is EXHAUSTED — this script would idle; re-target it`)
    } else {
      const drawPerTick = Math.min((script.params['rate'] as number) ?? 0, vein.rate)
      if (drawPerTick > 0) {
        notes.push(`note: vein #${node} holds ${vein.reserve} — exhausts in ~${Math.ceil(vein.reserve / drawPerTick)} ticks at this draw`)
      }
    }
  }
  if (script.verb === 'sell') {
    notes.push('note: predicted at BASE prices — market events show on the room board, not in this API')
  }
  if (script.verb === 'boost') {
    const m = script.params['mult'] as number
    const riskPct = Math.round(((m - 1) * BOOST_RISK_PER_STEP * 100) / 65536)
    notes.push(`note: boosts your other scripts ×${m}; ~${riskPct}% blowup risk per tick`)
  }

  return { ok: true, reasons: notes, prediction }
}
