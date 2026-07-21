// AIMANCER sim types — the world, the script DSL, the command log.
// Architecture adapted from kernel-panic shared/sim/types.ts (newGame/apply/
// tick over a pure state), reshaped for workshops instead of towers.

// ── Script DSL v2 (bounded, 6 verbs — craft joined in the depth update) ──────

export type Verb = 'harvest' | 'refine' | 'craft' | 'sell' | 'patch' | 'boost'
export const VERBS: readonly Verb[] = ['harvest', 'refine', 'craft', 'sell', 'patch', 'boost'] as const

/** The sellable goods — widgets (the classic) and charms (the deeper pipeline). */
export type Good = 'widgets' | 'charms'
export const GOODS: readonly Good[] = ['widgets', 'charms'] as const

export type ConditionField = 'tokens' | 'matter' | 'widgets' | 'charms' | 'gremlin' | 'market' | 'marketCharms' | 'tick'
export const CONDITION_FIELDS: readonly ConditionField[] = [
  'tokens',
  'matter',
  'widgets',
  'charms',
  'gremlin',
  'market',
  'marketCharms',
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
 * The valid verb set is VERBS. Param values are integers — except declared
 * enum params (sell's `good`), which are short strings; a hallucinated string
 * anywhere else is representable and oracle-red. */
export interface Script {
  id: string
  verb: string
  params: Record<string, number | string>
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

/** What an ARMED script actually did on its most recent tick — the
 * legibility line ("a starved duplicate is indistinguishable from a dead
 * one" hotfix). Pure function of the tick, so replays reproduce it exactly.
 * Own-seat/own-agent only: public views stay fate-only. */
export interface ScriptRun {
  tick: number
  /** Condition passed and the verb executed (false = idle this tick). */
  ran: boolean
  /** Plain words: '+4 matter' · 'starved — needs 3 matter' · 'idle — condition false'. */
  note: string
  dTokens: number
  dMatter: number
  dWidgets: number
  /** Charms moved this tick (craft/sell charms). Absent on pre-charm replays. */
  dCharms?: number
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
  /** Most recent armed-tick outcome (null until it first runs). */
  lastRun: ScriptRun | null
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
  charmsSold: number
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

/** An apprentice draft request in flight: paid up front (draftRequested), open
 * until the batch settles (draftSettled) or fails (draftFailed → refund). The
 * LLM lives OUTSIDE the sim — pending is just the escrow receipt. */
export interface PendingDraft {
  reqId: string
  tier: DraftTier
}

export interface Workshop {
  name: string
  tokens: number
  matter: number
  widgets: number // inventory (sellable)
  widgetsSold: number // cumulative SOLD — the scored count (shipping IS selling)
  charms: number // inventory — the deeper pipeline's good
  charmsSold: number // cumulative SOLD charms (scored higher than widgets)
  contractScore: number // net contract bonuses − penalties (scored directly)
  prospects: number[] // vein ids this seat has paid to preview (own-seat info)
  disasters: number // cumulative misfires + blowups + corruptions (summary stat)
  uptime: number // armed-valid script-ticks (scored)
  waste: number // blowups + gremlin damage + dead scripts (scored against)
  scripts: ScriptSlot[]
  pending: PendingDraft[] // apprentice requests awaiting drafts (paid, in escrow)
}

// ── The map: matter veins (finite, seeded, they surface and run dry) ─────────

/** A LIVE vein on the shared map. Spec fields (x/y/rate/reserveMax/spawnedAt)
 * are pure functions of (seed, id) — see world.veinSpec; only `reserve` is
 * state, drained by harvesters. reserve === 0 means exhausted (visibly). */
export interface VeinState {
  id: number // 1..VEIN_ID_MAX — harvest binds by this number (params.node)
  x: number // map layout, 0..100 (seeded per room)
  y: number // map layout, 0..62 (seeded per room)
  rate: number // richness — the vein's flow cap per harvester per tick
  reserve: number // finite matter remaining
  reserveMax: number
  spawnedAt: number // tick it surfaced (0 = the opening field)
}

// ── Contracts (round 2 only — seeded offers; the HUMAN claims on the phone) ──

export type ContractStatus = 'open' | 'claimed' | 'fulfilled' | 'failed' | 'expired'

/** A materialized contract. Spec fields come from world.contractSpec (pure
 * f(seed, id)); status/player/deadline/progress are state. Fulfillment is
 * auto-detected from sells of the named good after the claim. */
export interface ContractState {
  id: number
  good: Good
  qty: number
  windowTicks: number // ticks allowed after the claim
  bonus: number // SCORE paid on delivery (score, not tokens — the cap can't waste it)
  penalty: number // SCORE lost on a blown deadline
  offeredAt: number
  status: ContractStatus
  player: number | null // who claimed it
  deadline: number | null // claim tick + windowTicks
  progress: number // goods sold toward qty since the claim
}

export interface SimState {
  seed: number
  tick: number
  phase: SimPhase
  phaseTicks: PhaseTicks // per-round tick budgets (0 = unlimited)
  market: number // BASE tokens per widget, drifts on the seeded schedule
  marketCharms: number // BASE tokens per charm — its own seeded drift
  gremlin: number // current pressure on the shared threat track
  veins: VeinState[] // the map's matter veins (spawn on the seeded schedule)
  contracts: ContractState[] // materialized offers + claims (round 2 only)
  players: Workshop[]
  events: SimEvent[] // this tick's public happenings (cleared each tick)
  eventSeq: number // total events EVER emitted — the feed's dedup watermark
  round1Summary: RoundSummary | null // captured entering intermission
  round2Summary: RoundSummary | null // captured entering reveal
}

// ── Events (the big screen's disaster theater feed) ──────────────────────────

export type SimEvent =
  | { t: 'drafted'; player: number; id: string; tier: DraftTier }
  | { t: 'draftRequested'; player: number; tier: DraftTier }
  | { t: 'draftFailed'; player: number; tier: DraftTier; refund: number }
  | { t: 'oracle'; player: number; id: string; ok: boolean }
  | { t: 'armed'; player: number; id: string; yolo: boolean }
  | { t: 'disarmed'; player: number; id: string }
  | { t: 'autoDisarm'; player: number; id: string; reason: string }
  | { t: 'misfire'; player: number; id: string; reason: string }
  | { t: 'blowup'; player: number; id: string }
  | { t: 'gremlinSpike'; pressure: number; damage: number[] } // damage per player
  | { t: 'corrupted'; player: number; id: string }
  | { t: 'marketShift'; market: number } // BASE widget price stepped
  | { t: 'charmShift'; market: number } // BASE charm price stepped
  | { t: 'veinSpawned'; id: number; rate: number; reserve: number } // a new vein surfaced
  | { t: 'veinExhausted'; id: number } // ran dry — harvesters idle until re-targeted
  | { t: 'prospected'; player: number } // paid survey — WHAT it revealed stays own-seat
  | { t: 'contractOffered'; id: number; good: Good; qty: number; bonus: number }
  | { t: 'contractClaimed'; player: number; id: number }
  | { t: 'contractFulfilled'; player: number; id: number; bonus: number }
  | { t: 'contractFailed'; player: number; id: number; penalty: number }
  | { t: 'contractExpired'; id: number }
  | { t: 'scrapped'; player: number; id: string }
  | { t: 'phase'; phase: SimPhase }

// ── Commands (the log; sim = f(seed + commands)) ─────────────────────────────

export type DraftTier = 'cheap' | 'smart'

export type Command =
  // The async apprentice flow (D3). draftRequested debits the tier cost into
  // escrow IMMEDIATELY; the LLM call happens OUTSIDE the sim; arriving drafts
  // enter the log as data (draftAccepted with reqId = 0-cost, already paid);
  // draftSettled closes a delivered request; draftFailed refunds a dead one.
  // Replays never re-call the LLM — the log carries everything.
  | { t: 'draftRequested'; player?: number; reqId: string; tier: DraftTier }
  | { t: 'draftAccepted'; player?: number; script: Script; tier: DraftTier; reqId?: string }
  | { t: 'draftSettled'; player?: number; reqId: string }
  | { t: 'draftFailed'; player?: number; reqId: string; reason?: string }
  | { t: 'oracleCheck'; player?: number; id: string }
  | { t: 'arm'; player?: number; id: string }
  | { t: 'disarm'; player?: number; id: string }
  | { t: 'scrap'; player?: number; id: string } // free a hand slot
  | { t: 'prospect'; player?: number } // paid: preview the NEXT unspawned vein (own-seat info)
  | { t: 'claimContract'; player?: number; id: number } // the HUMAN's strategy act (hinge surface)
  | { t: 'phase'; to: SimPhase } // host act — logged so replays cross phases
