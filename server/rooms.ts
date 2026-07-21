// Room registry — ARK PIVOT. Each room owns ONE authoritative settlement sim,
// CONTINUOUS from creation: no lobby phase, no rounds — dyads drop in anytime
// (joinDistrict is a logged command, so replays reproduce the join order).
// Each tick the server runs every deployed script through the shared Go
// engine subprocess and logs the emitted ACTIONS AS DATA (scriptTick); the
// sim applies them deterministically. Engine faults = seat faults (that
// seat's scripts skip the tick) — never replay state.
//
// TWO-token seats remain: workerToken (agent: deploy/oracle/read) and
// hingeToken (human: the LAUNCH VOTE; host confirm). The deploy gate:
// scope='shared' deploys REQUIRE an oracle-green engine dry-run — enforced
// here (409) AND in the sim (backstop), proven by wstest.

import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import { CODE_ALPHABET, CODE_LENGTH, seedFromCode, TICK_MS_DEFAULT, TICK_MS_MAX, TICK_MS_MIN } from '../shared/mpConfig.ts'
import type { DyadView, OwnScriptView, PublicScriptView, RoomLogView, RoomView, ClientMessage, ServerMessage } from '../shared/protocol.ts'
import { judgeDryRun, staticCheck, type OracleReport } from '../shared/sim/oracle.ts'
import { apply, goVotes, newGame, replay as simReplay, RuleError, scriptSlots, stateHash, tick, ticksRunning } from '../shared/sim/sim.ts'
import { milestoneFrontier, nextStorm } from '../shared/sim/world.ts'
import { ORACLE_COST, ORACLE_GAS_LIMIT, SCRIPT_GAS_LIMIT, SCRIPT_RUN_COST } from '../shared/sim/balance.ts'
import type { Command, DeployedScript, ScriptScope, SimState } from '../shared/sim/types.ts'
import { engineHost, type EngineHost } from './engine.ts'

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

export type Role = 'worker' | 'hinge'

interface Seat {
  key: string
  name: string
  workerToken: string
  hingeToken: string
  lastWorkerSeenAt: number | null
}

function mintToken(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`
}

export function mintKey(): string {
  return `k_${randomBytes(9).toString('base64url')}`
}

/** A lifecycle refusal, HTTP-shaped: 400 malformed · 401 unknown token ·
 * 403 wrong seat/surface · 409 the game said no (incl. THE DEPLOY GATE). */
export type Refusal = { ok: false; error: string; code: 400 | 401 | 403 | 409; report?: OracleReport }

export class Room {
  readonly code: string
  readonly seed: number
  tickMs = TICK_MS_DEFAULT
  readonly sim: SimState
  lastTickAt = 0
  /** The full command log — the replay artifact. */
  readonly log: Array<{ atTick: number; cmd: Command }> = []
  seats: Seat[] = []
  private scriptSerial = 0
  private ticking = false
  private members = new Map<WebSocket, number>()
  private watchers = new Set<WebSocket>()
  private emptyAt: number | null = null
  private engine: EngineHost
  /** Per-script persistent KV (round-tripped to the engine each tick).
   * Server-side only — NOT replay state (replays re-apply logged actions). */
  private memories = new Map<string, Record<string, unknown>>()

  constructor(code: string, engine?: EngineHost) {
    this.code = code
    this.seed = seedFromCode(code)
    this.sim = newGame(this.seed)
    this.engine = engine ?? engineHost()
    this.lastTickAt = Date.now()
  }

  get empty(): boolean {
    return this.members.size === 0 && this.watchers.size === 0
  }
  emptyForMs(now: number): number {
    return this.emptyAt === null ? 0 : now - this.emptyAt
  }
  touch(): void {
    if (this.empty) this.emptyAt = Date.now()
  }

  auth(token: string): { seat: number; role: Role } | null {
    if (!token) return null
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i].workerToken === token) return { seat: i, role: 'worker' }
      if (this.seats[i].hingeToken === token) return { seat: i, role: 'hinge' }
    }
    return null
  }

  configure(opts: { tickMs?: number }): void {
    if (typeof opts.tickMs === 'number') this.tickMs = Math.max(TICK_MS_MIN, Math.min(TICK_MS_MAX, Math.floor(opts.tickMs)))
  }

  // ── ws routing ─────────────────────────────────────────────────────────────

  handle(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'join': return this.wsJoin(ws, msg.name, msg.key)
      case 'watch': return this.watch(ws)
      case 'deploy': {
        void this.tryDeploy(msg.token, msg.id, msg.name ?? '', msg.source, msg.scope).then((r) => {
          if (!r.ok) send(ws, { type: 'error', message: r.error })
        })
        return
      }
      case 'undeploy': {
        const who = this.auth(msg.token)
        if (!who) return send(ws, { type: 'error', message: 'bad token' })
        const r = this.command({ t: 'undeploy', player: who.seat, id: msg.id })
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'oracle': {
        void this.tryOracle(msg.token, msg.id).then((r) => {
          if (!r.ok) return send(ws, { type: 'error', message: r.error })
          send(ws, { type: 'oracleReport', id: msg.id, report: r.report })
        })
        return
      }
      case 'vote': {
        const r = this.tryVote(msg.token, msg.go)
        if (!r.ok) send(ws, { type: 'error', message: r.error })
        return
      }
      case 'launch': {
        const r = this.tryLaunch(msg.token)
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

  /** Seat a dyad — DROP-IN: joining is open until the launch (or a full
   * settlement). Reconnect-by-key returns the same seat + tokens. */
  seatJoin(rawName: string, rawKey: string): { ok: true; seat: number; rejoined: boolean } | Refusal {
    const name = (rawName || '').trim().slice(0, 16) || `Dyad ${this.seats.length + 1}`
    const key = (rawKey || '').slice(0, 40)
    const reI = key ? this.seats.findIndex((s) => s.key === key) : -1
    if (reI >= 0) return { ok: true, seat: reI, rejoined: true }
    const index = this.seats.length
    // the sim owns the join rules (launched? full?) — try the logged command
    const r = this.command({ t: 'joinDistrict', name })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    this.seats.push({ key, name, workerToken: mintToken('w'), hingeToken: mintToken('h'), lastWorkerSeenAt: null })
    return { ok: true, seat: index, rejoined: false }
  }

  private wsJoin(ws: WebSocket, rawName: string, rawKey: string): void {
    if (!rawKey) return send(ws, { type: 'error', message: 'missing client key' })
    const r = this.seatJoin(rawName, rawKey)
    if (!r.ok) return send(ws, { type: 'error', message: r.error })
    if (r.rejoined) {
      const prev = [...this.members.entries()].find(([, idx]) => idx === r.seat)?.[0]
      if (prev && prev !== ws) prev.close()
    }
    this.members.set(ws, r.seat)
    this.emptyAt = null
    const seat = this.seats[r.seat]
    send(ws, {
      type: 'welcome',
      index: r.seat,
      room: this.code,
      isHost: r.seat === 0,
      you: seat.name,
      workerToken: seat.workerToken,
      hingeToken: seat.hingeToken,
    })
    this.pushSnapshots()
  }

  private watch(ws: WebSocket): void {
    this.watchers.add(ws)
    this.emptyAt = null
    send(ws, { type: 'snapshot', view: this.viewFor(null) })
  }

  /** Apply a seat-stamped command; log it on success. Shared by ws and HTTP. */
  command(cmd: Command): { ok: true } | { ok: false; error: string } {
    try {
      apply(this.sim, cmd)
      this.log.push({ atTick: this.sim.tick, cmd })
      this.pushSnapshots()
      return { ok: true }
    } catch (e) {
      if (e instanceof RuleError) return { ok: false, error: e.message }
      throw e
    }
  }

  // ── The deploy gate + oracle (the REAL engine dry-run) ─────────────────────

  /** The world exactly as seat `p`'s scripts see it this tick. */
  worldViewFor(p: number): Record<string, unknown> {
    const s = this.sim
    const d = s.dyads[p]
    const next = nextStorm(s.seed, s.tick)
    return {
      tick: s.tick,
      district: p,
      you: d ? { tokens: d.tokens, ore: d.ore, food: d.food, parts: d.parts, integrity: d.integrity } : null,
      veins: s.veins.map((v) => ({ id: v.id, rate: v.rate, reserve: v.reserve })),
      structures: Object.fromEntries(
        (['wall', 'granary', 'beacon', 'ark'] as const).map((k) => {
          const st = s.structures[k]
          return [k, { parts: st.parts, required: st.partsRequired, complete: st.complete, hp: st.hp, hpMax: st.hpMax }]
        }),
      ),
      granaryFood: s.granaryFood,
      survivors: s.survivors,
      storm: { inTicks: next.tick - s.tick, severity: next.severity },
      frontier: milestoneFrontier(s),
      dyads: s.dyads.map((x) => ({ name: x.name, district: x.district, parts: x.parts, contributed: x.contributed })),
    }
  }

  /** Run the ORACLE on source for seat p: real engine dry-run (fresh memory,
   * current world) + static checks + action schema. Deterministic; pure. */
  private async oracleRun(p: number, source: string): Promise<OracleReport | { engineDown: string }> {
    const sc = staticCheck(source)
    if (!sc.ok) return { ok: false, reasons: sc.reasons, actions: [], logs: [], gasUsed: 0 }
    if (!this.engine.available) return { engineDown: 'the oracle is dark — script engine unavailable on this server' }
    try {
      const out = await this.engine.run({
        script: source,
        world: this.worldViewFor(p),
        seed: this.seed,
        tick: this.sim.tick,
        gasLimit: ORACLE_GAS_LIMIT,
        memory: {},
      })
      return judgeDryRun(source, { actions: out.actions, logs: out.logs, gasUsed: out.gasUsed, err: out.err ?? null })
    } catch (e) {
      return { engineDown: `the oracle faulted: ${e instanceof Error ? e.message : e}` }
    }
  }

  /** Deploy a script. district scope: lands immediately (YOLO allowed — your
   * rubble). shared scope: THE GATE — an oracle-green dry-run is REQUIRED;
   * red or dark ⇒ refusal (HTTP 409), nothing logged. */
  async tryDeploy(token: string, idRaw: string | undefined, nameRaw: string, source: string, scope: ScriptScope): Promise<{ ok: true; id: string; verified: boolean; report?: OracleReport } | Refusal> {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (typeof source !== 'string' || source.trim() === '') return { ok: false, error: 'missing script source', code: 400 }
    if (scope !== 'district' && scope !== 'shared') return { ok: false, error: "scope must be 'district' or 'shared'", code: 400 }
    const id = (idRaw || '').trim() || `s${++this.scriptSerial}`
    if (scope === 'shared') {
      const report = await this.oracleRun(who.seat, source)
      if ('engineDown' in report) return { ok: false, error: report.engineDown, code: 409 }
      if (!report.ok) {
        return { ok: false, error: `THE GATE: oracle red — ${report.reasons[0] ?? 'verification failed'}`, code: 409, report }
      }
      const r = this.command({ t: 'deploy', player: who.seat, id, name: nameRaw, source, scope, verified: true, verdict: { ok: true, reasons: report.reasons } })
      if (!r.ok) return { ok: false, error: r.error, code: 409 }
      this.memories.delete(`${who.seat}:${id}`)
      return { ok: true, id, verified: true, report }
    }
    const r = this.command({ t: 'deploy', player: who.seat, id, name: nameRaw, source, scope, verified: false })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    this.memories.delete(`${who.seat}:${id}`)
    return { ok: true, id, verified: false }
  }

  /** The paid oracle check on an already-deployed script. */
  async tryOracle(token: string, id: string): Promise<{ ok: true; report: OracleReport } | Refusal> {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    const d = this.sim.dyads[who.seat]
    const sc = d?.scripts.find((x) => x.id === id)
    if (!sc) return { ok: false, error: `no script '${id}' in your district`, code: 409 }
    if (d.tokens < ORACLE_COST) return { ok: false, error: `not enough ⚡ (an oracle check costs ${ORACLE_COST})`, code: 409 }
    const report = await this.oracleRun(who.seat, sc.source)
    if ('engineDown' in report) return { ok: false, error: report.engineDown, code: 409 }
    const r = this.command({ t: 'oracleResult', player: who.seat, id, ok: report.ok, reasons: report.reasons })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    return { ok: true, report }
  }

  /** THE HINGE: voting is the human's voice — hinge token only. */
  tryVote(token: string, go: boolean): { ok: true } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (who.role !== 'hinge') return { ok: false, error: 'the LAUNCH VOTE is the human\'s voice — hinge token only', code: 403 }
    const r = this.command({ t: 'vote', player: who.seat, go: go === true })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    return { ok: true }
  }

  /** Launch confirm: HOST (seat 0) on the hinge, majority already standing. */
  tryLaunch(token: string): { ok: true } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (who.seat !== 0) return { ok: false, error: 'only the host confirms the launch', code: 403 }
    if (who.role !== 'hinge') return { ok: false, error: 'the launch confirm is a human act — hinge token only', code: 403 }
    const r = this.command({ t: 'launch' })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    return { ok: true }
  }

  // ── The tick: engine runs → actions logged as data → world evolves ─────────

  maybeTick(now: number): void {
    if (this.ticking) return
    if (!ticksRunning(this.sim)) return
    if (now - this.lastTickAt < this.tickMs) return
    this.lastTickAt = now
    this.ticking = true
    void this.runTick()
      .catch((e) => console.error(`[room ${this.code}] tick error:`, e))
      .finally(() => {
        this.ticking = false
      })
  }

  /** One world tick: run every deployed script through the engine (sequential
   * — the engine round-trip is ms-fast and order must be deterministic), log
   * each result as a scriptTick command, then advance the world. */
  private async runTick(): Promise<void> {
    const s = this.sim
    for (let p = 0; p < s.dyads.length; p++) {
      const d = s.dyads[p]
      // snapshot the running list — commands during the loop may change it
      const running = d.scripts.filter((sc) => sc.status === 'running').map((sc) => sc.id)
      for (const id of running) {
        const sc = d.scripts.find((x) => x.id === id && x.status === 'running')
        if (!sc) continue
        if (d.tokens < SCRIPT_RUN_COST) {
          this.command({ t: 'scriptTick', player: p, id, actions: [], gasUsed: 0, starved: true })
          continue
        }
        const memKey = `${p}:${id}`
        try {
          const out = await this.engine.run({
            script: sc.source,
            world: this.worldViewFor(p),
            seed: this.seed,
            tick: s.tick,
            gasLimit: SCRIPT_GAS_LIMIT,
            memory: this.memories.get(memKey) ?? {},
          })
          this.memories.set(memKey, out.memory ?? {})
          this.command({ t: 'scriptTick', player: p, id, actions: out.actions, gasUsed: out.gasUsed, logs: out.logs.slice(0, 10), ...(out.err ? { err: out.err } : {}) })
        } catch (e) {
          // SEAT FAULT (timeout / crash / engine down): nothing logged — the
          // script simply does not act this tick; replay is untouched.
          console.error(`[room ${this.code}] seat ${p} script ${id}: engine fault (${e instanceof Error ? e.message : e}) — seat skips this tick`)
        }
      }
    }
    tick(s)
    this.pushSnapshots()
  }

  // ── Views (redaction lives here) ───────────────────────────────────────────

  /** Everyone sees the settlement, structures, storms, fates, yield notes;
   * only your own seat sees script SOURCE (until the launch opens the books
   * via /log). Auth tokens appear in no view ever. */
  viewFor(seatIndex: number | null): RoomView {
    const s = this.sim
    const now = Date.now()
    const next = nextStorm(s.seed, s.tick)
    const publicScript = (sc: DeployedScript): PublicScriptView => ({
      id: sc.id,
      name: sc.name,
      scope: sc.scope,
      verified: sc.verified,
      status: sc.status,
      deployedAtTick: sc.deployedAtTick,
      lastNote: sc.lastTick?.note ?? null,
      errStreak: sc.errStreak,
    })
    const dyads: DyadView[] = s.dyads.map((d, i) => ({
      index: i,
      name: d.name,
      district: d.district,
      online: this.online(i),
      agentSeenAgoMs: this.seats[i]?.lastWorkerSeenAt == null ? null : now - this.seats[i].lastWorkerSeenAt!,
      tokens: d.tokens,
      ore: d.ore,
      food: d.food,
      parts: d.parts,
      contributed: d.contributed,
      integrity: d.integrity,
      stormDamage: d.stormDamage,
      vote: d.vote,
      scripts: d.scripts.map(publicScript),
    }))
    const you =
      seatIndex !== null && s.dyads[seatIndex]
        ? {
            index: seatIndex,
            isHost: seatIndex === 0,
            scripts: s.dyads[seatIndex].scripts.map(
              (sc): OwnScriptView => ({ ...publicScript(sc), source: sc.source, lastVerdict: sc.lastVerdict, lastTick: sc.lastTick }),
            ),
          }
        : null
    return {
      room: this.code,
      tickMs: this.tickMs,
      tick: s.tick,
      launched: s.launched,
      nextTickInMs: ticksRunning(s) ? Math.max(0, this.lastTickAt + this.tickMs - now) : null,
      storm: { nextAtTick: next.tick, inTicks: next.tick - s.tick, severity: next.severity, index: next.index },
      structures: s.structures,
      frontier: milestoneFrontier(s),
      granaryFood: s.granaryFood,
      survivors: s.survivors,
      scriptSlots: scriptSlots(s),
      votes: {
        go: goVotes(s),
        noGo: s.dyads.filter((d) => d.vote === false).length,
        pending: s.dyads.filter((d) => d.vote === null).length,
      },
      arkReady: s.structures.ark.complete,
      veins: s.veins,
      events: s.events,
      eventSeq: s.eventSeq,
      dyads,
      end: s.end,
      engine: this.engine.info(),
      you,
    }
  }

  /** The command log + REPLAY HEADER (seed + tickMs + the ENGINE identity —
   * logged actions are data, and the header records which engine emitted
   * them). Redaction: other seats' deploy SOURCE is stripped until the
   * launch; after it, the books are open for everyone. */
  logView(token: string): RoomLogView {
    const who = this.auth(token)
    const seat = who ? who.seat : null
    const open = this.sim.launched
    const log = this.log.map(({ atTick, cmd }) => {
      if (cmd.t === 'deploy' && !open && cmd.player !== seat) {
        const { source: _source, ...rest } = cmd
        return { atTick, cmd: { ...rest, source: '[redacted until launch]' } as Record<string, unknown> }
      }
      return { atTick, cmd: cmd as unknown as Record<string, unknown> }
    })
    return {
      room: this.code,
      seed: this.seed,
      tickMs: this.tickMs,
      tick: this.sim.tick,
      launched: this.sim.launched,
      engine: this.engine.info(),
      log,
    }
  }

  /** Replay identity check — re-run the log through a fresh sim and compare
   * hashes (exposed for wstest + the health of the record). */
  replayHash(): { live: string; replayed: string } {
    return {
      live: stateHash(this.sim),
      replayed: stateHash(simReplay(this.seed, this.log, this.sim.tick)),
    }
  }

  pushSnapshots(): void {
    for (const [ws, idx] of this.members) send(ws, { type: 'snapshot', view: this.viewFor(idx) })
    for (const ws of this.watchers) send(ws, { type: 'snapshot', view: this.viewFor(null) })
  }

  noteWorkerSeen(seat: number): void {
    const s = this.seats[seat]
    if (!s) return
    s.lastWorkerSeenAt = Date.now()
    this.pushSnapshots()
  }

  handleClose(ws: WebSocket): void {
    this.watchers.delete(ws)
    if (this.members.has(ws)) {
      this.members.delete(ws)
      this.pushSnapshots()
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
        room = this.create()
      } else {
        room = this.rooms.get(code)
        if (!room) {
          send(ws, { type: 'error', message: `No settlement '${code || '?'}' — check the PIN.` })
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
    if (room.empty && room.seats.length === 0) this.rooms.delete(room.code)
  }

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
