// Wire protocol between the AIMANCER client and the room server — ARK PIVOT.
// Two-token seats remain: every seat holds a workerToken (the agent's
// surface: deploy/oracle/read) and a hingeToken (the human's surface: the
// LAUNCH VOTE, and the host's launch confirm). Tokens travel ONLY in the
// welcome/join responses, only to their own seat.

import type { OracleReport } from './sim/oracle.ts'
import type {
  EndStats,
  ScriptScope,
  ScriptStatus,
  ScriptTickResult,
  SimEvent,
  SharedStructure,
  StructureKind,
  VeinState,
  Verdict,
} from './sim/types.ts'

/** What EVERYONE may see of a deployed script: existence, scope, verification
 * state, fate, and the plain-words yield line. SOURCE stays own-seat private
 * until the launch (the end screen opens the books). */
export interface PublicScriptView {
  id: string
  name: string
  scope: ScriptScope
  verified: boolean
  status: ScriptStatus
  deployedAtTick: number
  lastNote: string | null
  errStreak: number
}

export interface DyadView {
  index: number
  name: string
  district: number
  online: boolean
  agentSeenAgoMs: number | null
  tokens: number
  ore: number
  food: number
  parts: number
  contributed: number
  integrity: number
  stormDamage: number
  vote: boolean | null
  scripts: PublicScriptView[]
}

export interface StormView {
  nextAtTick: number
  inTicks: number
  severity: number
  index: number
}

/** Own-seat script view — the full body. */
export interface OwnScriptView extends PublicScriptView {
  source: string
  lastVerdict: Verdict | null
  lastTick: ScriptTickResult | null
}

/** One redacted room snapshot. `you` is present only for a seated recipient
 * and carries THEIR full scripts; other sources never cross the wire until
 * the launch. */
export interface RoomView {
  room: string
  tickMs: number
  tick: number
  launched: boolean
  /** ms until the next world tick fires (null = world holds still). */
  nextTickInMs: number | null
  storm: StormView
  structures: Record<StructureKind, SharedStructure>
  /** The current milestone frontier — null once the ark stands. */
  frontier: StructureKind | null
  granaryFood: number
  survivors: number
  scriptSlots: number
  /** Vote tally is public drama: who's GO, who's NO-GO, who hasn't said. */
  votes: { go: number; noGo: number; pending: number }
  arkReady: boolean
  veins: VeinState[]
  events: SimEvent[]
  eventSeq: number
  dyads: DyadView[]
  end: EndStats | null
  engine: EngineInfo | null
  you: { index: number; isHost: boolean; scripts: OwnScriptView[] } | null
}

/** The engine identity — pinned into the replay header too. */
export interface EngineInfo {
  engine: string
  version: string
  language: string
  protocol: number
}

export type ClientMessage =
  | { type: 'join'; room: string; name: string; key: string } // room '' → create a new settlement
  | { type: 'watch'; room: string } // spectator (the big screen)
  | { type: 'deploy'; token: string; id: string; name?: string; source: string; scope: ScriptScope }
  | { type: 'undeploy'; token: string; id: string }
  | { type: 'oracle'; token: string; id: string }
  | { type: 'vote'; token: string; go: boolean } // HINGE token ONLY — the human's voice
  | { type: 'launch'; token: string } // HOST HINGE only — majority required
  | { type: 'ping' }

/** GET /api/room/:pin/log — the command log + replay header. Redaction:
 * deploy commands from OTHER seats are stripped of `source` until the room
 * has launched (then the books open for everyone — the end screen's replay
 * value). The header pins the ENGINE identity: replays re-apply logged
 * actions as data, and the header records which engine emitted them. */
export interface RoomLogView {
  room: string
  seed: number
  tickMs: number
  tick: number
  launched: boolean
  engine: EngineInfo | null
  log: Array<{ atTick: number; cmd: Record<string, unknown> }>
}

export type ServerMessage =
  | { type: 'welcome'; index: number; room: string; isHost: boolean; you: string; workerToken: string; hingeToken: string }
  | { type: 'snapshot'; view: RoomView }
  | { type: 'oracleReport'; id: string; report: OracleReport }
  | { type: 'error'; message: string }
  | { type: 'pong' }
