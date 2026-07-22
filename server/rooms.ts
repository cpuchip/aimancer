// Room registry — ARK PIVOT + THE OPENING BELL. Each room owns ONE
// authoritative settlement sim. A room is founded GATHERING: dyads drop in,
// connect agents, arm deploys, rehearse — but the world holds still (no
// ticks, no storms, no regen) until the HOST rings the start (host-hinge, a
// logged command — replays carry the bell). After the bell, play is
// CONTINUOUS: no rounds, drop-in joins unchanged (joinDistrict is a logged
// command, so replays reproduce the join order).
// Each tick the server runs every deployed script through the shared Go
// engine subprocess and logs the emitted ACTIONS AS DATA (scriptTick); the
// sim applies them deterministically. Engine faults = seat faults (that
// seat's scripts skip the tick) — never replay state.
//
// TWO-token seats remain: workerToken (agent: deploy/oracle/read) and
// hingeToken (human: the LAUNCH VOTE; host confirm; the seat's GATE POLICY).
//
// FREEDOM UPDATE (locked 2026-07-22): the server imposes NO verification on
// deploys — either scope, either token, direct. Each seat instead carries its
// OWN gate policy (hinge-configured: none | oracle-green | beta-pass |
// combos) and the server enforces each seat's policy on that seat's deploys.
// The engine sandbox (gas/determinism/memory walls) is the absolute floor;
// the LAUNCH VOTE stays hinge-only + host-confirm — the one irreducible hinge.
// New surfaces: the MIRROR YARD (beta-run — fork + rehearse, private report),
// the CHRONICLE (shared lore-memory, logged commands), and the hidden-surface
// registry (lore fragments, discovery celebrations).

import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import { CODE_ALPHABET, CODE_LENGTH, seedFromCode, TICK_MS_DEFAULT, TICK_MS_MAX, TICK_MS_MIN } from '../shared/mpConfig.ts'
import { defaultGatePolicy, describeGatePolicy, normalizeGatePolicy, type GatePolicy } from '../shared/gatePolicy.ts'
import type { BetaReport, DyadView, OwnScriptView, PublicScriptView, RoomLogView, RoomView, SeatNotice, ClientMessage, ServerMessage } from '../shared/protocol.ts'
import { judgeDryRun, staticCheck, type OracleReport } from '../shared/sim/oracle.ts'
import { apply, goVotes, newGame, replay as simReplay, RuleError, scriptSlots, stateHash, tick, ticksRunning } from '../shared/sim/sim.ts'
import { milestoneFrontier, nextStorm } from '../shared/sim/world.ts'
import { BETA_RUN_COST, BETA_TICKS_MAX, BETA_TICKS_MIN, ORACLE_COST, ORACLE_GAS_LIMIT, SCRIPT_GAS_LIMIT, SCRIPT_RUN_COST } from '../shared/sim/balance.ts'
import type { ChronicleEntry, Command, DeployedScript, ScriptScope, SimState } from '../shared/sim/types.ts'
import { hashSource, runBetaFork, worldViewOf } from './beta.ts'
import { engineHost, type EngineHost } from './engine.ts'
import { conditionMet, hiddenRegistry, resolveRegistryForRoom, type HiddenRegistry, type HiddenSurface } from './registry.ts'

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
  /** The seat's OWN deploy gate — human-owned (hinge sets it). */
  gatePolicy: GatePolicy
  /** Private notices (gate blocks, gate changes, lore) — newest first, bounded.
   * Server-side only; never replay state. */
  notices: SeatNotice[]
  /** Hidden world-fields this seat has earned (verb discoveries pay forward). */
  hiddenFields: Record<string, unknown>
}

const NOTICES_MAX = 12

/** Reading grace after a HOST END before the room tears down (~2 min). */
const END_GRACE_MS = Number(process.env.END_GRACE_MS) || 2 * 60_000
/** Auto-teardown after a LAUNCH/reveal completes (~10 min), sockets or not. */
const REVEAL_TTL_MS = Number(process.env.REVEAL_TTL_MS) || 10 * 60_000

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
  /** PASSING Mirror Yard runs: `${seat}:${scope}:${sourceHash}` — the ledger a
   * 'beta-pass' gate policy checks. Server-side only. */
  private betaPasses = new Set<string>()
  /** Hidden surfaces already found in this room (first-finder recorded). */
  private discovered = new Map<string, { seat: number; atTick: number }>()
  private lore: HiddenRegistry
  /** Set when the game finishes (launch or host end); the sweeper tears the
   * room down after the grace, sockets or not (anti-immortal-rooms). */
  private finishedAt: number | null = null
  private finishGraceMs = REVEAL_TTL_MS
  /** The EARNED name (the Rite of Naming — future content drop sets it; the
   * clipped tongue means a PIN can never BE a name). null until earned. */
  displayName: string | null = null

  constructor(code: string, engine?: EngineHost, lore?: HiddenRegistry) {
    this.code = code
    this.seed = seedFromCode(code)
    this.sim = newGame(this.seed)
    this.engine = engine ?? engineHost()
    // THE CLUE ENGINE: canon static, instance seeded — this room's own draws
    this.lore = resolveRegistryForRoom(lore ?? hiddenRegistry(), this.seed)
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
      case 'start': {
        const r = this.tryStart(msg.token)
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
    this.seats.push({ key, name, workerToken: mintToken('w'), hingeToken: mintToken('h'), lastWorkerSeenAt: null, gatePolicy: defaultGatePolicy(), notices: [], hiddenFields: {} })
    // (No same-name founding recognition: the clipped tongue cannot draw a
    // canon name — naming is RITE-based now, a future content drop.)
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
      // the game just finished (launch or host end) → start the teardown clock
      if (this.sim.launched && this.finishedAt === null) {
        this.finishedAt = Date.now()
        this.finishGraceMs = this.sim.endedEarly ? END_GRACE_MS : REVEAL_TTL_MS
      }
      this.pushSnapshots()
      return { ok: true }
    } catch (e) {
      if (e instanceof RuleError) return { ok: false, error: e.message }
      throw e
    }
  }

  /** True when the finished-game grace has run out — the sweeper's cue.
   * (Anti-immortal-rooms: a finished room dies even with sockets open.) */
  finishedFor(now: number): boolean {
    return this.finishedAt !== null && now - this.finishedAt > this.finishGraceMs
  }

  /** Close every socket (sweep teardown) — close handlers do the bookkeeping. */
  closeAll(): void {
    for (const ws of [...this.members.keys()]) ws.close()
    for (const ws of [...this.watchers]) ws.close()
  }

  // ── The oracle + the seat's OWN gate (FREEDOM UPDATE) ──────────────────────

  /** The world exactly as seat `p`'s scripts see it this tick — including any
   * hidden world-fields that seat has earned (verb discoveries pay forward). */
  worldViewFor(p: number): Record<string, unknown> {
    return worldViewOf(this.sim, p, this.seats[p]?.hiddenFields)
  }

  private seatName(i: number): string {
    return this.sim.dyads[i]?.name ?? this.seats[i]?.name ?? `Dyad ${i + 1}`
  }

  /** Push a PRIVATE notice onto a seat (bounded, newest first). */
  private notice(seat: number, kind: SeatNotice['kind'], text: string): void {
    const s = this.seats[seat]
    if (!s) return
    s.notices.unshift({ atTick: this.sim.tick, kind, text })
    if (s.notices.length > NOTICES_MAX) s.notices.length = NOTICES_MAX
    this.pushSnapshots()
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

  /** Deploy a script — DIRECT, either scope, either token (FREEDOM UPDATE:
   * the server imposes no verification). The only deploy gate is the SEAT'S
   * OWN policy (hinge-configured): 'oracle-green' runs the engine dry-run
   * (red or dark ⇒ 409 + report, nothing logged); 'beta-pass' requires a
   * PASSING Mirror Yard run of this exact source+scope. A policy block is a
   * PRIVATE event (seat notice) — your gate, your business. */
  async tryDeploy(token: string, idRaw: string | undefined, nameRaw: string, source: string, scope: ScriptScope): Promise<{ ok: true; id: string; verified: boolean; report?: OracleReport } | Refusal> {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (typeof source !== 'string' || source.trim() === '') return { ok: false, error: 'missing script source', code: 400 }
    if (scope !== 'district' && scope !== 'shared') return { ok: false, error: "scope must be 'district' or 'shared'", code: 400 }
    const id = (idRaw || '').trim() || `s${++this.scriptSerial}`
    const policy = this.seats[who.seat].gatePolicy[scope]
    let verified = false
    let report: OracleReport | undefined

    if (policy.includes('beta-pass')) {
      const key = `${who.seat}:${scope}:${hashSource(source)}`
      if (!this.betaPasses.has(key)) {
        const msg = `YOUR GATE (beta-pass, set by your human): this exact script has no passing Mirror Yard run for scope '${scope}' — POST beta-run with the identical source first`
        this.notice(who.seat, 'gate-blocked', `beta-pass blocked deploy '${id}' (${scope})`)
        return { ok: false, error: msg, code: 409 }
      }
    }
    if (policy.includes('oracle-green')) {
      const r = await this.oracleRun(who.seat, source)
      if ('engineDown' in r) return { ok: false, error: r.engineDown, code: 409 }
      if (!r.ok) {
        this.notice(who.seat, 'gate-blocked', `oracle-green blocked deploy '${id}' (${scope}): ${r.reasons[0] ?? 'red'}`)
        return { ok: false, error: `YOUR GATE (oracle-green, set by your human): dry-run red — ${r.reasons[0] ?? 'verification failed'}`, code: 409, report: r }
      }
      verified = true
      report = r
    }

    const r = this.command({
      t: 'deploy',
      player: who.seat,
      id,
      name: nameRaw,
      source,
      scope,
      verified,
      ...(report ? { verdict: { ok: true, reasons: report.reasons } } : {}),
    })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    this.memories.delete(`${who.seat}:${id}`)
    return { ok: true, id, verified, ...(report ? { report } : {}) }
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

  /** THE OPENING BELL: HOST (seat 0) on the hinge starts the world. Until it
   * rings, the settlement GATHERS — the world is frozen, the doors are open. */
  tryStart(token: string): { ok: true } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (who.seat !== 0) return { ok: false, error: 'only the host starts the world', code: 403 }
    if (who.role !== 'hinge') return { ok: false, error: 'starting the world is a human act — hinge token only', code: 403 }
    const r = this.command({ t: 'start' })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    // the first tick lands one full tick-length AFTER the bell, not instantly
    // (the room may have gathered for minutes — lastTickAt would be stale)
    this.lastTickAt = Date.now()
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

  /** HOST END (anti-immortal-rooms): the host calls the game — end screen as
   * it stands, then the room tears down after a short reading grace. */
  tryEnd(token: string): { ok: true } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (who.seat !== 0) return { ok: false, error: 'only the host may end the game', code: 403 }
    if (who.role !== 'hinge') return { ok: false, error: 'ending the game is a human act — hinge token only', code: 403 }
    const r = this.command({ t: 'end' })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    return { ok: true }
  }

  // ── The seat's gate policy (human-owned; FREEDOM UPDATE) ───────────────────

  /** Read YOUR seat's gate policy — either token (the agent should know the
   * gates its human set). */
  gatePolicyFor(token: string): { ok: true; seat: number; policy: GatePolicy } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    return { ok: true, seat: who.seat, policy: this.seats[who.seat].gatePolicy }
  }

  /** Set YOUR seat's gate policy — HINGE ONLY: the discipline is the human's
   * to choose; the agent deploys within it. */
  trySetGatePolicy(token: string, raw: unknown): { ok: true; policy: GatePolicy } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (who.role !== 'hinge') {
      return { ok: false, error: 'gate policy is human-owned — hinge token only (your human sets your gates; a wise dyad designs its own)', code: 403 }
    }
    const policy = normalizeGatePolicy(raw)
    if (!policy) return { ok: false, error: "invalid policy — shape: {\"district\":[],\"shared\":[\"oracle-green\"|\"beta-pass\"]}", code: 400 }
    this.seats[who.seat].gatePolicy = policy
    this.notice(who.seat, 'gate-set', `your human set your gates — ${describeGatePolicy(policy)}`)
    return { ok: true, policy }
  }

  // ── The Mirror Yard (beta env; FREEDOM UPDATE) ─────────────────────────────

  /** Fork the current world, rehearse a script N ticks, return the private
   * report. Either token. Costs BETA_RUN_COST ⚡ (the debit is logged as a
   * `spend` command; the run itself never enters the log). */
  async tryBetaRun(token: string, source: string, scope: ScriptScope, ticksRaw: unknown): Promise<{ ok: true; report: BetaReport } | Refusal> {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (typeof source !== 'string' || source.trim() === '') return { ok: false, error: 'missing script source', code: 400 }
    const sc = staticCheck(source)
    if (!sc.ok) return { ok: false, error: `beta refused: ${sc.reasons[0]}`, code: 400 }
    if (scope !== 'district' && scope !== 'shared') return { ok: false, error: "scope must be 'district' or 'shared'", code: 400 }
    const ticks = typeof ticksRaw === 'number' && Number.isFinite(ticksRaw) ? Math.floor(ticksRaw) : NaN
    if (!(ticks >= BETA_TICKS_MIN && ticks <= BETA_TICKS_MAX)) {
      return { ok: false, error: `ticks must be ${BETA_TICKS_MIN}..${BETA_TICKS_MAX}`, code: 400 }
    }
    if (!this.engine.available) return { ok: false, error: 'the Mirror Yard is dark — script engine unavailable on this server', code: 409 }
    const paid = this.command({ t: 'spend', player: who.seat, amount: BETA_RUN_COST, reason: 'beta-run' })
    if (!paid.ok) return { ok: false, error: paid.error, code: 409 }
    try {
      const report = await runBetaFork({
        sim: this.sim,
        seat: who.seat,
        source,
        scope,
        ticks,
        seed: this.seed,
        engine: this.engine,
        worldExtra: this.seats[who.seat].hiddenFields,
        onHiddenVerb: (t) => this.hiddenVerbLore(who.seat, t),
      })
      if (report.ok) this.betaPasses.add(`${who.seat}:${scope}:${report.sourceHash}`)
      return { ok: true, report }
    } catch (e) {
      // engine fault mid-rehearsal — the fee stands (the yard opened its doors)
      return { ok: false, error: `the mirror shattered: ${e instanceof Error ? e.message : e}`, code: 409 }
    }
  }

  // ── The Chronicle (shared lore-memory; FREEDOM UPDATE) ─────────────────────

  /** Post a claim — either token (the dyad speaks with one voice). Costs
   * CHRONICLE_COST ⚡; exact duplicates refused (novelty dedupe, in the sim). */
  tryChronicle(token: string, text: unknown, evidence: unknown, relatesTo: unknown): { ok: true; id: number } | Refusal {
    const who = this.auth(token)
    if (!who) return { ok: false, error: 'missing or unknown token', code: 401 }
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'missing text', code: 400 }
    const r = this.command({
      t: 'chronicle',
      player: who.seat,
      kind: 'claim',
      text,
      ...(Array.isArray(evidence) ? { evidence: evidence as string[] } : {}),
      ...(Array.isArray(relatesTo) ? { relatesTo: relatesTo as number[] } : {}),
    })
    if (!r.ok) return { ok: false, error: r.error, code: 409 }
    return { ok: true, id: this.sim.chronicle.length }
  }

  /** Query the chronicle (public — it is the settlement's shared memory).
   * author matches a seat index or name; q is a substring match. */
  chronicleEntries(opts: { author?: string; q?: string; limit?: number }): ChronicleEntry[] {
    let entries = this.sim.chronicle
    if (opts.author !== undefined && opts.author !== '') {
      const idx = Number(opts.author)
      const byIndex = Number.isInteger(idx) ? idx : null
      const name = opts.author.toLowerCase()
      entries = entries.filter((e) => e.author === byIndex || this.seatName(e.author).toLowerCase() === name)
    }
    if (opts.q) {
      const q = opts.q.toLowerCase()
      entries = entries.filter((e) => e.text.toLowerCase().includes(q) || e.evidence.some((v) => v.toLowerCase().includes(q)))
    }
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 300) : 300
    return entries.slice(-limit)
  }

  // ── Hidden surfaces (deep lore; FREEDOM UPDATE) ────────────────────────────

  /** Record a discovery: first-finder gets the room-wide celebration (board
   * event + FREE chronicle auto-entry, logged so replays carry it). Verb
   * surfaces also grant their hidden world-field to the finding seat. */
  private recordDiscovery(seat: number, surface: HiddenSurface): void {
    if (surface.worldField && this.seats[seat] && !(surface.worldField in this.seats[seat].hiddenFields)) {
      this.seats[seat].hiddenFields[surface.worldField] = surface.worldValue ?? true
      this.notice(seat, 'lore', `your scripts now see world["${surface.worldField}"] — ${surface.title}`)
    }
    if (this.discovered.has(surface.id)) return
    this.discovered.set(surface.id, { seat, atTick: this.sim.tick })
    this.command({
      t: 'chronicle',
      player: seat,
      kind: 'discovery',
      free: true,
      text: `[discovery] ${surface.title} — first uncovered by ${this.seatName(seat)}`,
      evidence: [`${surface.kind}:${surface.key}`],
    })
  }

  /** A hidden HELP TOPIC for this room (condition-checked). Returns the
   * fragment and records the discovery, or null (indistinguishable from
   * "no such topic" — that's the archaeology). */
  hiddenHelp(seat: number, topic: string): string | null {
    const surface = this.lore.surfaces.find((h) => h.kind === 'help-topic' && h.key === topic)
    if (!surface || !conditionMet(this.sim, surface.condition)) return null
    this.recordDiscovery(seat, surface)
    return surface.fragment
  }

  /** A hidden room ENDPOINT (GET /api/room/:pin/<key>) — same contract. */
  hiddenEndpoint(seat: number, key: string): string | null {
    const surface = this.lore.surfaces.find((h) => h.kind === 'endpoint' && h.key === key)
    if (!surface || !conditionMet(this.sim, surface.condition)) return null
    this.recordDiscovery(seat, surface)
    return surface.fragment
  }

  /** A hidden VERB emitted by a script: if it matches an earned surface, the
   * action is stripped (never logged), the lore answers, discovery recorded.
   * Returns the lore line, or null to let the sim call it an unknown action. */
  private hiddenVerbLore(seat: number, actionType: string): string | null {
    const surface = this.lore.surfaces.find((h) => h.kind === 'verb' && h.key === actionType)
    if (!surface || !conditionMet(this.sim, surface.condition)) return null
    this.recordDiscovery(seat, surface)
    return surface.fragment
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
          // hidden verbs: an earned surface ANSWERS (lore to the seat, action
          // stripped — never logged); an unearned one falls through to the
          // sim's honest "unknown action" note. Discovery recorded on first.
          const actions = out.actions.filter((a) => {
            const lore = this.hiddenVerbLore(p, String(a.type))
            if (lore) this.notice(p, 'lore', lore)
            return !lore
          })
          this.command({ t: 'scriptTick', player: p, id, actions, gasUsed: out.gasUsed, logs: out.logs.slice(0, 10), ...(out.err ? { err: out.err } : {}) })
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
            gatePolicy: this.seats[seatIndex]?.gatePolicy ?? defaultGatePolicy(),
            notices: this.seats[seatIndex]?.notices ?? [],
          }
        : null
    return {
      room: this.code,
      displayName: this.displayName,
      tickMs: this.tickMs,
      tick: s.tick,
      phase: s.launched ? 'ended' : s.started ? 'running' : 'gathering',
      launched: s.launched,
      endedEarly: s.endedEarly,
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
      chronicle: s.chronicle.slice(-30),
      chronicleCount: s.chronicle.length,
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
      // finished games die after their grace, SOCKETS OR NOT (anti-immortal-
      // rooms); abandoned rooms die after the inactivity TTL as before.
      if (room.finishedFor(now)) {
        room.closeAll()
        this.rooms.delete(room.code)
        continue
      }
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
