// AIMANCER balance — every tuning constant in one place. Integer math only:
// probabilities are expressed as x-in-65536 rolls against hashNoise.

// ── Tokens (THE economy — the real one every engineer lives) ─────────────────
export const TOKEN_START = 20 // opening balance per workshop
export const TOKEN_REGEN = 5 // +N per tick, like a rate limit refilling
export const TOKEN_CAP = 50 // regen and sales both cap here (overflow is wasted)
export const DRAFT_COST_CHEAP = 3 // cheap-model draft: few tokens, shakier scripts
export const DRAFT_COST_SMART = 8 // smart-model draft: pricier, better hit-rate
export const ORACLE_COST = 4 // one oracle verification
export const SCRAP_COST = 0 // scrapping is hygiene — the dead script already cost you

// ── Apprentice hallucination rates (the hybrid design, D3) ───────────────────
// Chance (per 100) that a delivered draft is subtly hallucinated. Applied as
// SEEDED FLAW INJECTION on real-model drafts at arrival (deterministic per
// room+tick+seat — see shared/apprentice.ts) and on practice-mode drafts the
// same way. Keeps the comedy rate a tuning knob regardless of model quality;
// a model that returns actual gibberish adds ORGANIC hallucinations on top.
export const APPRENTICE_FLAW_CHEAP_PCT = 45
export const APPRENTICE_FLAW_SMART_PCT = 15

// ── Hand / script queue ──────────────────────────────────────────────────────
export const MAX_SCRIPTS = 8 // total scripts a workshop can hold (hand + armed + dead)

// ── The map: matter veins (finite, seeded, they surface and run dry) ─────────
export const VEINS_INITIAL = 3 // veins live at tick 0
export const VEIN_SPAWN_TICKS = 5 // a new vein surfaces every ~N ticks…
export const VEIN_SPAWN_JITTER = 3 // …+0..(J-1) seeded jitter
export const VEIN_ID_MAX = 12 // hard cap on vein ids — harvest.node's static bound
export const VEIN_RATE_MIN = 2 // richness: the vein's flow cap per harvester per tick
export const VEIN_RATE_MAX = 5
export const VEIN_RESERVE_FACTOR_MIN = 7 // reserve = rate × factor (seeded) —
export const VEIN_RESERVE_FACTOR_MAX = 12 // rich veins hold more but still run dry
export const PROSPECT_COST = 2 // preview the NEXT vein before it surfaces (info play)

// ── DSL verb parameter bounds (the oracle enforces these) ────────────────────
// A spec is either numeric (integer min..max) or an enum (`values`, strings).
// `optional` params may be omitted (sell defaults to widgets).
export interface ParamSpec {
  name: string
  min?: number
  max?: number
  values?: readonly string[]
  optional?: boolean
}
export const VERB_PARAMS: Record<string, ParamSpec[]> = {
  harvest: [
    { name: 'rate', min: 1, max: 5 }, // matter attempted per tick
    { name: 'node', min: 1, max: VEIN_ID_MAX }, // the vein this harvester binds to (REQUIRED)
  ],
  refine: [{ name: 'rate', min: 1, max: 3 }], // widgets attempted per tick
  craft: [{ name: 'rate', min: 1, max: 2 }], // charms attempted per tick (matter + widgets in)
  sell: [
    { name: 'amount', min: 1, max: 5 }, // goods sold per tick
    { name: 'good', values: ['widgets', 'charms'], optional: true }, // what to sell (default widgets)
  ],
  patch: [{ name: 'strength', min: 1, max: 6 }], // gremlin damage soaked
  boost: [{ name: 'mult', min: 2, max: 4 }], // output multiplier while running
}

export const REFINE_RATIO = 3 // matter consumed per widget

// ── Charms (the deeper pipeline: matter + widgets → charms, sell high) ───────
export const CRAFT_MATTER_PER_CHARM = 2 // matter consumed per charm
export const CRAFT_WIDGETS_PER_CHARM = 1 // widgets consumed per charm

// ── Markets (each good's BASE price drifts on its own seeded schedule) ───────
export const MARKET_BASE = 4 // tokens per widget at tick 0
export const MARKET_MIN = 1
export const MARKET_MAX = 9
export const MARKET_SHIFT_TICKS = 4 // the rate steps ±1 every N ticks
export const CHARM_MARKET_BASE = 10 // tokens per charm at tick 0
export const CHARM_MARKET_MIN = 5
export const CHARM_MARKET_MAX = 22
export const CHARM_MARKET_SHIFT_TICKS = 4 // steps every N ticks (offset from widgets)
export const CHARM_MARKET_STEP_MAX = 2 // charm drift steps −2..+2 (livelier)

// ── RUSH events (seeded windows where one good pays 2-3×) ────────────────────
// THE ASYMMETRY MECHANIC: the rush — its good, multiplier, clock, and forecast
// — is announced on the BOARD (and phones) only. The agent's /state view shows
// just the CURRENT effective prices. The human holds the map; relay it.
export const RUSH_FIRST_TICK = 5 // first rush window opens here
export const RUSH_PERIOD = 7 // a window every N ticks after that
export const RUSH_LEN = 3 // rush duration in ticks
export const RUSH_MULT_MIN = 2 // price multiplier, seeded per window
export const RUSH_MULT_MAX = 3

// ── Contracts (round 2 only — seeded offers, claimed by the HUMAN) ───────────
export const CONTRACT_FIRST_TICK = 2 // first offer appears (round-2 ticks)
export const CONTRACT_PERIOD = 5 // a new offer every N ticks
export const CONTRACT_OFFER_TTL = 6 // unclaimed offers expire after N ticks
export const CONTRACT_ID_MAX = 8 // offers per round, hard cap
export const CONTRACT_MAX_ACTIVE = 2 // claimed contracts per player at once
export const CONTRACT_WINDOW_TICKS = 8 // delivery window after the claim
export const CONTRACT_QTY_WIDGETS_MIN = 4 // widgets contracts ask 4..8
export const CONTRACT_QTY_WIDGETS_MAX = 8
export const CONTRACT_QTY_CHARMS_MIN = 2 // charm contracts ask 2..4
export const CONTRACT_QTY_CHARMS_MAX = 4
export const CONTRACT_BONUS_PER_WIDGET = 7 // bonus = qty × per-good rate (SCORE, not tokens)
export const CONTRACT_BONUS_PER_CHARM = 15
export const CONTRACT_PENALTY = 8 // score lost on a blown deadline (small — dare to claim)

// ── Boost risk (small blowup chance per tick, scales with mult) ──────────────
export const BOOST_RISK_PER_STEP = 1310 // per 65536, per (mult-1): 2%/4%/6% per tick
export const BOOST_BLOWUP_WASTE = 8 // scored waste when a boost blows
export const BOOST_BLOWUP_MATTER_LOSS = 6 // matter scorched by the blowup

// ── Gremlin (the one shared threat track) ────────────────────────────────────
export const GREMLIN_MAX = 10 // pressure ceiling
export const GREMLIN_RAMP_TICKS = 8 // pressure +1 every N ticks
export const SPIKE_CHANCE_PER_PRESSURE = 1638 // per 65536 per pressure point (~2.5%)
export const SPIKE_BUGGY_EXTRA = 3 // extra damage per buggy (invalid) armed script
export const CORRUPT_THRESHOLD = 4 // damage (after patch) that chews a script
export const DEAD_SCRIPT_WASTE = 5 // scored waste when a script misfires dead

// ── Scoring: goods SOLD + uptime + contracts − waste ─────────────────────────
// Sold, not produced: shipping IS selling, which makes the market load-bearing
// (a warehouse of unsold widgets scores nothing). Ratified D2. Charms score
// 2.5× a widget — the deeper pipeline pays when it's scripted well. Contract
// bonuses/penalties land as SCORE (the token cap can't waste a payout).
export const SCORE_PER_WIDGET = 10 // per widget SOLD
export const SCORE_PER_CHARM = 25 // per charm SOLD (costs 1 widget + 2 matter + a craft tick)
export const SCORE_PER_UPTIME = 1 // per armed-valid script per tick
export const SCORE_WASTE_MULT = 2
