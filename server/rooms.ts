// Room registry. Each room owns ONE authoritative SimState; clients send
// commands, the server stamps the sender's seat, ticks the sim on the room's
// cadence, and pushes redacted snapshots on change. Because the sim is a pure
// function of (seed + commands), this is all the multiplayer that's needed.
//
// Adapted from kernel-panic server/rooms.ts (Room/RoomRegistry, host-elected)
// + chips server/tables.ts (newCode PIN alphabet) + chips server/index.ts
// (reconnect-by-localStorage-key). New here: TWO-token seats — every seat gets
// a workerToken (AI: read/draft) and a hingeToken (human: arm); `arm` REQUIRES
// the hinge token, enforced in this file, proven by wstest.ts.

import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  AUTO_ADVANCE_MS,
  AUTO_DWELL_MS,
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_PLAYERS,
  ROUND1_TICKS_DEFAULT,
  ROUND2_TICKS_DEFAULT,
  ROUND_TICKS_MAX,
  ROUND_TICKS_MIN,
  TICK_MS_DEFAULT,
  TICK_MS_MAX,
  TICK_MS_MIN,
  seedFromCode,
} from '../shared/mpConfig.ts'
import { fallbackDraft, injectApprenticeFlaws, practiceDrafts, type SeatBrief } from '../shared/apprentice.ts'
import type { ClientMessage, LobbyPlayer, PlayerView, RoomLogView, RoomView, ServerMessage } from '../shared/protocol.ts'
import { apprenticeConfig, apprenticeMode, fetchDrafts } from './apprentice.ts'
import { oracle } from '../shared/sim/oracle.ts'
import { apply, computeDelta, newGame, RuleError, score, tick, ticksRemaining, ticksRunning } from '../shared/sim/sim.ts'
import { PHASE_NEXT } from '../shared/sim/types.ts'
import type { Command, DraftTier, Script, SimPhase, SimState } from '../shared/sim/types.ts'

/** Auto-advance pacing — env-overridable so wstest runs the real path fast. */
const AUTO_MS = Number(process.env.AUTO_ADVANCE_MS) || AUTO_ADVANCE_MS
const DWELL_MS = Number(process.env.AUTO_DWELL_MS) || AUTO_DWELL_MS

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

export type Role = 'worker' | 'hinge'

interface Seat {
  key: string // localStorage reconnect key — seat identity across refreshes
  name: string
  workerToken: string
  hingeToken: string
  /** Last worker-token call on the HTTP surface (agents are HTTP by design;
   * the phone's own ws traffic + its agent-prompt fetch don't count) — the
   * "agent connected" liveness signal. Timestamp only, never token material. */
  lastWorkerSeenAt: number | null
}

function mintToken(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`
}

/** Mint a reconnect key for an HTTP joiner who didn't bring one (the phone
 * uses localStorage; an agent gets its key in the join response instead). */
export function mintKey(): string {
  return `k_${randomBytes(9).toString('base64url')}`
}

function clampRound(v: number | undefined, dflt: number): number {
  return v === undefined ? dflt : Math.max(ROUND_TICKS_MIN, Math.min(ROUND_TICKS_MAX, Math.floor(v)))
}

/** A lifecycle refusal, HTTP-shaped: the code is the status the API mirror
 * sends (401 unknown token · 403 wrong seat/surface · 409 room state said no);
 * the ws layer sends just the spoken error. */
export type Refusal = { ok: false; error: string; code: 401 | 403 | 409 }

export class Room {
  readonly code: string
  readonly seed: number
  tickMs = TICK_MS_DEFAULT
  /** Round budgets preset at HTTP create time — used as the start defaults so a
   * curl-created dev-fast room needs no arguments at start. */
  presetRound1?: number
  presetRound2?: number
  /** Auto-advance the weave when a round's budget is spent (DEFAULT ON —
   * pickup games flow; the talk turns it off at create/start). */
  autoAdvance = true
  /** When the pending auto `phase` command fires (null = none pending). */
  private autoAdvanceAt: number | null = null
  /** Host tapped HOLD — suspend auto-advance until the host calls the phase. */
  private autoHeld = false
  private lastShownSec: number | null = null
  started = false
  sim: SimState | null = null
  lastTickAt = 0
  /** The full command log — replay is the take-home artifact (D5). */
  readonly log: Array<{ atTick: number; cmd: Command }> = []
  seats: Seat[] = []
  private draftSerial = 0 // per-room apprentice request ids (q1, q2, …)
  private members = new Map<WebSocket, number>() // ws -> seat index
  private watchers = new Set<WebSocket>() // the big screen(s)
  private emptyAt: number | null = null

  constructor(code: string) {
    this.code = code
    this.seed = seedFromCode(code)
  }

  get empty(): boolean {
    return this.members.size === 0 && this.watchers.size === 0
  }
  emptyForMs(now: number): number {
    return this.emptyAt === null ? 0 : now - this.emptyAt
  }

  /** HTTP sign-of-life. An agent-played room may have NO websocket members at
   * all (the D4 BYO surface), so every API touch pushes the sweep horizon the
   * way a live socket would. No-op while sockets are attached. */
  touch(): void {
    if (this.empty) this.emptyAt = Date.now()
  }

  /** Which seat+surface does this token belong to? The ws/HTTP layers tag every
   * command with the answer — the hinge check lives on the server, not the client. */
  auth(token: string): { seat: number; role: Role } | null {
    if (!token) return null
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i].workerToken === token) return { seat: i, role: 'worker' }
      if (this.seats[i].hingeToken === token) return { seat: i, role: 'hinge' }
    }
    return null
  }

  handle(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'join': return this.join(ws, msg.name, msg.key)
      case 'watch': return this.watch(ws)
      case 'start': {
        const r = this.tryStart(msg.token, msg.tickMs, msg.round1Ticks, msg.round2Ticks, msg.autoAdvance)
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'phase': {
        const r = this.tryPhase(msg.token, msg.to)
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'hold': {
        const r = this.tryHold(msg.token)
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'draft': {
        const who = this.auth(msg.token)
        if (!who) return send(ws, { type: 'error', message: 'bad token' })
        if (who.role !== 'worker') return send(ws, { type: 'error', message: 'drafts come from the worker surface — use the worker token' })
        const r = this.command({ t: 'draftAccepted', player: who.seat, script: msg.script, tier: msg.tier })
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'draftRequest': {
        // asking the apprentice is safe from either surface (the drafts still
        // land unarmed; the hinge stays the only way anything runs)
        const who = this.auth(msg.token)
        if (!who) return send(ws, { type: 'error', message: 'bad token' })
        const r = this.requestDrafts(who.seat, msg.tier === 'smart' ? 'smart' : 'cheap', msg.order)
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'oracle': {
        const who = this.auth(msg.token)
        if (!who) return send(ws, { type: 'error', message: 'bad token' })
        const r = this.command({ t: 'oracleCheck', player: who.seat, id: msg.id })
        if (!r.ok) return send(ws, { type: 'error', message: r.error })
        // full report (verdict + dry-run prediction) goes back to the requester
        const slot = this.sim!.players[who.seat].scripts.find((sl) => sl.script.id === msg.id)
        if (slot) send(ws, { type: 'oracleReport', id: msg.id, report: oracle(this.sim!, who.seat, slot.script) })
        return
      }
      case 'arm': {
        const who = this.auth(msg.token)
        if (!who) return send(ws, { type: 'error', message: 'bad token' })
        // THE HINGE: only the human surface can arm. No worker path exists.
        if (who.role !== 'hinge') return send(ws, { type: 'error', message: 'ARM requires the hinge token — only the human seat can arm a script' })
        const r = this.command({ t: 'arm', player: who.seat, id: msg.id })
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'disarm': {
        const who = this.auth(msg.token)
        if (!who) return send(ws, { type: 'error', message: 'bad token' })
        // D4 tightening (per the D3 flag): disarm is script-LIFECYCLE control,
        // so it lives on the human surface with arm. The oracle's autoDisarm
        // is sim-internal and unaffected.
        if (who.role !== 'hinge') return send(ws, { type: 'error', message: 'Disarm is script-lifecycle control — use the hinge token.' })
        const r = this.command({ t: 'disarm', player: who.seat, id: msg.id })
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'scrap': {
        // freeing a hand slot is safe from either surface (like disarm) — the
        // D3 apprentice will tidy its own failures
        const who = this.auth(msg.token)
        if (!who) return send(ws, { type: 'error', message: 'bad token' })
        const r = this.command({ t: 'scrap', player: who.seat, id: msg.id })
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'ping': return send(ws, { type: 'pong' })
    }
  }

  private online(i: number): boolean {
    for (const idx of this.members.values()) if (idx === i) return true
    return false
  }

  /** Seat a player — or reconnect one by key with the SAME tokens (chips'
   * rejoin-by-key pattern). Shared by ws join and HTTP join (D4): a started
   * room admits reconnects only; a full room refuses. */
  seatJoin(rawName: string, rawKey: string): { ok: true; seat: number; rejoined: boolean } | Refusal {
    const name = (rawName || '').trim().slice(0, 16) || 'Player'
    const key = (rawKey || '').slice(0, 40)
    const reI = key ? this.seats.findIndex((s) => s.key === key) : -1
    if (reI >= 0) return { ok: true, seat: reI, rejoined: true }
    if (this.started) return { ok: false, error: 'That game already started. Try another room code.', code: 409 }
    if (this.seats.length >= MAX_PLAYERS) return { ok: false, error: 'This room is full.', code: 409 }
    const index = this.seats.length
    this.seats.push({ key, name, workerToken: mintToken('w'), hingeToken: mintToken('h'), lastWorkerSeenAt: null })
    return { ok: true, seat: index, rejoined: false }
  }

  private join(ws: WebSocket, rawName: string, rawKey: string): void {
    if (!rawKey) {
      send(ws, { type: 'error', message: 'missing client key' })
      return
    }
    const r = this.seatJoin(rawName, rawKey)
    if (!r.ok) {
      send(ws, { type: 'error', message: r.error })
      return
    }
    if (r.rejoined) {
      const prev = [...this.members.entries()].find(([, idx]) => idx === r.seat)?.[0]
      if (prev && prev !== ws) prev.close() // one live socket per seat — new tab supersedes
    }
    this.members.set(ws, r.seat)
    this.emptyAt = null
    this.welcome(ws, r.seat)
    this.broadcastLobby()
    if (r.rejoined) this.pushSnapshots()
  }

  private watch(ws: WebSocket): void {
    this.watchers.add(ws)
    this.emptyAt = null
    send(ws, { type: 'lobby', room: this.code, players: this.lobbyPlayers(), isHost: false, started: this.started, tickMs: this.tickMs })
    if (this.started) send(ws, { type: 'snapshot', view: this.viewFor(null) })
  }

  /** Room settings preset at creation (the HTTP create body) — the same clamps
   * start applies, held as the start defaults so dev-fast rooms stay possible. */
  configure(opts: { tickMs?: number; round1Ticks?: number; round2Ticks?: number; autoAdvance?: boolean }): void {
    if (typeof opts.tickMs === 'number') this.tickMs = Math.max(TICK_MS_MIN, Math.min(TICK_MS_MAX, Math.floor(opts.tickMs)))
    if (typeof opts.round1Ticks === 'number') this.presetRound1 = clampRound(opts.round1Ticks, ROUND1_TICKS_DEFAULT)
    if (typeof opts.round2Ticks === 'number') this.presetRound2 = clampRound(opts.round2Ticks, ROUND2_TICKS_DEFAULT)
    if (typeof opts.autoAdvance === 'boolean') this.autoAdvance = opts.autoAdvance
  }

  /** Start the game — a HOST act on the HUMAN surface (hinge token, seat 0).
   * Shared by ws start and HTTP start; the refusal carries the HTTP status. */
  tryStart(token: string, tickMs?: number, round1Ticks?: number, round2Ticks?: number, autoAdvance?: boolean): { ok: true } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (who.seat !== 0) return { ok: false, error: 'Only the host can start the game.', code: 403 }
    if (who.role !== 'hinge') return { ok: false, error: 'Starting the game is a human act — use the hinge token.', code: 403 }
    if (this.started) return { ok: false, error: 'The game already started.', code: 409 }
    if (tickMs !== undefined) this.tickMs = Math.max(TICK_MS_MIN, Math.min(TICK_MS_MAX, Math.floor(tickMs)))
    if (autoAdvance !== undefined) this.autoAdvance = autoAdvance
    this.sim = newGame(this.seed, this.seats.length, this.seats.map((s) => s.name), {
      round1: clampRound(round1Ticks ?? this.presetRound1, ROUND1_TICKS_DEFAULT),
      round2: clampRound(round2Ticks ?? this.presetRound2, ROUND2_TICKS_DEFAULT),
    })
    this.started = true
    this.lastTickAt = Date.now()
    this.broadcastLobby()
    this.pushSnapshots()
    return { ok: true }
  }

  /** Advance the weave — the same host-hinge act as start. Shared ws + HTTP. */
  tryPhase(token: string, to: SimPhase): { ok: true } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (who.seat !== 0) return { ok: false, error: 'Only the host advances the round.', code: 403 }
    if (who.role !== 'hinge') return { ok: false, error: 'Advancing the round is a human act — use the hinge token.', code: 403 }
    const r = this.command({ t: 'phase', to })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    this.lastTickAt = Date.now() // a fresh round gets a full tick interval
    return { ok: true }
  }

  /** HOLD a pending auto-advance — the host's "wait, we're talking" tap.
   * Suspends auto-advance until the host manually calls the phase (which
   * clears the hold). Host-hinge, like phase itself. */
  tryHold(token: string): { ok: true } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (who.seat !== 0) return { ok: false, error: 'Only the host holds the round.', code: 403 }
    if (who.role !== 'hinge') return { ok: false, error: 'Holding the round is a human act — use the hinge token.', code: 403 }
    if (!this.started || !this.sim) return { ok: false, error: 'The game has not started yet.', code: 409 }
    this.autoHeld = true
    this.autoAdvanceAt = null
    this.lastShownSec = null
    this.pushSnapshots()
    return { ok: true }
  }

  /** Apply a seat-stamped command; log it on success. Shared by ws and HTTP. */
  command(cmd: Command): { ok: true } | { ok: false; error: string } {
    if (!this.sim) return { ok: false, error: 'The game has not started yet.' }
    try {
      apply(this.sim, cmd)
      this.log.push({ atTick: this.sim.tick, cmd })
      if (cmd.t === 'phase') {
        // ANY phase advance (host tap or auto) clears the pending countdown +
        // hold and grants the fresh round a full tick interval
        this.autoAdvanceAt = null
        this.autoHeld = false
        this.lastShownSec = null
        this.lastTickAt = Date.now()
      }
      this.pushSnapshots() // snapshots on change
      return { ok: true }
    } catch (e) {
      if (e instanceof RuleError) return { ok: false, error: e.message }
      throw e
    }
  }

  // ── The apprentice (D3): async draft flow, latency absorbed ────────────────
  // draftRequested debits NOW; the LLM call runs in the background; arriving
  // drafts enter the LOG as data (0-cost draftAccepted with the reqId), so a
  // replay never re-calls the model. Timeout/gibberish paths refund or fall
  // back — all through logged commands. Shared by ws and HTTP.

  requestDrafts(seat: number, tier: DraftTier, order?: string): { ok: true; reqId: string } | { ok: false; error: string } {
    const reqId = `q${++this.draftSerial}`
    const r = this.command({ t: 'draftRequested', player: seat, reqId, tier })
    if (!r.ok) return r
    void this.fulfillDrafts(seat, tier, reqId, order) // background; every exit path is a logged command
    return { ok: true, reqId }
  }

  /** What the apprentice may know: its OWN workshop + the public world. */
  private seatBrief(seat: number): SeatBrief {
    const sim = this.sim!
    const w = sim.players[seat]
    return {
      phase: sim.phase,
      tick: sim.tick,
      market: sim.market,
      gremlin: sim.gremlin,
      tokens: w.tokens,
      matter: w.matter,
      widgets: w.widgets,
      hand: w.scripts.map((sl) => ({
        verb: sl.script.verb,
        params: sl.script.params,
        ...(sl.script.when ? { when: sl.script.when } : {}),
        status: sl.status,
        armed: sl.armed,
      })),
    }
  }

  private async fulfillDrafts(seat: number, tier: DraftTier, reqId: string, order?: string): Promise<void> {
    try {
      const cfg = apprenticeConfig()
      let drafts: Script[]
      let organic = false
      if (!cfg) {
        // PRACTICE MODE — no model wired; the seeded generator stands in
        drafts = practiceDrafts(this.seed, this.sim!.tick, seat, reqId, tier)
      } else {
        try {
          drafts = await fetchDrafts(cfg, tier, this.seatBrief(seat), order)
        } catch (e) {
          // network/timeout — refund through the log (spoken-friendly event)
          console.log(`[apprentice] ${this.code} seat ${seat} ${reqId}: ${e instanceof Error ? e.message : e} — refunding`)
          this.command({ t: 'draftFailed', player: seat, reqId, reason: 'timeout' })
          return
        }
        if (drafts.length === 0) {
          // ORGANIC hallucination: the model really returned gibberish — the
          // player still gets a (flawed) draft; logged honestly
          organic = true
          console.log(`[apprentice] ${this.code} seat ${seat} ${reqId}: unparseable model output — organic hallucination fallback`)
          drafts = [fallbackDraft(this.seed, this.sim!.tick, seat, reqId)]
        }
      }
      // the hybrid design: seeded flaw injection at the tier rate, deterministic
      // per room+tick+seat+request (organic fallback is already flawed)
      const atTick = this.sim!.tick
      const delivered = organic
        ? drafts.map((script) => ({ script, flawed: true }))
        : injectApprenticeFlaws(drafts, this.seed, atTick, seat, reqId, tier)
      let landed = 0
      delivered.forEach(({ script }, i) => {
        script.id = `${reqId}${String.fromCharCode(97 + i)}` // q3a, q3b, q3c
        const r = this.command({ t: 'draftAccepted', player: seat, script, tier, reqId })
        if (r.ok) landed++
        else console.log(`[apprentice] ${this.code} seat ${seat} ${reqId}: draft ${script.id} rejected (${r.error})`)
      })
      if (landed > 0) this.command({ t: 'draftSettled', player: seat, reqId })
      else this.command({ t: 'draftFailed', player: seat, reqId, reason: 'no drafts landed' })
    } catch (e) {
      // belt and braces: never leave escrow dangling
      console.error(`[apprentice] ${this.code} seat ${seat} ${reqId}: unexpected`, e)
      this.command({ t: 'draftFailed', player: seat, reqId, reason: 'apprentice error' })
    }
  }

  private welcome(ws: WebSocket, index: number): void {
    const seat = this.seats[index]
    // the ONE message that carries auth tokens — to their own seat only
    send(ws, {
      type: 'welcome',
      index,
      room: this.code,
      isHost: index === 0,
      you: seat.name,
      workerToken: seat.workerToken,
      hingeToken: seat.hingeToken,
    })
  }

  private lobbyPlayers(): LobbyPlayer[] {
    const now = Date.now()
    return this.seats.map((s, i) => ({
      index: i,
      name: s.name,
      online: this.online(i),
      agentSeenAgoMs: s.lastWorkerSeenAt === null ? null : now - s.lastWorkerSeenAt,
    }))
  }

  broadcastLobby(): void {
    const players = this.lobbyPlayers()
    for (const [ws, idx] of this.members) {
      send(ws, { type: 'lobby', room: this.code, players, isHost: idx === 0, started: this.started, tickMs: this.tickMs })
    }
    for (const ws of this.watchers) {
      send(ws, { type: 'lobby', room: this.code, players, isHost: false, started: this.started, tickMs: this.tickMs })
    }
  }

  /** REDACTION lives here: everyone sees resources/scores/script fates; only
   * your own seat sees script BODIES; auth tokens appear in no view ever. */
  viewFor(seatIndex: number | null): RoomView {
    const sim = this.sim
    const now = Date.now()
    const players: PlayerView[] = sim
      ? sim.players.map((w, i) => ({
          index: i,
          name: w.name,
          online: this.online(i),
          agentSeenAgoMs: this.seats[i]?.lastWorkerSeenAt == null ? null : now - this.seats[i].lastWorkerSeenAt!,
          score: score(w),
          tokens: w.tokens,
          matter: w.matter,
          widgets: w.widgets,
          widgetsSold: w.widgetsSold,
          disasters: w.disasters,
          uptime: w.uptime,
          waste: w.waste,
          scripts: w.scripts.map((sl) => ({
            id: sl.script.id,
            status: sl.status,
            armed: sl.armed,
            yolo: sl.yolo,
            verdictOk: sl.lastVerdict ? sl.lastVerdict.ok : null,
          })),
        }))
      : []
    return {
      room: this.code,
      started: this.started,
      tickMs: this.tickMs,
      tick: sim?.tick ?? 0,
      phase: sim?.phase ?? 'lobby',
      ticksRemaining: sim ? ticksRemaining(sim) : 0,
      autoAdvance: this.autoAdvance,
      autoAdvanceIn: this.countdownSec(now),
      autoHeld: this.autoHeld,
      // ms until the next world tick fires (null when the world holds still) —
      // the client's wall-clock countdown anchors on this
      nextTickInMs: this.started && sim && ticksRunning(sim) ? Math.max(0, this.lastTickAt + this.tickMs - now) : null,
      market: sim?.market ?? 0,
      gremlin: sim?.gremlin ?? 0,
      events: sim?.events ?? [],
      eventSeq: sim?.eventSeq ?? 0,
      players,
      round1Summary: sim?.round1Summary ?? null,
      round2Summary: sim?.round2Summary ?? null,
      delta: sim && sim.phase === 'reveal' ? computeDelta(sim) : null,
      apprentice: apprenticeMode(),
      you:
        seatIndex !== null && sim && sim.players[seatIndex]
          ? { index: seatIndex, hand: sim.players[seatIndex].scripts, pending: sim.players[seatIndex].pending }
          : null,
    }
  }

  /** The command log + seed (GET /api/room/:pin/log — replay theater's feed).
   * Redaction: a draft's params/condition are hand-private, so entries from
   * OTHER seats are stripped to { id, verb }. The HOST token unlocks the full
   * log once the room is in 'reveal' (the take-home artifact), never before. */
  logView(token: string): RoomLogView {
    const who = this.auth(token)
    const seat = who ? who.seat : null
    const hostFull = seat === 0 && this.sim?.phase === 'reveal'
    const log = this.log.map(({ atTick, cmd }) => {
      if (cmd.t === 'draftAccepted' && !hostFull && cmd.player !== seat) {
        return {
          atTick,
          cmd: {
            t: cmd.t,
            player: cmd.player,
            tier: cmd.tier,
            script: { id: cmd.script.id, verb: cmd.script.verb }, // params + when REDACTED
          } as Record<string, unknown>,
        }
      }
      return { atTick, cmd: cmd as unknown as Record<string, unknown> }
    })
    return {
      room: this.code,
      seed: this.seed,
      phase: this.sim?.phase ?? 'lobby',
      tickMs: this.tickMs,
      phaseTicks: this.sim?.phaseTicks ?? { round1: 0, round2: 0 },
      log,
    }
  }

  pushSnapshots(): void {
    if (!this.started || !this.sim) return
    for (const [ws, idx] of this.members) send(ws, { type: 'snapshot', view: this.viewFor(idx) })
    for (const ws of this.watchers) send(ws, { type: 'snapshot', view: this.viewFor(null) })
  }

  /** Advance the sim if this room's tick is due (called by the server loop). */
  maybeTick(now: number): void {
    if (!this.started || !this.sim) return
    this.maybeAutoAdvance(now)
    if (!this.sim) return // (belt+braces — auto-advance never clears it)
    if (!ticksRunning(this.sim)) return // frozen phase / spent budget — hold still
    if (now - this.lastTickAt < this.tickMs) return
    this.lastTickAt = now
    tick(this.sim)
    this.pushSnapshots()
  }

  /** The auto-advance driver (the D6 hotfix): when a round's budget is spent
   * — the state that used to freeze SILENTLY — the room issues the same
   * logged host `phase` command itself after a visible countdown, so pickup
   * games flow without a host who knows the script. The intermission gets a
   * fixed dwell first (the summary must be readable); the reveal never
   * advances. Replay determinism is untouched: the sim only ever sees a
   * `phase` command in the log, whoever issued it. */
  private maybeAutoAdvance(now: number): void {
    const s = this.sim!
    if (!this.autoAdvance || this.autoHeld) return
    const next = PHASE_NEXT[s.phase]
    if (!next) return // reveal — the delta board tells the story, forever
    let delay = AUTO_MS
    if (s.phase === 'round1' || s.phase === 'round2') {
      const budget = s.phaseTicks[s.phase]
      if (budget <= 0 || s.tick < budget) {
        this.autoAdvanceAt = null // budget not spent (or unlimited) — nothing pending
        return
      }
    } else {
      delay = DWELL_MS + AUTO_MS // intermission: dwell, then the countdown
    }
    if (this.autoAdvanceAt === null) {
      this.autoAdvanceAt = now + delay
      this.lastShownSec = null
      this.pushSnapshots() // the "round complete" state lands immediately
      return
    }
    if (now >= this.autoAdvanceAt) {
      const r = this.command({ t: 'phase', to: next }) // logged like the host's tap
      if (!r.ok) {
        console.error(`[auto-advance] ${this.code}: phase→${next} refused (${r.error})`)
        this.autoAdvanceAt = null
      }
      return
    }
    // push a snapshot when the displayed second changes (the countdown lives
    // in the view; ticks are frozen so nothing else would push)
    const sec = this.countdownSec(now)
    if (sec !== this.lastShownSec) {
      this.lastShownSec = sec
      this.pushSnapshots()
    }
  }

  /** Seconds until auto-advance, in the VISIBLE window only (the intermission
   * dwell reads as null — the summary is the screen's job right then). */
  private countdownSec(now: number): number | null {
    if (this.autoAdvanceAt === null) return null
    const remain = this.autoAdvanceAt - now
    if (remain > AUTO_MS) return null
    return Math.max(0, Math.ceil(remain / 1000))
  }

  /** An agent spoke on the HTTP worker surface — the dyad liveness signal. */
  noteWorkerSeen(seat: number): void {
    const s = this.seats[seat]
    if (!s) return
    s.lastWorkerSeenAt = Date.now()
    if (!this.started) this.broadcastLobby() // phones see "agent connected" pre-start
    else this.pushSnapshots() // in-game: the dyad indicator updates the moment the agent speaks
  }

  handleClose(ws: WebSocket): void {
    this.watchers.delete(ws)
    if (this.members.has(ws)) {
      this.members.delete(ws)
      this.broadcastLobby()
    }
    if (this.empty) this.emptyAt = Date.now()
  }
}

export class RoomRegistry {
  private rooms = new Map<string, Room>()
  private socketRoom = new Map<WebSocket, Room>()

  route(ws: WebSocket, raw: string): void {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.type === 'join' || msg.type === 'watch') {
      const code = normalizeCode(msg.room)
      let room: Room | undefined
      if (msg.type === 'join' && code === '') {
        room = this.create() // empty PIN = open a new room
      } else {
        room = this.rooms.get(code)
        if (!room) {
          send(ws, { type: 'error', message: `No room '${code || '?'}' — check the PIN.` })
          return
        }
      }
      this.socketRoom.set(ws, room)
      room.handle(ws, msg)
      return
    }
    const room = this.socketRoom.get(ws)
    if (room) room.handle(ws, msg)
  }

  create(): Room {
    const room = new Room(this.newCode())
    this.rooms.set(room.code, room)
    return room
  }

  /** chips' Registry.newCode(): 4 letters, no I/O — read-aloud friendly. */
  private newCode(): string {
    for (;;) {
      let code = ''
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
      if (!this.rooms.has(code)) return code
    }
  }

  get(code: string): Room | undefined {
    return this.rooms.get(normalizeCode(code))
  }

  close(ws: WebSocket): void {
    const room = this.socketRoom.get(ws)
    if (!room) return
    room.handleClose(ws)
    this.socketRoom.delete(ws)
    // instant-delete only NEVER-SEATED rooms (a watcher peeked and left); a
    // seated lobby may hold HTTP-joined agents with no socket — the sweep's
    // TTL owns those (Room.touch keeps live ones alive).
    if (room.empty && !room.started && room.seats.length === 0) this.rooms.delete(room.code)
  }

  /** Drop rooms abandoned longer than ttlMs so idle sims don't tick forever. */
  sweep(now: number, ttlMs: number): void {
    for (const room of [...this.rooms.values()]) {
      if (room.empty && room.emptyForMs(now) > ttlMs) this.rooms.delete(room.code)
    }
  }

  all(): Room[] {
    return [...this.rooms.values()]
  }
}

function normalizeCode(code: string): string {
  return (code || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LENGTH)
}
