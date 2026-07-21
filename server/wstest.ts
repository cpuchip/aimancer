// Over-the-wire oracle — spawns the REAL server entry (tsx server/index.ts)
// and plays it through websockets + HTTP like a browser/agent would.
// Run: npm run wstest. Harness adapted from chips server/wstest.ts (TestClient,
// taskkill teardown, assertRedacted discipline).
//
// Covers: room create (PIN alphabet), join, host-hinge start, the TWO-TOKEN
// SEAT SPLIT (a worker token's arm attempt MUST be rejected — ws and HTTP),
// drafts, oracle reports, tick auto-advance, reconnect-by-key with stable
// tokens, and the REDACTION AUDIT: other players' hands and ALL auth tokens
// never cross the wire to the wrong seat.

import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import { freshEvents, newFeedCursor } from '../shared/eventFeed.ts'
import { CODE_ALPHABET, ROUND2_TICKS_DEFAULT, seedFromCode } from '../shared/mpConfig.ts'
import { TOKEN_START } from '../shared/sim/balance.ts'
import type { SimEvent } from '../shared/sim/types.ts'
import type { ClientMessage, RoomLogView, RoomView, ServerMessage } from '../shared/protocol.ts'

const PORT = 18643
const BASE = `http://localhost:${PORT}`

let passed = 0
let failed = 0
function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.error(`FAIL  ${name}`)
  }
}

class TestClient {
  ws: WebSocket
  queue: ServerMessage[] = []
  /** Raw JSON of every snapshot received — the redaction audit reads these. */
  snapshotRaws: string[] = []
  waiters: Array<() => void> = []
  view: RoomView | null = null
  errs: string[] = []
  welcome: Extract<ServerMessage, { type: 'welcome' }> | null = null
  reports: Extract<ServerMessage, { type: 'oracleReport' }>[] = []
  name: string
  private opened: Promise<void>

  constructor(public key: string, name: string) {
    this.name = name
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`)
    // Attach ALL listeners synchronously with construction — an await between
    // construction and listener setup loses events that already fired.
    this.opened = new Promise<void>((res, rej) => {
      this.ws.once('open', () => res())
      this.ws.once('error', rej)
    })
    this.ws.on('message', (raw) => {
      const str = String(raw)
      const msg = JSON.parse(str) as ServerMessage
      if (msg.type === 'snapshot') {
        this.snapshotRaws.push(str)
        this.view = msg.view
      }
      if (msg.type === 'welcome') this.welcome = msg
      if (msg.type === 'error') this.errs.push(msg.message)
      if (msg.type === 'oracleReport') this.reports.push(msg)
      this.queue.push(msg)
      for (const w of this.waiters.splice(0)) w()
    })
  }

  async open(room: string, watch = false): Promise<void> {
    await this.opened
    if (watch) this.send({ type: 'watch', room })
    else this.send({ type: 'join', room, name: this.name, key: this.key })
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg))
  }

  async waitFor(pred: (m: ServerMessage) => boolean, what: string, ms = 8000): Promise<ServerMessage> {
    const scan = () => this.queue.find(pred)
    const start = Date.now()
    for (;;) {
      const hit = scan()
      if (hit) return hit
      if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what} (${this.name})`)
      await new Promise<void>((res) => {
        const t = setTimeout(res, 100)
        this.waiters.push(() => {
          clearTimeout(t)
          res()
        })
      })
    }
  }

  async waitView(pred: (v: RoomView) => boolean, what: string, ms = 8000): Promise<RoomView> {
    const start = Date.now()
    for (;;) {
      if (this.view && pred(this.view)) return this.view
      if (Date.now() - start > ms) throw new Error(`timeout waiting for view: ${what} (${this.name})`)
      await new Promise<void>((res) => {
        const t = setTimeout(res, 100)
        this.waiters.push(() => {
          clearTimeout(t)
          res()
        })
      })
    }
  }

  close(): void {
    this.ws.close()
  }
}

async function main(): Promise<void> {
  const server = spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT) },
    // stderr must be 'pipe', not 'inherit': an inherited fd ties our pipeline
    // to the child's lifetime (chips' lesson).
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  server.stderr.on('data', (d: Buffer) => process.stderr.write(d))
  await new Promise<void>((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not boot')), 20000)
    server.stdout.on('data', (d: Buffer) => {
      if (String(d).includes('aimancer server on')) {
        clearTimeout(to)
        res()
      }
    })
    server.on('exit', () => rej(new Error('server exited early')))
  })

  try {
    // ── HTTP surface: the deploy oracles ─────────────────────────────────────
    const health = await (await fetch(`${BASE}/healthz`)).text()
    ok(health === 'ok', '/healthz')
    const version = await (await fetch(`${BASE}/version`)).text()
    ok(version.length > 0, `/version (${version})`)

    // ── Room create + join ───────────────────────────────────────────────────
    const alice = new TestClient('key-alice', 'Alice')
    await alice.open('') // empty PIN = create
    await alice.waitFor((m) => m.type === 'welcome', 'alice welcome')
    const pin = alice.welcome!.room
    ok(new RegExp(`^[${CODE_ALPHABET}]{4}$`).test(pin), `4-letter PIN from the no-I/O alphabet (${pin})`)
    ok(alice.welcome!.isHost && alice.welcome!.index === 0, 'creator seated as host')
    ok(alice.welcome!.workerToken.startsWith('w_') && alice.welcome!.hingeToken.startsWith('h_'), 'seat issued BOTH tokens: worker + hinge')

    const bob = new TestClient('key-bob', 'Bob')
    await bob.open(pin)
    await bob.waitFor((m) => m.type === 'welcome', 'bob welcome')
    ok(bob.welcome!.index === 1 && !bob.welcome!.isHost, 'bob got seat 1')
    ok(bob.welcome!.workerToken !== alice.welcome!.workerToken, 'tokens are per-seat')

    const ghost = new TestClient('key-ghost', 'Ghost')
    await ghost.open('ZZZZ')
    await ghost.waitFor((m) => m.type === 'error', 'bad pin rejected')
    ok(ghost.errs.some((e) => e.includes('ZZZZ')), 'joining a nonexistent PIN errors')
    ghost.close()

    // ── Start: host + hinge only ─────────────────────────────────────────────
    bob.send({ type: 'start', token: bob.welcome!.hingeToken })
    await bob.waitFor((m) => m.type === 'error' && m.message.includes('host'), 'non-host start rejected')
    ok(true, 'only the host starts')
    alice.send({ type: 'start', token: alice.welcome!.workerToken })
    await alice.waitFor((m) => m.type === 'error' && m.message.includes('hinge'), 'worker start rejected')
    ok(true, 'starting is a hinge act — worker token rejected')
    // 60s tick = the world holds still for this room, so every assertion below
    // is deterministic (no gremlin spike can disturb the fixture mid-test).
    // A second room further down proves the auto-tick loop.
    alice.send({ type: 'start', token: alice.welcome!.hingeToken, tickMs: 60000 })
    await alice.waitView((v) => v.started, 'game started')
    ok(alice.view!.tickMs === 60000, 'tick length is a room setting')
    ok(alice.view!.players.length === 2, 'two workshops in the world')
    ok(alice.view!.phase === 'round1', 'the game opens in ROUND 1 — naive')
    ok(alice.view!.ticksRemaining === 12, 'round-1 countdown starts at the default budget (12)')

    // ── Draft: worker surface only. 31337 is Bob's secret marker. ────────────
    const SECRET = 31337
    bob.send({
      type: 'draft',
      token: bob.welcome!.hingeToken,
      script: { id: 'bob-s1', verb: 'harvest', params: { rate: 2 } },
      tier: 'cheap',
    })
    await bob.waitFor((m) => m.type === 'error' && m.message.includes('worker'), 'hinge draft rejected')
    ok(true, 'drafts come from the worker surface — hinge token rejected')
    bob.send({
      type: 'draft',
      token: bob.welcome!.workerToken,
      script: { id: 'bob-s1', verb: 'harvest', params: { rate: 2 }, when: { field: 'matter', op: '<', value: SECRET } },
      tier: 'cheap',
    })
    await bob.waitView((v) => (v.you?.hand.length ?? 0) === 1, 'draft landed in the hand')
    ok(bob.view!.you!.hand[0].script.params['rate'] === 2, "bob's own snapshot carries his full script body")
    ok(!bob.view!.you!.hand[0].armed, 'a draft enters the queue unarmed')

    // ── THE HINGE TEST: a worker token's arm attempt is REJECTED ─────────────
    bob.send({ type: 'arm', token: bob.welcome!.workerToken, id: 'bob-s1' })
    await bob.waitFor((m) => m.type === 'error' && m.message.includes('hinge'), 'worker arm rejected')
    ok(true, 'WORKER token arm attempt REJECTED server-side (the hinge holds)')
    ok(bob.view!.you!.hand[0].armed === false, 'and the script stayed unarmed')
    bob.send({ type: 'arm', token: bob.welcome!.hingeToken, id: 'bob-s1' })
    await bob.waitView((v) => v.you!.hand[0].armed === true, 'hinge arm landed')
    ok(bob.view!.you!.hand[0].yolo === true, 'armed without an oracle pass = YOLO (public)')

    // alice cannot reach into bob's workshop even with her hinge
    alice.send({ type: 'arm', token: alice.welcome!.hingeToken, id: 'bob-s1' })
    await alice.waitFor((m) => m.type === 'error' && m.message.includes('no script'), 'cross-seat arm rejected')
    ok(true, 'a hinge only arms its OWN workshop')

    // ── ROUND 1 IS NAIVE: the oracle is refused BY THE SIM over the wire ─────
    bob.send({ type: 'oracle', token: bob.welcome!.workerToken, id: 'bob-s1' })
    await bob.waitFor((m) => m.type === 'error' && m.message.includes("hasn't been invented"), 'round-1 oracle refused')
    ok(true, "round-1 oracleCheck REFUSED by the sim, in plain words (\"the oracle hasn't been invented yet\")")
    ok(bob.reports.length === 0, 'and no oracle report crossed the wire')

    // alice stocks a draft with HER secret marker (log-redaction fixture)
    const ALICE_SECRET = 424242
    alice.send({
      type: 'draft',
      token: alice.welcome!.workerToken,
      script: { id: 'alice-s1', verb: 'sell', params: { amount: 2 }, when: { field: 'widgets', op: '>', value: ALICE_SECRET } },
      tier: 'smart',
    })
    await alice.waitView((v) => (v.you?.hand.length ?? 0) === 1, "alice's draft landed")

    // ── The world ticks on its own + the ROUND BUDGET freezes it ─────────────
    const carol = new TestClient('key-carol', 'Carol')
    await carol.open('')
    await carol.waitFor((m) => m.type === 'welcome', 'carol welcome')
    carol.send({ type: 'start', token: carol.welcome!.hingeToken, tickMs: 300, round1Ticks: 2 })
    await carol.waitView((v) => v.tick >= 2, 'ticks advance')
    ok(true, 'the room ticks the sim on its own cadence and pushes snapshots (auto-refresh proof)')
    await new Promise((r) => setTimeout(r, 900)) // 3 tick intervals of silence
    ok(carol.view!.tick === 2, `round-1 budget freezes the world at its cap (tick ${carol.view!.tick} of 2)`)
    ok(carol.view!.ticksRemaining === 0, 'countdown reads 0 — waiting on the host')
    // the host advances her solo room through the weave
    carol.send({ type: 'phase', token: carol.welcome!.hingeToken, to: 'intermission' })
    await carol.waitView((v) => v.phase === 'intermission', 'carol intermission')
    ok(carol.view!.round1Summary !== null, 'intermission snapshot carries the round-1 summary')
    carol.send({ type: 'phase', token: carol.welcome!.hingeToken, to: 'round2' })
    await carol.waitView((v) => v.phase === 'round2', 'carol round2')
    ok(carol.view!.ticksRemaining !== null && carol.view!.ticksRemaining <= ROUND2_TICKS_DEFAULT, `round-2 countdown runs its own budget (${carol.view!.ticksRemaining}/${ROUND2_TICKS_DEFAULT})`)
    await carol.waitView((v) => v.phase === 'round2' && v.tick >= 1, 'round-2 ticks resume')
    ok(true, 'a fresh round un-freezes the world')
    carol.close()

    // ── HTTP API: the BYO surface ────────────────────────────────────────────
    const pub = await (await fetch(`${BASE}/api/room/${pin}/state`)).json()
    ok(pub.ok && pub.view.you === null, 'public state has NO hand (you: null)')
    const mine = await (await fetch(`${BASE}/api/room/${pin}/state`, { headers: { authorization: `Bearer ${bob.welcome!.workerToken}` } })).json()
    ok(mine.ok && mine.view.you?.hand.some((sl: { script: { id: string } }) => sl.script.id === 'bob-s1'), 'worker-token state shows your own hand')

    const draftDenied = await fetch(`${BASE}/api/room/${pin}/draft`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.welcome!.hingeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ script: { id: 'bob-s2', verb: 'harvest', params: { rate: 1 } }, tier: 'cheap' }),
    })
    ok(draftDenied.status === 403, 'HTTP draft with hinge token → 403 (role tagging both ways)')
    const draftOk = await fetch(`${BASE}/api/room/${pin}/draft`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.welcome!.workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ script: { id: 'bob-s2', verb: 'harvest', params: { rate: 1 } }, tier: 'cheap' }),
    })
    ok(draftOk.status === 200, 'HTTP draft with worker token lands')

    const armDenied = await fetch(`${BASE}/api/room/${pin}/arm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.welcome!.workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'bob-s2' }),
    })
    ok(armDenied.status === 403, 'HTTP arm with WORKER token → 403 (the hinge holds over HTTP too)')
    const s2Check = await (await fetch(`${BASE}/api/room/${pin}/state`, { headers: { authorization: `Bearer ${bob.welcome!.workerToken}` } })).json()
    const s2 = s2Check.view.you.hand.find((sl: { script: { id: string } }) => sl.script.id === 'bob-s2')
    ok(s2 && s2.armed === false, 'and bob-s2 stayed unarmed')
    const armOk = await fetch(`${BASE}/api/room/${pin}/arm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.welcome!.hingeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'bob-s2' }),
    })
    ok(armOk.status === 200, 'HTTP arm with hinge token lands')
    const noToken = await fetch(`${BASE}/api/room/${pin}/arm`, { method: 'POST', body: '{"id":"bob-s2"}' })
    ok(noToken.status === 401, 'HTTP arm with no token → 401')

    // ── Spectator (the big screen) ───────────────────────────────────────────
    const board = new TestClient('key-board', 'Board')
    await board.open(pin, true)
    await board.waitView((v) => v.started, 'board snapshot')
    ok(board.view!.you === null, 'a watcher gets NO hand')
    ok(board.view!.players[1].scripts.some((sc) => sc.id === 'bob-s1' && sc.armed), 'the board sees script fates (id/armed/yolo), not bodies')

    // ── Reconnect by localStorage key: same seat, SAME tokens ────────────────
    bob.close()
    await new Promise((r) => setTimeout(r, 300))
    const bob2 = new TestClient('key-bob', 'Bob')
    await bob2.open(pin)
    await bob2.waitFor((m) => m.type === 'welcome', 'bob rejoined')
    ok(bob2.welcome!.index === 1, 'rejoined the same seat')
    ok(bob2.welcome!.workerToken === bob.welcome!.workerToken && bob2.welcome!.hingeToken === bob.welcome!.hingeToken, 'reconnect reissues the SAME tokens (agents keep working)')
    await bob2.waitView((v) => (v.you?.hand.length ?? 0) === 2, 'hand intact after rejoin')
    ok(true, 'live state resumed after reconnect')

    // ── THE WEAVE over the wire: host-controlled phase advance ───────────────
    bob2.send({ type: 'phase', token: bob2.welcome!.hingeToken, to: 'intermission' })
    await bob2.waitFor((m) => m.type === 'error' && m.message.includes('host'), 'non-host phase rejected')
    ok(true, 'only the host advances the round')
    alice.send({ type: 'phase', token: alice.welcome!.workerToken, to: 'intermission' })
    await alice.waitFor((m) => m.type === 'error' && m.message.includes('human'), 'worker phase rejected')
    ok(true, 'advancing the round is a human act — worker token rejected')
    alice.send({ type: 'phase', token: alice.welcome!.hingeToken, to: 'round2' })
    await alice.waitFor((m) => m.type === 'error' && m.message.includes('intermission'), 'skip rejected')
    ok(true, 'phases advance strictly in order (no skipping to round 2)')

    alice.send({ type: 'phase', token: alice.welcome!.hingeToken, to: 'intermission' })
    await bob2.waitView((v) => v.phase === 'intermission', 'intermission snapshot')
    ok(bob2.view!.round1Summary !== null, 'the round-1 summary rides every snapshot from intermission on (the teaching backdrop)')

    // intermission: frozen, but the hand can be stocked
    bob2.send({
      type: 'draft',
      token: bob2.welcome!.workerToken,
      script: { id: 'bob-s3', verb: 'harvest', params: { rate: 2 } },
      tier: 'cheap',
    })
    await bob2.waitView((v) => (v.you?.hand.length ?? 0) === 3, 'intermission draft stocks the hand')
    ok(true, 'drafting during intermission works (stock your hand for round 2)')
    bob2.send({ type: 'arm', token: bob2.welcome!.hingeToken, id: 'bob-s3' })
    await bob2.waitFor((m) => m.type === 'error' && m.message.includes('frozen'), 'intermission arm rejected')
    ok(true, 'arming is refused while the world is frozen')

    // ── GET /api/room/:pin/log — the replay feed, redacted per token ─────────
    async function fetchLog(token?: string): Promise<{ ok: boolean; logStr: string; body: RoomLogView }> {
      const r = await fetch(`${BASE}/api/room/${pin}/log`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)
      const body = (await r.json()) as RoomLogView & { ok: boolean }
      // leak checks scan the ENTRIES only — the seed field is a number that
      // could coincidentally contain the marker digits
      return { ok: body.ok, logStr: JSON.stringify(body.log), body }
    }
    function draftEntry(body: RoomLogView, id: string): Record<string, unknown> | undefined {
      const hit = body.log.find((e) => {
        const c = e.cmd as { t?: string; script?: { id?: string } }
        return c.t === 'draftAccepted' && c.script?.id === id
      })
      return hit?.cmd as Record<string, unknown> | undefined
    }
    const pubLog = await fetchLog()
    ok(pubLog.ok && pubLog.body.seed === seedFromCode(pin), 'log endpoint returns the seed (seed == seedFromCode(PIN))')
    ok(pubLog.body.log.length > 0 && pubLog.body.phase === 'intermission', 'log carries the command entries + current phase')
    ok(pubLog.body.log.some((e) => (e.cmd as { t?: string }).t === 'phase'), 'phase advances are IN the log (replays cross phases)')
    const pubDraft = draftEntry(pubLog.body, 'bob-s1') as { script?: Record<string, unknown> } | undefined
    ok(pubDraft !== undefined && pubDraft.script !== undefined && !('params' in pubDraft.script) && !('when' in pubDraft.script), 'tokenless log: draft bodies stripped to { id, verb }')
    ok(!pubLog.logStr.includes(String(SECRET)) && !pubLog.logStr.includes(String(ALICE_SECRET)), 'tokenless log leaks NO script body from any seat')

    const bobLog = await fetchLog(bob2.welcome!.workerToken)
    ok(bobLog.logStr.includes(String(SECRET)), 'a seat token sees its OWN draft bodies in the log')
    ok(!bobLog.logStr.includes(String(ALICE_SECRET)), "…and never another seat's (alice's params stripped)")

    const hostEarlyLog = await fetchLog(alice.welcome!.hingeToken)
    ok(!hostEarlyLog.logStr.includes(String(SECRET)), "the HOST token gets NO other-seat bodies BEFORE the reveal (bob's params still stripped)")

    // ── Round 2: fresh world, same seed; stocked drafts carry ────────────────
    alice.send({ type: 'phase', token: alice.welcome!.hingeToken, to: 'round2' })
    await bob2.waitView((v) => v.phase === 'round2', 'round2 snapshot')
    ok(bob2.view!.tick === 0 && bob2.view!.ticksRemaining === ROUND2_TICKS_DEFAULT, 'round 2 restarts the clock with its own budget')
    ok(bob2.view!.you!.hand.length === 1 && bob2.view!.you!.hand[0].script.id === 'bob-s3', 'ONLY un-played drafts carry into round 2 (armed bob-s1/s2 are gone)')
    ok(bob2.view!.players[1].tokens === TOKEN_START, 'resources reset to opening values — level playing field')

    // the oracle exists now: verdict + 3-tick dry-run over the wire (either token)
    bob2.send({ type: 'oracle', token: bob2.welcome!.workerToken, id: 'bob-s3' })
    await bob2.waitFor((m) => m.type === 'oracleReport', 'oracle report')
    const rep = bob2.reports[0]
    ok(rep.report.ok && rep.report.prediction?.length === 3, 'round-2 oracle report carries the 3-tick dry-run')
    bob2.send({ type: 'arm', token: bob2.welcome!.hingeToken, id: 'bob-s3' })
    await bob2.waitView((v) => v.you!.hand[0].armed === true, 'verified arm landed')
    ok(bob2.view!.you!.hand[0].yolo === false, 'an oracle-green arm is NOT a YOLO')

    // ── Scrap over the wire ──────────────────────────────────────────────────
    bob2.send({ type: 'scrap', token: bob2.welcome!.hingeToken, id: 'bob-s3' })
    await bob2.waitFor((m) => m.type === 'error' && m.message.includes('disarm'), 'armed scrap rejected')
    ok(true, 'an armed script cannot be scrapped (disarm first)')
    bob2.send({
      type: 'draft',
      token: bob2.welcome!.workerToken,
      script: { id: 'bob-s4', verb: 'refine', params: { rate: 1 } },
      tier: 'cheap',
    })
    await bob2.waitView((v) => (v.you?.hand.length ?? 0) === 2, 'bob-s4 drafted')
    bob2.send({ type: 'scrap', token: bob2.welcome!.workerToken, id: 'bob-s4' })
    await bob2.waitView((v) => (v.you?.hand.length ?? 0) === 1, 'scrap landed')
    ok(!bob2.view!.you!.hand.some((sl) => sl.script.id === 'bob-s4'), 'scrap frees the hand slot (worker surface may tidy)')

    // ── The reveal: full stop + the delta table ──────────────────────────────
    alice.send({ type: 'phase', token: alice.welcome!.hingeToken, to: 'reveal' })
    await bob2.waitView((v) => v.phase === 'reveal', 'reveal snapshot')
    const delta = bob2.view!.delta
    ok(delta !== null && delta.players.length === 2, 'the reveal snapshot carries the round1-vs-round2 delta for every player')
    ok(delta!.totals.score === delta!.totals.r2Score - delta!.totals.r1Score, 'aggregate delta is arithmetic, not vibes')
    ok(bob2.view!.round2Summary !== null, 'round-2 summary present in reveal')
    bob2.send({
      type: 'draft',
      token: bob2.welcome!.workerToken,
      script: { id: 'late', verb: 'harvest', params: { rate: 1 } },
      tier: 'cheap',
    })
    await bob2.waitFor((m) => m.type === 'error' && m.message.includes('over'), 'post-reveal draft rejected')
    ok(true, 'after the reveal the game is a museum — no more commands')

    // host token unlocks the FULL log after the reveal (the take-home artifact)
    const hostRevealLog = await fetchLog(alice.welcome!.hingeToken)
    ok(hostRevealLog.logStr.includes(String(SECRET)), "after the reveal the HOST token gets the full log (bob's params included)")
    const bobRevealLog = await fetchLog(bob2.welcome!.workerToken)
    ok(!bobRevealLog.logStr.includes(String(ALICE_SECRET)), "a non-host seat STAYS redacted even after the reveal")
    const pubRevealLog = await fetchLog()
    ok(!pubRevealLog.logStr.includes(String(SECRET)) && !pubRevealLog.logStr.includes(String(ALICE_SECRET)), 'the tokenless log stays redacted after the reveal')

    // ── Event feed dedup over the REAL wire ──────────────────────────────────
    // Replay bob's captured snapshots through the client cursor: every event id
    // must be delivered exactly once even though snapshots overlap within a tick.
    {
      const cursor = newFeedCursor()
      const delivered: SimEvent[] = []
      for (const raw of bob2.snapshotRaws) {
        const v = (JSON.parse(raw) as { view: RoomView }).view
        delivered.push(...freshEvents(cursor, v.events, v.eventSeq))
      }
      const drafts3 = delivered.filter((e) => e.t === 'drafted' && e.id === 'bob-s3').length
      const armed3 = delivered.filter((e) => e.t === 'armed' && e.id === 'bob-s3').length
      const scrapped4 = delivered.filter((e) => e.t === 'scrapped' && e.id === 'bob-s4').length
      ok(drafts3 === 1, `wire feed dedup: bob-s3 'drafted' delivered exactly once (got ${drafts3})`)
      ok(armed3 === 1, `wire feed dedup: bob-s3 'armed' delivered exactly once (got ${armed3})`)
      ok(scrapped4 === 1, `wire feed dedup: bob-s4 'scrapped' delivered exactly once (got ${scrapped4})`)
      const rawAppendCount = bob2.snapshotRaws.filter((raw) => raw.includes('"t":"drafted"') && raw.includes('"bob-s3"')).length
      ok(rawAppendCount > 1, `the D1 bug was real: the same event crossed the wire in ${rawAppendCount} snapshots (naive append would duplicate)`)
    }

    // ── REDACTION AUDIT over everything that crossed the wire ────────────────
    const allTokens = [
      alice.welcome!.workerToken,
      alice.welcome!.hingeToken,
      bob.welcome!.workerToken,
      bob.welcome!.hingeToken,
    ]
    function audit(c: TestClient, ownsSecret: boolean, label: string): void {
      let tokenLeak = false
      let bodyLeak = false
      let sawOwnSecret = false
      for (const raw of c.snapshotRaws) {
        for (const t of allTokens) if (raw.includes(t)) tokenLeak = true
        if (raw.includes(String(SECRET))) {
          if (ownsSecret) sawOwnSecret = true
          else bodyLeak = true
        }
      }
      ok(!tokenLeak, `${label}: NO auth token ever appears in a snapshot`)
      if (ownsSecret) ok(sawOwnSecret, `${label}: sees his own script body (the test can fail)`)
      else ok(!bodyLeak, `${label}: never sees Bob's script body (hands redacted)`)
    }
    audit(alice, false, 'alice')
    audit(board, false, 'board')
    audit(bob, true, 'bob')
    // symmetric: alice's script body never reached the other seats either
    ok(!bob2.snapshotRaws.some((r) => r.includes(String(ALICE_SECRET))), "bob2: never sees alice's script body")
    ok(!board.snapshotRaws.some((r) => r.includes(String(ALICE_SECRET))), "board: never sees alice's script body")
    ok(alice.snapshotRaws.some((r) => r.includes(String(ALICE_SECRET))), 'alice: sees her own script body (the symmetric test can fail)')
    // structural check: public script views carry no 'script'/'params' keys
    const lastBoard = JSON.parse(board.snapshotRaws[board.snapshotRaws.length - 1])
    const boardScripts = (lastBoard.view as RoomView).players.flatMap((p) => p.scripts) as unknown as Record<string, unknown>[]
    ok(boardScripts.length > 0 && boardScripts.every((sc) => !('script' in sc) && !('params' in sc)), 'public script views are fate-only (no body keys at all)')

    alice.close()
    bob2.close()
    board.close()
  } finally {
    // Windows: kill() only reaches the cmd.exe shell wrapper — taskkill /T
    // takes the real node process down with it. AWAIT it (chips' lesson).
    if (process.platform === 'win32' && server.pid) {
      await new Promise<void>((res) => {
        const k = spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { shell: true })
        k.on('exit', () => res())
        k.on('error', () => res())
        setTimeout(res, 3000)
      })
    } else {
      server.kill()
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
