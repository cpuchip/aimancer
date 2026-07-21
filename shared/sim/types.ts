// AIMANCER sim types — the world, the script DSL, the command log.
// Architecture adapted from kernel-panic shared/sim/types.ts (newGame/apply/
// tick over a pure state), reshaped for workshops instead of towers.

// ── Script DSL v1 (bounded, 5 verbs) ─────────────────────────────────────────

export type Verb = 'harvest' | 'refine' | 'sell' | 'patch' | 'boost'
export const VERBS: readonly Verb[] = ['harvest', 'refine', 'sell', 'patch', 'boost'] as const

export type ConditionField = 'tokens' | 'matter' | 'widgets' | 'gremlin' | 'market' | 'tick'
export const CONDITION_FIELDS: readonly ConditionField[] = [
  'tokens',
  'matter',
  'widgets',
  'gremlin',
  'market',
  'tick',
] as const

export type ConditionOp = '<' | '<=' | '>' | '>=' | '=='
export const CONDITION_OPS: readonly ConditionOp[] = ['<', '<=', '>', '>=', '=='] as const

/** A tiny gate, like ksp-hmi's autopilot conditions: run only while true.
 * `field`/`op` are deliberately loose strings: a hallucinated draft may name a
 * resource that doesn't exist, and it must be REPRESENTABLE so the oracle can
 * catch it. The valid sets are CONDITION_FIELDS / CONDITION_OPS. */
export interface Condition {
  field: string
  op: string
  value: number
}

/** One automation script — what the apprentice drafts and the human arms.
 * JSON-shaped. `verb` and `params` are deliberately loose: structural typing
 * happens at the command boundary; SEMANTIC validation (unknown verb, wrong
 * param name, out-of-bounds value, impossible condition) is the oracle's job.
 * The valid verb set is VERBS. */
export interface Script {
  id: string
  verb: string
  params: Record<string, number>
  when?: Condition
}

// ── Script lifecycle ─────────────────────────────────────────────────────────

export type SlotStatus =
  | 'drafted' // in the hand, never armed
  | 'armed' // live, executes each tick
  | 'disarmed' // human pulled the plug
  | 'autoDisarmed' // the oracle went red on an auto-renew check — the switch
  | 'dead' // misfired at runtime (YOLO'd a flawed script)
  | 'blown' // boost blowup

export interface Verdict {
  ok: boolean
  reasons: string[]
}

export interface ScriptSlot {
  script: Script
  armed: boolean
  /** Passed a paid oracleCheck at least once — earns per-tick auto-renew. */
  everGreen: boolean
  /** Armed without ever going oracle-green (the comedy path). */
  yolo: boolean
  status: SlotStatus
  lastVerdict: Verdict | null
}

// ── Phases (the 40-minute weave, in the sim so replays carry it) ─────────────

/** 'lobby' exists only at the room level (sim not yet created); the sim itself
 * lives in the four SimPhases and advances ONLY via a logged `phase` command. */
export type Phase = 'lobby' | SimPhase
export type SimPhase = 'round1' | 'intermission' | 'round2' | 'reveal'

/** The only lawful advances — strictly linear, host-controlled. */
export const PHASE_NEXT: Record<SimPhase, SimPhase | null> = {
  round1: 'intermission',
  intermission: 'round2',
  round2: 'reveal',
  reveal: null,
}

/** Per-round tick budgets. 0 = unlimited (pure-sim tests); rooms pass the
 * mpConfig defaults (12 / 19 — the show's timing). */
export interface PhaseTicks {
  round1: number
  round2: number
}

// ── Round summaries (intermission backdrop + the reveal's delta) ─────────────

export interface PlayerRoundStats {
  name: string
  score: number
  widgetsSold: number
  disasters: number // misfires + blowups + corruptions
  waste: number
  uptime: number
}

export interface RoundTotals {
  score: number
  widgetsSold: number
  disasters: number
  waste: number
}

export interface RoundSummary {
  atTick: number
  players: PlayerRoundStats[]
  totals: RoundTotals
}

/** Round-2-minus-round-1, per player — the talk's thesis in a table. */
export interface PlayerDelta {
  name: string
  r1: PlayerRoundStats
  r2: PlayerRoundStats
  dScore: number
  dWidgetsSold: number
  dDisasters: number
  dWaste: number
}

export interface RevealDelta {
  players: PlayerDelta[]
  totals: RoundTotals & { r1Score: number; r2Score: number }
}

// ── The world ────────────────────────────────────────────────────────────────

export interface Workshop {
  name: string
  tokens: number
  matter: number
  widgets: number // inventory (sellable)
  widgetsSold: number // cumulative SOLD — the scored count (shipping IS selling)
  disasters: number // cumulative misfires + blowups + corruptions (summary stat)
  uptime: number // armed-valid script-ticks (scored)
  waste: number // blowups + gremlin damage + dead scripts (scored against)
  scripts: ScriptSlot[]
}

export interface SimState {
  seed: number
  tick: number
  phase: SimPhase
  phaseTicks: PhaseTicks // per-round tick budgets (0 = unlimited)
  market: number // tokens per widget, drifts on the seeded schedule
  gremlin: number // current pressure on the shared threat track
  players: Workshop[]
  events: SimEvent[] // this tick's public happenings (cleared each tick)
  eventSeq: number // total events EVER emitted — the feed's dedup watermark
  round1Summary: RoundSummary | null // captured entering intermission
  round2Summary: RoundSummary | null // captured entering reveal
}

// ── Events (the big screen's disaster theater feed) ──────────────────────────

export type SimEvent =
  | { t: 'drafted'; player: number; id: string; tier: DraftTier }
  | { t: 'oracle'; player: number; id: string; ok: boolean }
  | { t: 'armed'; player: number; id: string; yolo: boolean }
  | { t: 'disarmed'; player: number; id: string }
  | { t: 'autoDisarm'; player: number; id: string; reason: string }
  | { t: 'misfire'; player: number; id: string; reason: string }
  | { t: 'blowup'; player: number; id: string }
  | { t: 'gremlinSpike'; pressure: number; damage: number[] } // damage per player
  | { t: 'corrupted'; player: number; id: string }
  | { t: 'marketShift'; market: number }
  | { t: 'scrapped'; player: number; id: string }
  | { t: 'phase'; phase: SimPhase }

// ── Commands (the log; sim = f(seed + commands)) ─────────────────────────────

export type DraftTier = 'cheap' | 'smart'

export type Command =
  | { t: 'draftAccepted'; player?: number; script: Script; tier: DraftTier }
  | { t: 'oracleCheck'; player?: number; id: string }
  | { t: 'arm'; player?: number; id: string }
  | { t: 'disarm'; player?: number; id: string }
  | { t: 'scrap'; player?: number; id: string } // free a hand slot
  | { t: 'phase'; to: SimPhase } // host act — logged so replays cross phases
