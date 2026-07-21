// Over-the-wire oracle — ARK PIVOT. Spawns the REAL server entry (tsx
// server/index.ts) with the REAL Go engine binary and plays it through
// websockets + HTTP like a browser/agent would. Run: npm run wstest.
// Harness adapted from chips server/wstest.ts (TestClient, taskkill teardown,
// assertRedacted discipline).
//
// Covers: settlement create/join (PIN alphabet), CONTINUOUS play (no start
// step — the world ticks as soon as a dyad sits), DROP-IN join mid-game,
// reconnect-by-key with stable tokens, THE DEPLOY GATE over the wire
// (unverified shared deploy → 409 + oracle report; district YOLO lands),
// ENGINE INTEGRATION on the real path (a deployed template gathers real ore;
// KV memory round-trips through the subprocess; a syntax error surfaces as an
// error value), the paid oracle endpoint, the LAUNCH VOTE token split (worker
// vote → 403; launch host-only), the agent paste-prompt (worker-only, no
// hinge token, no bypass instruction), REPLAY determinism from GET /log, and
// the REDACTION AUDIT: other seats' script SOURCE and ALL auth tokens never
// cross the wire to the wrong seat.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { CODE_ALPHABET } from '../shared/mpConfig.ts'
import { ORACLE_COST, TOKEN_START } from '../shared/sim/balance.ts'
import { replay, stateHash } from '../shared/sim/sim.ts'
import type { Command } from '../shared/sim/types.ts'
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
    const start = Date.now()
    for (;;) {
      const hit = this.queue.find(pred)
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

  async waitView(pred: (v: RoomView) => boolean, what: string, ms = 10000): Promise<RoomView> {
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

function spawnGame(port: number, extraEnv: Record<string, string>): ReturnType<typeof spawn> {
  return spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
}

async function awaitBoot(server: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not boot')), 20000)
    server.stdout!.on('data', (d: Buffer) => {
      if (String(d).includes('aimancer server on')) {
        clearTimeout(to)
        res()
      }
    })
    server.on('exit', () => rej(new Error('server exited early')))
  })
}

async function killGame(server: ReturnType<typeof spawn>): Promise<void> {
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

/** Build the REAL engine from the sibling checkout — the integration floor
 * runs against the actual subprocess, never a stub. */
function buildEngine(): string {
  const goDir = process.env.AIMANCER_GO_DIR || resolve(process.cwd(), '..', 'aimancer-go')
  const cacheDir = resolve(process.cwd(), 'node_modules', '.cache')
  mkdirSync(cacheDir, { recursive: true })
  const bin = join(cacheDir, process.platform === 'win32' ? 'aimancer-engine-wstest.exe' : 'aimancer-engine-wstest')
  const r = spawnSync('go', ['build', '-o', bin, './cmd/aimancer-engine'], { cwd: goDir, stdio: 'pipe', shell: process.platform === 'win32' })
  if (r.status !== 0) throw new Error(`engine build failed: ${r.stderr?.toString()}`)
  return bin
}

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const MINER_SRC = `best = None
for v in world["veins"]:
    if v["reserve"] > 0 and (best == None or v["rate"] > best["rate"]):
        best = v
if best != None:
    act("gather", node=best["id"], rate=best["rate"])
`

const KV_SRC = `n = recall("n", 0) + 1
remember("n", n)
print("kvtick", n)
act("farm", rate=1)
`

async function main(): Promise<void> {
  console.log('building the real engine…')
  const engineBin = buildEngine()
  const server = spawnGame(PORT, { AIMANCER_ENGINE_BIN: engineBin })
  server.stderr!.on('data', (d: Buffer) => process.stderr.write(d))
  await awaitBoot(server)

  try {
    // ── deploy oracles + public reference ────────────────────────────────────
    ok((await (await fetch(`${BASE}/healthz`)).text()) === 'ok', '/healthz')
    const version = await (await fetch(`${BASE}/version`)).text()
    ok(version.length > 0, `/version (${version})`)
    const rulesRes = await fetch(`${BASE}/api/rules`)
    const rulesText = await rulesRes.text()
    ok(rulesRes.status === 200 && (rulesRes.headers.get('content-type') ?? '').startsWith('text/plain'), 'GET /api/rules → 200 text/plain, NO auth (rules are public)')
    ok(rulesText.includes('deploy gate') && rulesText.includes('GO/NO-GO'), '/api/rules carries the ark game')
    ok(rulesText.includes('gather') && rulesText.includes('contribute'), '/api/rules carries the action table')
    ok(!/\b[wh]_[A-Za-z0-9_-]{8,}/.test(rulesText), '/api/rules carries no token material')
    ok((await fetch(`${BASE}/api/rules`, { method: 'POST' })).status === 405, 'POST /api/rules → 405')
    const tpl = await api('/api/templates')
    const templates = tpl.json['templates'] as Array<{ id: string; scope: string; source: string }>
    ok(tpl.status === 200 && templates.length >= 4, 'GET /api/templates → the agentless floor')
    ok(templates.some((t) => t.scope === 'shared') && templates.some((t) => t.scope === 'district'), 'templates cover both scopes')

    // ── ws create/join: continuous from the first seat ───────────────────────
    const alice = new TestClient('key-alice', 'Alice')
    await alice.open('') // empty PIN = create
    await alice.waitFor((m) => m.type === 'welcome', 'alice welcome')
    const wsPin = alice.welcome!.room
    ok(new RegExp(`^[${CODE_ALPHABET}]{4}$`).test(wsPin), `4-letter PIN from the no-I/O alphabet (${wsPin})`)
    ok(alice.welcome!.isHost && alice.welcome!.index === 0, 'creator seated as host (seat 0)')
    ok(alice.welcome!.workerToken.startsWith('w_') && alice.welcome!.hingeToken.startsWith('h_'), 'seat issued BOTH tokens: worker + hinge')
    const v0 = await alice.waitView((v) => v.dyads.length === 1, 'first snapshot')
    ok(v0.storm.inTicks > 0 && v0.storm.severity > 0, 'the storm countdown is live from the first snapshot')
    ok(v0.frontier === 'wall', 'the milestone frontier starts at the wall')
    ok(v0.engine !== null && typeof v0.engine.version === 'string', `engine identity pinned in the view (${v0.engine?.engine} ${v0.engine?.version})`)
    alice.close()

    // ── HTTP room lifecycle (agents need no websocket at all) ────────────────
    const created = await api('/api/room', { body: { name: 'Host', tickMs: 300 } })
    ok(created.status === 200 && created.json['ok'] === true, 'POST /api/room creates + seats the host')
    const pin = created.json['pin'] as string
    const host = { worker: created.json['workerToken'] as string, hinge: created.json['hingeToken'] as string, key: created.json['key'] as string }
    ok(typeof host.worker === 'string' && typeof host.hinge === 'string', 'HTTP create returns both tokens')

    const joined = await api(`/api/room/${pin}/join`, { body: { name: 'Bea' } })
    ok(joined.status === 200 && joined.json['seat'] === 1, 'HTTP drop-in join gets seat 1')
    const bea = { worker: joined.json['workerToken'] as string, hinge: joined.json['hingeToken'] as string, key: joined.json['key'] as string }

    const re = await api(`/api/room/${pin}/join`, { body: { name: 'Bea', key: bea.key } })
    ok(re.status === 200 && re.json['rejoined'] === true && re.json['workerToken'] === bea.worker && re.json['hingeToken'] === bea.hinge, 'reconnect-by-key returns the SAME seat + tokens')

    // ── THE DEPLOY GATE over the wire ────────────────────────────────────────
    const yolo = await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'crash', scope: 'district', source: 'this is not starlark' } })
    ok(yolo.status === 200 && yolo.json['verified'] === false, 'district deploy lands UNVERIFIED — YOLO allowed, your rubble')

    const gated = await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'evil', scope: 'shared', source: 'act("blastoff")' } })
    ok(gated.status === 409, 'THE GATE: red shared deploy → 409')
    const gr = gated.json['report'] as { ok: boolean; reasons: string[] } | undefined
    ok(gr !== undefined && gr.ok === false && gr.reasons.some((x) => x.includes('unknown action')), 'THE GATE: the 409 carries the full oracle report')

    const compileRed = await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'bad2', scope: 'shared', source: 'not even close' } })
    ok(compileRed.status === 409 && String((compileRed.json['report'] as { reasons: string[] }).reasons[0]).includes('compile'), 'THE GATE: a compile error is red with the backtrace')

    const builder = await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'builder', scope: 'shared', source: 'act("contribute", structure="wall", amount=1)' } })
    ok(builder.status === 200 && builder.json['verified'] === true, 'green shared deploy lands VERIFIED through the gate')
    const br = builder.json['report'] as { ok: boolean; actions: unknown[] }
    ok(br.ok && br.actions.length === 1, 'the deploy report shows the dry-run actions')

    // ── ENGINE INTEGRATION on the real path: a template mines real ore ───────
    const miner = await api(`/api/room/${pin}/deploy`, { token: bea.worker, body: { id: 'miner', scope: 'district', source: MINER_SRC } })
    ok(miner.status === 200, 'the miner template deploys')
    const kv = await api(`/api/room/${pin}/deploy`, { token: bea.worker, body: { id: 'kv', scope: 'district', source: KV_SRC } })
    ok(kv.status === 200, 'the KV counter script deploys')

    let mined: RoomView | null = null
    for (let i = 0; i < 40; i++) {
      const st = await api(`/api/room/${pin}/state`, { token: bea.worker })
      const view = st.json['view'] as RoomView
      if (view.dyads[1] && view.dyads[1].ore > 0 && view.tick >= 3) {
        mined = view
        break
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    ok(mined !== null, 'ENGINE INTEGRATION: the deployed script gathered REAL ore through the subprocess')
    if (mined) {
      const own = mined.you!.scripts.find((x) => x.id === 'miner')!
      ok(own.lastTick !== null && own.lastTick.ran && own.lastTick.dOre > 0, 'per-tick yield recorded from the engine run')
      ok(own.lastTick!.gasUsed > 0, 'gas metering visible')
      const kvScript = mined.you!.scripts.find((x) => x.id === 'kv')!
      const kvLogs = kvScript.lastTick?.logs ?? []
      ok(kvLogs.some((l) => /kvtick [2-9]\d*/.test(l)), `KV MEMORY round-trips through the subprocess (logs: ${kvLogs.join(' | ')})`)
      const crash = (await api(`/api/room/${pin}/state`, { token: host.worker })).json['view'] as RoomView
      const crashScript = crash.you!.scripts.find((x) => x.id === 'crash')!
      ok(crashScript.lastTick?.err !== null && (crashScript.lastTick?.err ?? '').includes('compile'), 'a YOLO syntax error surfaces as an error value, script survives as evidence')
      ok(crashScript.errStreak >= 1, 'errStreak counts on the wire view')
      // tokens actually debited for runs (regen-capped, so just sanity)
      ok(mined.dyads[1].tokens <= 50, 'token economy live on the wire')
    }

    // ── the paid oracle endpoint ─────────────────────────────────────────────
    const before = ((await api(`/api/room/${pin}/state`, { token: bea.worker })).json['view'] as RoomView).dyads[1].tokens
    const check = await api(`/api/room/${pin}/oracle`, { token: bea.worker, body: { id: 'miner' } })
    ok(check.status === 200 && (check.json['report'] as { ok: boolean }).ok === true, 'oracle check on a good script → green report')
    const after = ((await api(`/api/room/${pin}/state`, { token: bea.worker })).json['view'] as RoomView)
    ok(after.you!.scripts.find((x) => x.id === 'miner')!.verified === true, 'green oracle check flips verified (storm armor)')
    ok(after.dyads[1].tokens <= before - ORACLE_COST + 10, 'oracle check debits ⚡')
    const missing = await api(`/api/room/${pin}/oracle`, { token: bea.worker, body: { id: 'ghost' } })
    ok(missing.status === 409, 'oracle on a missing script → 409')

    // ── the LAUNCH VOTE token split (the hinge, structural) ──────────────────
    const wVote = await api(`/api/room/${pin}/vote`, { token: host.worker, body: { go: true } })
    ok(wVote.status === 403, 'VOTE with the worker token → 403 (no agent can vote, by construction)')
    const hVote = await api(`/api/room/${pin}/vote`, { token: host.hinge, body: { go: true } })
    ok(hVote.status === 409 && String(hVote.json['error']).includes('ark'), 'hinge vote reaches the sim — refused only because the ark is not built')
    const beaLaunch = await api(`/api/room/${pin}/launch`, { token: bea.hinge, body: {} })
    ok(beaLaunch.status === 403, 'launch by a non-host → 403')
    const wLaunch = await api(`/api/room/${pin}/launch`, { token: host.worker, body: {} })
    ok(wLaunch.status === 403, 'launch with the worker token → 403')
    const hLaunch = await api(`/api/room/${pin}/launch`, { token: host.hinge, body: {} })
    ok(hLaunch.status === 409, 'host launch reaches the sim — refused because the ark is not built')

    // ── the agent paste-prompt: worker-only, hinge stays home ────────────────
    const promptRes = await fetch(`${BASE}/api/room/${pin}/agent-prompt?token=${host.worker}`)
    const promptText = await promptRes.text()
    ok(promptRes.status === 200, 'agent-prompt with the worker token → 200')
    ok(promptText.includes(host.worker), 'the prompt embeds the WORKER token')
    ok(!promptText.includes(host.hinge), 'the prompt NEVER embeds the hinge token')
    ok(promptText.toLowerCase().includes('starlark') && promptText.includes('deploy'), 'the prompt teaches the ark game')
    ok(promptText.includes('Never bypass'), 'the prompt keeps the no-bypass covenant')
    ok(!promptText.includes('/vote'), 'the prompt does not teach the vote endpoint')
    ok((await fetch(`${BASE}/api/room/${pin}/agent-prompt?token=${host.hinge}`)).status === 403, 'agent-prompt with the hinge token → 403 (wrong surface)')

    // ── DROP-IN mid-game over ws + the redaction audit ───────────────────────
    const carol = new TestClient('key-carol', 'Carol')
    await carol.open(pin)
    await carol.waitFor((m) => m.type === 'welcome', 'carol welcome')
    ok(carol.welcome!.index === 2, 'ws drop-in mid-game gets the next district')
    const cv = await carol.waitView((v) => v.dyads.length === 3, 'carol view')
    ok(cv.tick > 0 && cv.dyads[2].district === 2, `drop-in landed in a RUNNING world (tick ${cv.tick})`)
    await carol.waitView((v) => v.you !== null && v.tick >= cv.tick + 2, 'carol sees ticks advance')
    const carolRaws = carol.snapshotRaws.join('\n')
    ok(!carolRaws.includes(MINER_SRC.slice(0, 30)), "REDACTION: other seats' script SOURCE never crosses the wire")
    ok(!carolRaws.includes(host.worker) && !carolRaws.includes(host.hinge) && !carolRaws.includes(bea.worker) && !carolRaws.includes(bea.hinge), 'REDACTION: no auth token ever appears in a snapshot')
    ok(carolRaws.includes('"lastNote"') || carolRaws.includes('builder'), 'public script fates DO cross (existence, scope, notes)')
    carol.close()

    // ── GET /log: the replay artifact, redacted + replayable ─────────────────
    const beaLog = (await api(`/api/room/${pin}/log`, { token: bea.worker })).json as unknown as RoomLogView & { ok: boolean }
    ok(beaLog.engine !== null && typeof beaLog.engine!.version === 'string', 'the replay header pins the engine identity')
    const beaDeploys = beaLog.log.filter((e) => e.cmd['t'] === 'deploy')
    const foreign = beaDeploys.filter((e) => e.cmd['player'] !== 1)
    ok(foreign.length > 0 && foreign.every((e) => e.cmd['source'] === '[redacted until launch]'), "REDACTION: other seats' deploy source is stripped from /log until launch")
    ok(beaDeploys.some((e) => e.cmd['player'] === 1 && e.cmd['source'] === MINER_SRC), 'your own deploy source IS yours to read')

    // determinism: replay MY OWN room? need full sources → use a fresh solo room
    const solo = await api('/api/room', { body: { name: 'Solo', tickMs: 400 } })
    const soloPin = solo.json['pin'] as string
    const soloTok = solo.json['workerToken'] as string
    await api(`/api/room/${soloPin}/deploy`, { token: soloTok, body: { id: 'm', scope: 'district', source: MINER_SRC } })
    await new Promise((r) => setTimeout(r, 1700))
    let logView: RoomLogView | null = null
    let stView: RoomView | null = null
    for (let i = 0; i < 6; i++) {
      const lg = (await api(`/api/room/${soloPin}/log`, { token: soloTok })).json as unknown as RoomLogView
      const st = (await api(`/api/room/${soloPin}/state`, { token: soloTok })).json['view'] as RoomView
      if (lg.tick === st.tick) {
        logView = lg
        stView = st
        break
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    ok(logView !== null && stView !== null, 'log + state captured at the same tick')
    if (logView && stView) {
      const entries = logView.log.map((e) => ({ atTick: e.atTick, cmd: e.cmd as unknown as Command }))
      const replayed = replay(logView.seed, entries, logView.tick)
      ok(replayed.tick === stView.tick, 'replayed tick matches the live room')
      ok(replayed.dyads[0].ore === stView.dyads[0].ore && replayed.dyads[0].tokens === stView.dyads[0].tokens, `REPLAY: seed + log reproduces the live room over the wire (ore ${replayed.dyads[0].ore}, ⚡ ${replayed.dyads[0].tokens})`)
      ok(stateHash(replayed).length === 8, 'replay hash computable from the wire artifact')
    }

    // ── refusal shapes ───────────────────────────────────────────────────────
    ok((await api(`/api/room/ZZZZ/state`)).status === 404, 'unknown room → 404')
    ok((await api(`/api/room/${pin}/deploy`, { token: 'w_bogus', body: { id: 'x', scope: 'district', source: 'act("farm", rate=1)' } })).status === 401, 'unknown token → 401')
    ok((await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'x', scope: 'nope', source: 'act("farm", rate=1)' } })).status === 400, 'bad scope → 400')
    ok((await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'x', scope: 'district' } })).status === 400, 'missing source → 400')
    ok((await api(`/api/room/${pin}/undeploy`, { token: host.worker, body: { id: 'nope' } })).status === 409, 'undeploy unknown → 409 with the spoken reason')
    ok((await api(`/api/room/${pin}/vote`, { token: host.hinge, body: {} })).status === 400, 'vote without go → 400')

    // token sanity: the economy started where the rules said
    ok(TOKEN_START === 20, 'TOKEN_START pinned (rules drift guard)')
  } finally {
    await killGame(server)
  }

  console.log(failed === 0 ? `WSTEST OK — ${passed} assertions` : `WSTEST FAILED — ${failed} failures (${passed} passed)`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
