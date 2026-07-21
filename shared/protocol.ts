// Wire protocol between the AIMANCER client and the room server.
// Adapted from kernel-panic shared/protocol.ts, extended with the two-token
// seat model: every seat holds a workerToken (AI surface: read/draft) and a
// hingeToken (human surface: arm). Tokens travel ONLY in the welcome message,
// only to their own seat.

import type { OracleReport } from './sim/oracle.ts'
import type {
  ContractStatus,
  DraftTier,
  Good,
  PendingDraft,
  Phase,
  RevealDelta,
  RoundSummary,
  Script,
  ScriptSlot,
  SimEvent,
  SimPhase,
  SlotStatus,
  VeinState,
} from './sim/types.ts'

export interface LobbyPlayer {
  index: number
  name: string
  online: boolean
  /** ms since this seat's agent last spoke on the HTTP worker surface (null =
   * no agent yet). Liveness only — never token material. */
  agentSeenAgoMs: number | null
}

/** What EVERYONE may see of a script: existence and fate, never the body —
 * EXCEPT an armed script's verb + vein binding: a deployed unit is physically
 * on the map (the board renders its workers), like an RTS. Params and
 * conditions stay hand-private always. */
export interface PublicScriptView {
  id: string
  status: SlotStatus
  armed: boolean
  yolo: boolean
  verdictOk: boolean | null
  /** The armed script's verb — null while it sits un-armed in the hand. */
  verb: string | null
  /** Armed harvest only: the vein it's bound to (the map's worker lines). */
  node: number | null
}

export interface PlayerView {
  index: number
  name: string
  online: boolean
  /** ms since this seat's agent last spoke on the HTTP worker surface (null =
   * no agent yet) — the board's dyad indicator. Liveness only, never tokens. */
  agentSeenAgoMs: number | null
  score: number
  tokens: number
  matter: number
  widgets: number
  widgetsSold: number
  charms: number
  charmsSold: number
  contractScore: number
  disasters: number
  uptime: number
  waste: number
  scripts: PublicScriptView[]
}

/** A contract as every surface sees it (offers are public; progress too —
 * the room watches a delivery race like it watches the scoreboard). */
export interface ContractView {
  id: number
  good: Good
  qty: number
  windowTicks: number
  bonus: number
  penalty: number
  status: ContractStatus
  player: number | null
  deadline: number | null
  progress: number
}

/** The RUSH banner — RICH (human) surfaces only: board + phones over ws.
 * The agent's HTTP /state never carries it (CORE IDENTITY #2 — the human
 * holds the map). */
export interface RushView {
  good: Good
  mult: number
  ticksLeft: number // inclusive of the current tick
}

/** An own-seat vein preview bought with `prospect` — spec of a vein that has
 * not surfaced yet. */
export interface ProspectView {
  id: number
  spawnsInTicks: number
  x: number
  y: number
  rate: number
  reserveMax: number
}

/** One redacted room snapshot. `you` is present only for a seated recipient
 * and carries THEIR full hand; other hands never cross the wire. */
export interface RoomView {
  room: string
  started: boolean
  tickMs: number
  tick: number
  phase: Phase // 'lobby' until the host starts; then the sim's phase
  ticksRemaining: number | null // countdown within the current round (null = unlimited)
  /** Room setting: auto-issue the host `phase` command when the budget is spent. */
  autoAdvance: boolean
  /** Seconds until the room auto-advances (visible countdown window only —
   * null during the intermission dwell, when held, or when OFF). */
  autoAdvanceIn: number | null
  /** Host tapped HOLD — auto-advance suspended until the host calls it. */
  autoHeld: boolean
  /** ms until the next world tick fires (null = the world holds still) — the
   * wall-clock round countdown anchors on this. */
  nextTickInMs: number | null
  /** CURRENT effective price per widget (rush already applied — by design the
   * number alone doesn't say whether a rush is on; the board does). */
  market: number
  /** CURRENT effective price per charm (same rule). */
  marketCharms: number
  gremlin: number
  /** The shared map's matter veins — public on every surface. */
  veins: VeinState[]
  /** Contract offers + claims — public on every surface (claiming is hinge-only). */
  contracts: ContractView[]
  /** RICH (ws/human) surfaces only: the rush banner. ABSENT from HTTP /state —
   * the asymmetry is structural, not cosmetic. */
  rush?: RushView | null
  /** RICH surfaces only: ticks until the next rush window opens (board forecast). */
  nextRushInTicks?: number
  events: SimEvent[]
  eventSeq: number // total events ever — the feed's dedup watermark (eventFeed.ts)
  players: PlayerView[]
  round1Summary: RoundSummary | null // present from intermission on (the teaching backdrop)
  round2Summary: RoundSummary | null // present in reveal
  delta: RevealDelta | null // present in reveal — the thesis table
  /** 'live' = a real model is wired (APPRENTICE_BASE_URL); 'practice' = the
   * seeded offline generator stands in (dev / un-wired deploys). */
  apprentice: 'live' | 'practice'
  /** `pending` = your own in-flight draft requests (the "drafting…" slots);
   * `prospects` = the vein previews this seat has paid for (own-seat info). */
  you: { index: number; hand: ScriptSlot[]; pending: PendingDraft[]; prospects: ProspectView[] } | null
}

export type ClientMessage =
  | { type: 'join'; room: string; name: string; key: string } // room '' → create a new room
  | { type: 'watch'; room: string } // spectator (the big screen)
  | { type: 'start'; token: string; tickMs?: number; round1Ticks?: number; round2Ticks?: number; autoAdvance?: boolean } // host hinge only
  | { type: 'phase'; token: string; to: SimPhase } // host hinge only — advance the weave
  | { type: 'hold'; token: string } // host hinge only — suspend a pending auto-advance
  | { type: 'draft'; token: string; script: Script; tier: DraftTier } // WORKER token — direct draft (custom/BYO)
  | { type: 'draftRequest'; token: string; tier: DraftTier; order?: string } // either token — ask the apprentice (async)
  | { type: 'oracle'; token: string; id: string } // either token (verification is safe)
  | { type: 'arm'; token: string; id: string } // HINGE token ONLY
  | { type: 'disarm'; token: string; id: string } // HINGE token (script-lifecycle control, D4)
  | { type: 'scrap'; token: string; id: string } // either token (freeing a slot is safe)
  | { type: 'prospect'; token: string } // either token — paid vein preview (own-seat info)
  | { type: 'claimContract'; token: string; id: number } // HINGE token — strategy is the human's
  | { type: 'ping' }

/** GET /api/room/:pin/log — the command log + seed (replay theater's feed).
 * Redaction: draft commands from OTHER seats are stripped to { id, verb }
 * (params + condition are hand-private) — except the HOST token, which gets
 * the full log once the phase is 'reveal'. `cmd` is typed loose because a
 * redacted draft is not a complete Command. */
export interface RoomLogView {
  room: string
  seed: number
  phase: Phase
  tickMs: number
  phaseTicks: { round1: number; round2: number }
  log: Array<{ atTick: number; cmd: Record<string, unknown> }>
}

export type ServerMessage =
  | { type: 'welcome'; index: number; room: string; isHost: boolean; you: string; workerToken: string; hingeToken: string }
  | { type: 'lobby'; room: string; players: LobbyPlayer[]; isHost: boolean; started: boolean; tickMs: number }
  | { type: 'snapshot'; view: RoomView }
  | { type: 'oracleReport'; id: string; report: OracleReport }
  | { type: 'error'; message: string }
  | { type: 'pong' }
