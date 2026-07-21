// Wire protocol between the AIMANCER client and the room server.
// Adapted from kernel-panic shared/protocol.ts, extended with the two-token
// seat model: every seat holds a workerToken (AI surface: read/draft) and a
// hingeToken (human surface: arm). Tokens travel ONLY in the welcome message,
// only to their own seat.

import type { OracleReport } from './sim/oracle.ts'
import type { DraftTier, PendingDraft, Phase, RevealDelta, RoundSummary, Script, ScriptSlot, SimEvent, SimPhase, SlotStatus } from './sim/types.ts'

export interface LobbyPlayer {
  index: number
  name: string
  online: boolean
  /** ms since this seat's agent last spoke on the HTTP worker surface (null =
   * no agent yet). Liveness only — never token material. */
  agentSeenAgoMs: number | null
}

/** What EVERYONE may see of a script: existence and fate, never the body. */
export interface PublicScriptView {
  id: string
  status: SlotStatus
  armed: boolean
  yolo: boolean
  verdictOk: boolean | null
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
  disasters: number
  uptime: number
  waste: number
  scripts: PublicScriptView[]
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
  market: number
  gremlin: number
  events: SimEvent[]
  eventSeq: number // total events ever — the feed's dedup watermark (eventFeed.ts)
  players: PlayerView[]
  round1Summary: RoundSummary | null // present from intermission on (the teaching backdrop)
  round2Summary: RoundSummary | null // present in reveal
  delta: RevealDelta | null // present in reveal — the thesis table
  /** 'live' = a real model is wired (APPRENTICE_BASE_URL); 'practice' = the
   * seeded offline generator stands in (dev / un-wired deploys). */
  apprentice: 'live' | 'practice'
  /** `pending` = your own in-flight draft requests (the "drafting…" slots). */
  you: { index: number; hand: ScriptSlot[]; pending: PendingDraft[] } | null
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
