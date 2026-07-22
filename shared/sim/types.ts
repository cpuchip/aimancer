// AIMANCER sim types — THE ARK PIVOT (locked 2026-07-22): one shared
// settlement per room, continuous play (no rounds, no phases), drop-in
// districts, REAL Starlark scripts run by the Go engine, storms on a visible
// countdown, collective milestones ending in the ark launch vote.
//
// Replay identity is unchanged and absolute: sim = f(seed + command log).
// The ENGINE never runs inside the sim — a deployed script's emitted actions
// enter the log as DATA (`scriptTick`), exactly the way LLM drafts did in the
// pre-pivot game. Replays re-apply actions; they never re-run the engine.
// Consequence (the probe's ruling, honored): an engine subprocess fault is a
// SEAT fault (that seat's scripts simply don't act that tick) — never replay
// state.

// ── Actions (what a script's act() calls may do — the sim owns the schema) ──

/** The verbs a Starlark script can emit via act(). The engine passes them
 * through untyped; the SIM validates and executes. Unknown types are dropped
 * with an honest note (hallucinations are content, still). */
export type ActionType = 'gather' | 'farm' | 'craft' | 'contribute' | 'store'
export const ACTION_TYPES: readonly ActionType[] = ['gather', 'farm', 'craft', 'contribute', 'store'] as const

/** One emitted action — JSON from the engine, loose on purpose (a script may
 * emit anything representable; validation is the sim's job). */
export interface Action {
  type: string
  [k: string]: unknown
}

// ── Scripts (REAL Starlark source — the deploy is the unit of play) ─────────

/** Where a deployment is allowed to act. 'district' = your branch: YOLO
 * allowed, your rubble. 'shared' = protected main: deploying REQUIRES an
 * oracle-green dry-run, and only VERIFIED shared deployments may contribute
 * to shared structures. THE DEPLOY GATE. */
export type ScriptScope = 'district' | 'shared'

export type ScriptStatus =
  | 'running' // deployed, executes each tick (⚡ permitting)
  | 'stopped' // undeployed by the dyad (kept for the record until redeployed)
  | 'killed' // a storm chewed it (unverified scripts die first)

export interface Verdict {
  ok: boolean
  reasons: string[]
}

/** What a deployed script actually did on its most recent tick — the
 * legibility line. Pure data from the log (scriptTick), so replays reproduce
 * it exactly. */
export interface ScriptTickResult {
  tick: number
  /** false = starved (not enough ⚡) or engine fault — the script did not act. */
  ran: boolean
  /** Plain words: '+4 ore from vein #2 · +1 part' · 'starved — needs 1⚡' ·
   * 'engine fault (seat skipped this tick)' · 'gate: contribute dropped
   * (unverified)'. */
  note: string
  gasUsed: number
  err: string | null
  /** print() output from the engine run (own-seat visibility; capped). */
  logs: string[]
  dTokens: number
  dOre: number
  dFood: number
  dParts: number
  /** Parts moved into shared structures this tick (gate-passed). */
  dContributed: number
}

export interface DeployedScript {
  id: string
  name: string
  /** REAL Starlark source — own-seat private until the launch (then public:
   * the end screen tells whose scripts held). */
  source: string
  scope: ScriptScope
  /** Last oracle verdict ok. Shared-scope contributions require verified NOW
   * (the oracle is the switch: a later red check closes the gate again). */
  verified: boolean
  lastVerdict: Verdict | null
  status: ScriptStatus
  deployedAtTick: number
  lastTick: ScriptTickResult | null
  /** Consecutive engine-error ticks (runtime err values, not seat faults). */
  errStreak: number
}

// ── The dyad (one human+AI pair, one district) ──────────────────────────────

export interface Dyad {
  name: string
  /** District index — fixed at join, rings the settlement. */
  district: number
  tokens: number // ⚡ — the per-dyad compute budget (script runs + oracle checks)
  ore: number
  food: number
  parts: number
  /** Lifetime parts landed in shared structures — the end screen's credit. */
  contributed: number
  /** District integrity 0..DISTRICT_INTEGRITY_MAX — storms chew it. */
  integrity: number
  /** Cumulative storm damage taken (end-screen verification correlation). */
  stormDamage: number
  scripts: DeployedScript[]
  joinedAtTick: number
  /** Launch vote: null = not cast. Hinge-only, revocable until launch. */
  vote: boolean | null
}

// ── The map: ore veins (kept from the depth update — finite, seeded) ────────

export interface VeinState {
  id: number
  x: number // 0..100
  y: number // 0..62
  rate: number // flow cap per gatherer per tick
  reserve: number
  reserveMax: number
  spawnedAt: number
}

// ── Shared structures + milestones (Wall → Granary → Beacon → ARK) ──────────

export type StructureKind = 'wall' | 'granary' | 'beacon' | 'ark'
export const MILESTONE_ORDER: readonly StructureKind[] = ['wall', 'granary', 'beacon', 'ark'] as const

export interface SharedStructure {
  kind: StructureKind
  parts: number // lifetime parts contributed (milestone progress, monotonic)
  partsRequired: number
  complete: boolean // latches true at partsRequired — milestones never regress
  /** Live integrity. The wall is the storm absorber: contributions add HP,
   * storms drain it. Other structures carry HP for the record (v1 storms only
   * batter the wall — the design call, noted). */
  hp: number
  hpMax: number
}

// ── Storms (seeded, escalating, visible countdown) ──────────────────────────

export interface StormSpec {
  index: number // 1-based
  tick: number
  severity: number
}

// ── The Chronicle (FREEDOM UPDATE — shared lore-memory, replay data) ────────

/** One entry in the settlement's shared chronicle. Claims are posted by a
 * seat (worker or hinge — the dyad speaks with one voice here) and cost ⚡;
 * discoveries are auto-entered free when a hidden surface is first found.
 * The chronicle is a LOGGED COMMAND, so replays carry the collective
 * knowledge-building — the lore is part of the record. */
export interface ChronicleEntry {
  id: number // 1-based, append-order (entries are never removed)
  author: number // seat index
  kind: 'claim' | 'discovery'
  text: string
  /** Evidence refs — free-form pointers ("tick 41 log", "/api/help/x", a
   * script id). The chronicle doesn't verify them; readers do. */
  evidence: string[]
  /** Ids of earlier entries this one builds on / disputes / completes. */
  relatesTo: number[]
  atTick: number
}

// ── End screen (after the launch) ───────────────────────────────────────────

export interface DyadEndStats {
  name: string
  district: number
  contributed: number
  stormDamage: number
  integrity: number
  survived: boolean // integrity > 0 when the ark left
  scriptsDeployed: number
  scriptsVerified: number
  scriptsKilled: number
}

export interface EndStats {
  launchedAtTick: number
  stormsWeathered: number
  survivors: number
  totalParts: number
  goVotes: number
  dyads: DyadEndStats[]
}

// ── The world ───────────────────────────────────────────────────────────────

export interface SimState {
  seed: number
  tick: number
  dyads: Dyad[]
  veins: VeinState[]
  structures: Record<StructureKind, SharedStructure>
  /** Collective food store (granary) — feeds arriving survivors. */
  granaryFood: number
  /** Survivors sheltering — each raises the room's script capacity. */
  survivors: number
  /** The game-over latch: true after the LAUNCH or a host END — the world
   * rests, the books open. `endedEarly` says which story it was. */
  launched: boolean
  endedEarly: boolean
  end: EndStats | null
  /** The shared chronicle — collective lore-memory, append-only, replayed. */
  chronicle: ChronicleEntry[]
  events: SimEvent[] // this tick's public happenings (cleared each tick)
  eventSeq: number
}

// ── Events (the board's living-settlement feed) ─────────────────────────────

export type SimEvent =
  | { t: 'joined'; dyad: number; name: string; district: number }
  | { t: 'deployed'; dyad: number; id: string; name: string; scope: ScriptScope; verified: boolean }
  | { t: 'undeployed'; dyad: number; id: string }
  | { t: 'oracle'; dyad: number; id: string; ok: boolean }
  | { t: 'gateRefused'; dyad: number; id: string; reason: string } // runtime gate drop
  | { t: 'scriptError'; dyad: number; id: string; reason: string }
  | { t: 'scriptKilled'; dyad: number; id: string } // storm casualty
  | { t: 'stormWarning'; index: number; inTicks: number; severity: number }
  | { t: 'stormLanded'; index: number; severity: number; absorbed: number; damage: number[] }
  | { t: 'contributed'; dyad: number; structure: StructureKind; amount: number }
  | { t: 'milestone'; structure: StructureKind } // completion — the room's beat
  | { t: 'survivorArrived'; survivors: number; capacity: number }
  | { t: 'veinSpawned'; id: number; rate: number; reserve: number }
  | { t: 'veinExhausted'; id: number }
  | { t: 'voteCast'; dyad: number; go: boolean }
  | { t: 'launch'; goVotes: number; dyads: number }
  | { t: 'ended' } // the host called the game — no launch, the books open
  // The chronicle speaks: a claim posted, or a hidden surface FIRST found
  // (kind 'discovery' — the board celebrates it). snippet keeps the feed
  // self-contained (the full entry lives in state.chronicle by id).
  | { t: 'chronicle'; dyad: number; id: number; kind: 'claim' | 'discovery'; snippet: string }

// ── Commands (the log; sim = f(seed + commands)) ────────────────────────────

export type Command =
  // Drop-in: a dyad claims the next district. Logged — replays reproduce the
  // exact join order and timing.
  | { t: 'joinDistrict'; name: string }
  // Deploy carries the SOURCE as data. FREEDOM UPDATE: the server imposes NO
  // verification requirement — any scope deploys directly. verified + verdict
  // are data from an oracle run the server performed when the SEAT'S OWN gate
  // policy asked for one (or false/absent when it didn't).
  | { t: 'deploy'; player?: number; id: string; name: string; source: string; scope: ScriptScope; verified: boolean; verdict?: Verdict }
  | { t: 'undeploy'; player?: number; id: string }
  // The paid oracle check on a deployed script: the server ran the engine
  // dry-run; ok/reasons enter the log as data. ok=true opens (re-opens) the
  // shared gate for that script; ok=false closes it.
  | { t: 'oracleResult'; player?: number; id: string; ok: boolean; reasons: string[] }
  // One deployed script's engine output for this tick — ACTIONS AS DATA.
  // starved=true means the server skipped the engine call (not enough ⚡).
  | { t: 'scriptTick'; player?: number; id: string; actions: Action[]; gasUsed: number; err?: string; starved?: boolean; logs?: string[] }
  | { t: 'vote'; player?: number; go: boolean } // hinge-only (server-enforced)
  | { t: 'launch' } // host act — refused until ark complete + majority GO
  // HOST END (anti-immortal-rooms): the host calls the game — the world rests,
  // end stats are captured as they stand, the books open. Server-enforced
  // host-hinge; the room tears down after a short reading grace.
  | { t: 'end' }
  // FREEDOM UPDATE. spend: a ⚡ debit for a server-side service (beta runs).
  // The SERVICE is a query and stays out of the log; the ECONOMY is sim state
  // and must replay — so the debit alone is logged.
  | { t: 'spend'; player?: number; amount: number; reason: string }
  // chronicle: append to the shared lore-memory. Costs CHRONICLE_COST unless
  // free (discovery auto-entries). Exact-duplicate text is refused (novelty
  // dedupe); relatesTo must reference existing entries.
  | { t: 'chronicle'; player?: number; kind?: 'claim' | 'discovery'; text: string; evidence?: string[]; relatesTo?: number[]; free?: boolean }
