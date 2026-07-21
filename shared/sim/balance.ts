// AIMANCER balance — every tuning constant in one place. Integer math only:
// probabilities are expressed as x-in-65536 rolls against hashNoise.

// ── Tokens (THE economy — the real one every engineer lives) ─────────────────
export const TOKEN_START = 20 // opening balance per workshop
export const TOKEN_REGEN = 5 // +N per tick, like a rate limit refilling
export const TOKEN_CAP = 50 // regen and sales both cap here (overflow is wasted)
export const DRAFT_COST_CHEAP = 3 // cheap-model draft: few tokens, shakier scripts
export const DRAFT_COST_SMART = 8 // smart-model draft: pricier, better hit-rate
export const ORACLE_COST = 4 // one oracle verification

// ── Hand / script queue ──────────────────────────────────────────────────────
export const MAX_SCRIPTS = 8 // total scripts a workshop can hold (hand + armed + dead)

// ── DSL verb parameter bounds (the oracle enforces these) ────────────────────
export interface ParamSpec {
  name: string
  min: number
  max: number
}
export const VERB_PARAMS: Record<string, ParamSpec[]> = {
  harvest: [{ name: 'rate', min: 1, max: 5 }], // matter gained per tick
  refine: [{ name: 'rate', min: 1, max: 3 }], // widgets attempted per tick
  sell: [{ name: 'amount', min: 1, max: 5 }], // widgets sold per tick
  patch: [{ name: 'strength', min: 1, max: 6 }], // gremlin damage soaked
  boost: [{ name: 'mult', min: 2, max: 4 }], // output multiplier while running
}

export const REFINE_RATIO = 3 // matter consumed per widget

// ── Market (sell rate drifts on a seeded schedule) ───────────────────────────
export const MARKET_BASE = 4 // tokens per widget at tick 0
export const MARKET_MIN = 1
export const MARKET_MAX = 9
export const MARKET_SHIFT_TICKS = 4 // the rate steps ±1 every N ticks

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

// ── Scoring: widgets shipped + uptime − waste ────────────────────────────────
export const SCORE_PER_WIDGET = 10
export const SCORE_PER_UPTIME = 1 // per armed-valid script per tick
export const SCORE_WASTE_MULT = 2
