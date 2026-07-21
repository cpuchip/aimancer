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

// ── The world ────────────────────────────────────────────────────────────────

export interface Workshop {
  name: string
  tokens: number
  matter: number
  widgets: number // inventory (sellable)
  widgetsShipped: number // cumulative production (scored)
  uptime: number // armed-valid script-ticks (scored)
  waste: number // blowups + gremlin damage + dead scripts (scored against)
  scripts: ScriptSlot[]
}

export interface SimState {
  seed: number
  tick: number
  market: number // tokens per widget, drifts on the seeded schedule
  gremlin: number // current pressure on the shared threat track
  players: Workshop[]
  events: SimEvent[] // this tick's public happenings (cleared each tick)
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

// ── Commands (the log; sim = f(seed + commands)) ─────────────────────────────

export type DraftTier = 'cheap' | 'smart'

export type Command =
  | { t: 'draftAccepted'; player?: number; script: Script; tier: DraftTier }
  | { t: 'oracleCheck'; player?: number; id: string }
  | { t: 'arm'; player?: number; id: string }
  | { t: 'disarm'; player?: number; id: string }
