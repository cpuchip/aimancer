// Wire protocol between the AIMANCER client and the room server.
// Adapted from kernel-panic shared/protocol.ts, extended with the two-token
// seat model: every seat holds a workerToken (AI surface: read/draft) and a
// hingeToken (human surface: arm). Tokens travel ONLY in the welcome message,
// only to their own seat.

import type { OracleReport } from './sim/oracle.ts'
import type { DraftTier, Script, ScriptSlot, SimEvent, SlotStatus } from './sim/types.ts'

export interface LobbyPlayer {
  index: number
  name: string
  online: boolean
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
  score: number
  tokens: number
  matter: number
  widgets: number
  widgetsShipped: number
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
  market: number
  gremlin: number
  events: SimEvent[]
  players: PlayerView[]
  you: { index: number; hand: ScriptSlot[] } | null
}

export type ClientMessage =
  | { type: 'join'; room: string; name: string; key: string } // room '' → create a new room
  | { type: 'watch'; room: string } // spectator (the big screen)
  | { type: 'start'; token: string; tickMs?: number } // host hinge only
  | { type: 'draft'; token: string; script: Script; tier: DraftTier } // WORKER token
  | { type: 'oracle'; token: string; id: string } // either token (verification is safe)
  | { type: 'arm'; token: string; id: string } // HINGE token ONLY
  | { type: 'disarm'; token: string; id: string } // either token (disarming is safe)
  | { type: 'ping' }

export type ServerMessage =
  | { type: 'welcome'; index: number; room: string; isHost: boolean; you: string; workerToken: string; hingeToken: string }
  | { type: 'lobby'; room: string; players: LobbyPlayer[]; isHost: boolean; started: boolean; tickMs: number }
  | { type: 'snapshot'; view: RoomView }
  | { type: 'oracleReport'; id: string; report: OracleReport }
  | { type: 'error'; message: string }
  | { type: 'pong' }
