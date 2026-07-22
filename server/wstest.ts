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
import { BETA_RUN_COST, CHRONICLE_COST, ORACLE_COST, TOKEN_START } from '../shared/sim/balance.ts'
import { replay, stateHash } from '../shared/sim/sim.ts'
import type { Command } from '../shared/sim/types.ts'
import type { BetaReport, ClientMessage, RoomLogView, RoomView, ServerMessage } from '../shared/protocol.ts'
import { EngineHost } from './engine.ts'
import { loadRegistry, resolveRegistryForRoom } from './registry.ts'
import { Room, RoomRegistry } from './rooms.ts'
import { seedFromCode } from '../shared/mpConfig.ts'

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
  // END_GRACE + SWEEP tightened so the host-end teardown path is provable in
  // seconds; they only affect FINISHED rooms, so every other room is safe.
  const server = spawnGame(PORT, { AIMANCER_ENGINE_BIN: engineBin, END_GRACE_MS: '1500', SWEEP_INTERVAL_MS: '400' })
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
    ok(rulesText.includes('You deploy directly') && rulesText.includes('GO/NO-GO'), '/api/rules carries the FREEDOM ark game')
    ok(rulesText.includes('GATE POLICY') && rulesText.includes('Mirror Yard') && rulesText.includes('Chronicle'), '/api/rules carries gates/beta/chronicle')
    ok(rulesText.includes('gate-policy') && rulesText.includes('beta-run') && rulesText.includes('/end'), '/api/rules API section covers the new routes')
    ok(rulesText.includes('more than it admits'), '/api/rules carries the one honest hint')
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

    // ── FREEDOM: deploys are DIRECT; gates are the seat's own policy ─────────
    const yolo = await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'crash', scope: 'district', source: 'this is not starlark' } })
    ok(yolo.status === 200 && yolo.json['verified'] === false, 'district deploy lands UNVERIFIED — YOLO allowed, your rubble')

    const freeShared = await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'evil', scope: 'shared', source: 'act("blastoff")' } })
    ok(freeShared.status === 200 && freeShared.json['verified'] === false, 'FREEDOM: a shared deploy lands DIRECT + unverified under the default policy (no server gate)')
    await api(`/api/room/${pin}/undeploy`, { token: host.worker, body: { id: 'evil' } })

    // the HUMAN builds the gate: hinge sets oracle-green on shared
    const gpDefault = await api(`/api/room/${pin}/gate-policy`, { token: host.worker })
    const gpPol = gpDefault.json['policy'] as { district: string[]; shared: string[] }
    ok(gpDefault.status === 200 && gpPol.shared.length === 0 && gpPol.district.length === 0, 'GET gate-policy: the default is none (deploy freely)')
    ok((await api(`/api/room/${pin}/gate-policy`, { method: 'PUT', token: host.worker, body: { shared: ['oracle-green'] } })).status === 403, 'PUT gate-policy with the WORKER token → 403 (the discipline is human-owned)')
    ok((await api(`/api/room/${pin}/gate-policy`, { method: 'PUT', token: host.hinge, body: { shared: ['nonsense'] } })).status === 400, 'PUT gate-policy with an unknown requirement → 400')
    const gpSet = await api(`/api/room/${pin}/gate-policy`, { method: 'PUT', token: host.hinge, body: { shared: ['oracle-green'] } })
    ok(gpSet.status === 200 && (gpSet.json['policy'] as { shared: string[] }).shared[0] === 'oracle-green', 'PUT gate-policy with the HINGE sets the gate')

    const gated = await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'evil', scope: 'shared', source: 'act("blastoff")' } })
    ok(gated.status === 409 && String(gated.json['error']).includes('YOUR GATE'), "YOUR GATE: red shared deploy → 409, named as the seat's own gate")
    const gr = gated.json['report'] as { ok: boolean; reasons: string[] } | undefined
    ok(gr !== undefined && gr.ok === false && gr.reasons.some((x) => x.includes('unknown action')), 'YOUR GATE: the 409 carries the full oracle report')

    const compileRed = await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'bad2', scope: 'shared', source: 'not even close' } })
    ok(compileRed.status === 409 && String((compileRed.json['report'] as { reasons: string[] }).reasons[0]).includes('compile'), 'YOUR GATE: a compile error is red with the backtrace')

    const builder = await api(`/api/room/${pin}/deploy`, { token: host.worker, body: { id: 'builder', scope: 'shared', source: 'act("contribute", structure="wall", amount=1)' } })
    ok(builder.status === 200 && builder.json['verified'] === true, 'green shared deploy lands VERIFIED through your own gate')
    const br = builder.json['report'] as { ok: boolean; actions: unknown[] }
    ok(br.ok && br.actions.length === 1, 'the deploy report shows the dry-run actions')

    // gate-blocked + gate-set notices are PRIVATE to the seat
    const hostView = (await api(`/api/room/${pin}/state`, { token: host.worker })).json['view'] as RoomView
    const noticeKinds = (hostView.you!.notices ?? []).map((n) => n.kind)
    ok(noticeKinds.includes('gate-set') && noticeKinds.includes('gate-blocked'), 'seat notices carry gate-set + gate-blocked (private)')
    ok(hostView.you!.gatePolicy.shared[0] === 'oracle-green', 'the view carries YOUR gate policy (agent-visible)')

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
    ok(promptText.includes('deploy directly') || promptText.includes('DEPLOY THEM DIRECTLY'), 'the prompt teaches DIRECT deploys')
    ok(promptText.includes('gate-policy') && promptText.includes('beta-run') && promptText.includes('chronicle'), 'the prompt teaches gates, the Mirror Yard, and the chronicle')
    ok(promptText.includes('more than this document admits'), 'the prompt carries the ONE honest hidden-surface hint')
    ok(promptText.includes('handed, not taken'), 'the prompt teaches hinge CUSTODY: the vote token is handed by the human, never taken')
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
    // freedom commands enter the log too: a chronicle claim + a beta debit —
    // the replay below must reproduce them (economy + shared memory replay)
    await api(`/api/room/${soloPin}/chronicle`, { token: soloTok, body: { text: 'replay-proof claim', evidence: ['wstest'] } })
    await api(`/api/room/${soloPin}/beta-run`, { token: soloTok, body: { script: 'act("farm", rate=1)', scope: 'district', ticks: 1 } })
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
      ok(replayed.chronicle.length === 1 && replayed.chronicle[0].text === 'replay-proof claim', 'REPLAY: the chronicle rides the log (spend + chronicle commands replay)')
      ok(entries.some((e) => e.cmd.t === 'spend'), 'the beta debit is IN the log; the beta run itself is not')
      ok(!JSON.stringify(entries).includes('"perTick"'), 'no beta report material ever enters the log')
    }

    // ── THE MIRROR YARD: cost, determinism, bounds ───────────────────────────
    {
      const slow = await api('/api/room', { body: { name: 'Mirror', tickMs: 20000 } })
      const mPin = slow.json['pin'] as string
      const mTok = slow.json['workerToken'] as string
      ok((await api(`/api/room/${mPin}/beta-run`, { body: { script: 'act("farm", rate=1)', scope: 'district', ticks: 3 } })).status === 401, 'beta-run without a token → 401')
      ok((await api(`/api/room/${mPin}/beta-run`, { token: mTok, body: { script: 'act("farm", rate=1)', scope: 'district', ticks: 0 } })).status === 400, 'beta-run ticks 0 → 400')
      ok((await api(`/api/room/${mPin}/beta-run`, { token: mTok, body: { script: 'act("farm", rate=1)', scope: 'district', ticks: 11 } })).status === 400, 'beta-run ticks 11 → 400')
      ok((await api(`/api/room/${mPin}/beta-run`, { token: mTok, body: { script: '', scope: 'district', ticks: 3 } })).status === 400, 'beta-run empty script → 400')
      const before = ((await api(`/api/room/${mPin}/state`, { token: mTok })).json['view'] as RoomView).dyads[0].tokens
      const runA = await api(`/api/room/${mPin}/beta-run`, { token: mTok, body: { script: 'act("gather", node=1, rate=2)\nact("farm", rate=2)', scope: 'district', ticks: 3 } })
      ok(runA.status === 200, 'beta-run happy path → 200')
      const repA = runA.json['report'] as BetaReport
      ok(repA.ok && repA.perTick.length === 3, 'beta report: 3 ticks rehearsed, clean = PASS')
      ok(repA.totals.food === 6, `beta yields honest deltas (food ${repA.totals.food})`)
      const mid = ((await api(`/api/room/${mPin}/state`, { token: mTok })).json['view'] as RoomView).dyads[0].tokens
      ok(mid === before - BETA_RUN_COST, `beta debits ${BETA_RUN_COST}⚡ from the REAL balance`)
      const stateAfterA = (await api(`/api/room/${mPin}/state`, { token: mTok })).json['view'] as RoomView
      ok(stateAfterA.dyads[0].food === 0 && stateAfterA.dyads[0].ore === 0, 'the beta run touched NOTHING in the real world')
      // DETERMINISM: same fork (world holds still at 20s tick) + same script
      // ⇒ byte-identical report
      const runB = await api(`/api/room/${mPin}/beta-run`, { token: mTok, body: { script: 'act("gather", node=1, rate=2)\nact("farm", rate=2)', scope: 'district', ticks: 3 } })
      ok(JSON.stringify(runB.json['report']) === JSON.stringify(repA), 'BETA DETERMINISM: same fork + same script = identical report')
      // a broken script is a red REPORT, not an error
      const runBad = await api(`/api/room/${mPin}/beta-run`, { token: mTok, body: { script: 'act("blastoff")', scope: 'shared', ticks: 2 } })
      const repBad = runBad.json['report'] as BetaReport
      ok(runBad.status === 200 && repBad.ok === false && repBad.failures.length > 0, 'a failing candidate is an honest FAILED report (still costs — the yard opened)')
    }

    // ── beta-pass GATE: the reference discipline, enforced ───────────────────
    {
      const g = await api('/api/room', { body: { name: 'Gates', tickMs: 20000 } })
      const gPin = g.json['pin'] as string
      const gW = g.json['workerToken'] as string
      const gH = g.json['hingeToken'] as string
      await api(`/api/room/${gPin}/gate-policy`, { method: 'PUT', token: gH, body: { shared: ['beta-pass'] } })
      const SRC2 = 'act("contribute", structure="wall", amount=1)'
      const blocked = await api(`/api/room/${gPin}/deploy`, { token: gW, body: { id: 'b1', scope: 'shared', source: SRC2 } })
      ok(blocked.status === 409 && String(blocked.json['error']).includes('beta-pass'), 'beta-pass gate: an unrehearsed shared deploy → 409')
      const rehearse = await api(`/api/room/${gPin}/beta-run`, { token: gW, body: { script: SRC2, scope: 'shared', ticks: 2 } })
      ok(rehearse.status === 200 && (rehearse.json['report'] as BetaReport).ok, 'the rehearsal passes')
      const now = await api(`/api/room/${gPin}/deploy`, { token: gW, body: { id: 'b1', scope: 'shared', source: SRC2 } })
      ok(now.status === 200, 'beta-pass gate: the SAME source now deploys')
      const other = await api(`/api/room/${gPin}/deploy`, { token: gW, body: { id: 'b2', scope: 'shared', source: SRC2 + '\n# edited' } })
      ok(other.status === 409, 'beta-pass matches the EXACT source — an edited script must re-rehearse')
    }

    // ── THE CHRONICLE over the wire ──────────────────────────────────────────
    {
      const c = await api('/api/room', { body: { name: 'Scribe', tickMs: 20000 } })
      const cPin = c.json['pin'] as string
      const cW = c.json['workerToken'] as string
      const t0 = ((await api(`/api/room/${cPin}/state`, { token: cW })).json['view'] as RoomView).dyads[0].tokens
      const post = await api(`/api/room/${cPin}/chronicle`, { token: cW, body: { text: 'vein 2 is the rich one', evidence: ['survey'] } })
      ok(post.status === 200 && post.json['id'] === 1, 'chronicle post lands with id 1 (worker token — agents write the memory)')
      const t1 = ((await api(`/api/room/${cPin}/state`, { token: cW })).json['view'] as RoomView).dyads[0].tokens
      ok(t1 === t0 - CHRONICLE_COST, `a claim costs ${CHRONICLE_COST}⚡`)
      ok((await api(`/api/room/${cPin}/chronicle`, { token: cW, body: { text: 'vein 2 is the rich one' } })).status === 409, 'exact duplicate → 409 (novelty dedupe on the wire)')
      await api(`/api/room/${cPin}/chronicle`, { token: cW, body: { text: 'the storm cadence is seeded', relatesTo: [1] } })
      const read = await api(`/api/room/${cPin}/chronicle`)
      const entries2 = read.json['entries'] as Array<{ id: number; text: string; relatesTo: number[] }>
      ok(read.status === 200 && entries2.length === 2 && entries2[1].relatesTo[0] === 1, 'GET chronicle is public and carries relates-to')
      const q = await api(`/api/room/${cPin}/chronicle?q=storm`)
      ok((q.json['entries'] as unknown[]).length === 1, 'chronicle ?q= filters by substring')
      const byAuthor = await api(`/api/room/${cPin}/chronicle?author=0`)
      ok((byAuthor.json['entries'] as unknown[]).length === 2, 'chronicle ?author= filters by seat')
      const cView = (await api(`/api/room/${cPin}/state`)).json['view'] as RoomView
      ok(cView.chronicle.length === 2 && cView.chronicleCount === 2, 'the room view surfaces the chronicle (board feed)')
    }

    // ── HIDDEN SURFACES: help topics, endpoints, verbs, the world-field ──────
    {
      const helpIndex = await api('/api/help')
      const topics = helpIndex.json['topics'] as Array<{ id: string }>
      ok(helpIndex.status === 200 && topics.some((t) => t.id === 'the-game'), 'GET /api/help lists the documented topics')
      ok(!topics.some((t) => t.id === 'aimancer'), 'hidden topics are NOT in the index (deliberately)')
      const doc = await fetch(`${BASE}/api/help/the-deploy-gate`)
      ok(doc.status === 200 && (await doc.text()).includes('GATE POLICY'), 'a documented topic serves its section, no auth')
      ok((await fetch(`${BASE}/api/help/aimancer`)).status === 404, 'a hidden topic WITHOUT a token → 404 (indistinguishable from nothing)')
      ok((await fetch(`${BASE}/api/help/no-such-thing?token=${host.worker}`)).status === 404, 'an unknown topic with a token → the same 404')

      const h = await api('/api/room', { body: { name: 'Digger', tickMs: 300 } })
      const hPin = h.json['pin'] as string
      const hW = h.json['workerToken'] as string
      const frag = await fetch(`${BASE}/api/help/aimancer?token=${hW}`)
      ok(frag.status === 200 && (await frag.text()).length > 50, 'a hidden topic WITH a seat token answers with the lore fragment')
      const afterFind = (await api(`/api/room/${hPin}/state`, { token: hW })).json['view'] as RoomView
      const disco = afterFind.chronicle.find((e) => e.kind === 'discovery')
      ok(disco !== undefined && disco.text.includes('first uncovered by'), 'FIRST DISCOVERY: a free chronicle entry names the finder')
      await fetch(`${BASE}/api/help/aimancer?token=${hW}`)
      const again = (await api(`/api/room/${hPin}/state`, { token: hW })).json['view'] as RoomView
      ok(again.chronicle.filter((e) => e.kind === 'discovery').length === 1, 'a re-find is NOT a second discovery')
      ok((await fetch(`${BASE}/api/help/granary-ledger?token=${hW}`)).status === 404, 'a CONDITIONED topic before its condition → 404 (the room has not earned it)')

      const bench = await fetch(`${BASE}/api/room/${hPin}/survey?token=${hW}`)
      ok(bench.status === 200 && (await bench.text()).includes('surveyor'), 'a hidden ENDPOINT answers a seat token')
      ok((await fetch(`${BASE}/api/room/${hPin}/survey`)).status === 404, 'the same endpoint without a token → 404')
      ok((await fetch(`${BASE}/api/room/${hPin}/definitely-not-real?token=${hW}`)).status === 404, 'an unregistered path stays an honest 404')

      // hidden VERB via a deployed script: act("salvage") — earned at tick 3
      await api(`/api/room/${hPin}/deploy`, { token: hW, body: { id: 'dig', scope: 'district', source: 'act("salvage")\nact("farm", rate=1)' } })
      let dug: RoomView | null = null
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250))
        const v = (await api(`/api/room/${hPin}/state`, { token: hW })).json['view'] as RoomView
        if (v.you!.notices.some((n) => n.kind === 'lore' && n.text.includes('salvage'))) {
          dug = v
          break
        }
      }
      ok(dug !== null, 'a hidden VERB answers a running script (lore notice to the seat)')
      if (dug) {
        ok(dug.chronicle.some((e) => e.kind === 'discovery' && e.text.includes('salvage yard')), 'the verb discovery enters the chronicle')
        ok(dug.you!.scripts.find((x) => x.id === 'dig')!.lastTick?.note.includes('unknown') === false, 'the hidden verb is STRIPPED (never an unknown-action note, never logged)')
        // the world-field grant: this seat's scripts now see world["salvage"]
        await api(`/api/room/${hPin}/deploy`, { token: hW, body: { id: 'probe', scope: 'district', source: 'print("field", "yes" if "salvage" in world else "no")\nact("farm", rate=1)' } })
        let sees: boolean = false
        for (let i = 0; i < 30 && !sees; i++) {
          await new Promise((r) => setTimeout(r, 250))
          const v = (await api(`/api/room/${hPin}/state`, { token: hW })).json['view'] as RoomView
          sees = (v.you!.scripts.find((x) => x.id === 'probe')?.lastTick?.logs ?? []).some((l) => l.includes('field yes'))
        }
        ok(sees, 'the WORLD-FIELD pays forward: the finder\'s scripts see world["salvage"]')
      }
    }

    // ── ROOM LIFECYCLE: host end + teardown (anti-immortal-rooms) ────────────
    {
      const e = await api('/api/room', { body: { name: 'Ender', tickMs: 300 } })
      const ePin = e.json['pin'] as string
      const eW = e.json['workerToken'] as string
      const eH = e.json['hingeToken'] as string
      ok((e.json['tokenRoles'] as { hinge?: string })?.hinge?.includes('launch vote') === true, 'join/create responses LABEL both tokens (CLI-only players know which is which)')
      const j2 = await api(`/api/room/${ePin}/join`, { body: { name: 'Guest' } })
      ok((await api(`/api/room/${ePin}/end`, { token: eW, body: {} })).status === 403, 'END with the worker token → 403 (a human act)')
      ok((await api(`/api/room/${ePin}/end`, { token: j2.json['hingeToken'] as string, body: {} })).status === 403, 'END by a non-host hinge → 403')
      ok((await api(`/api/room/${ePin}/end`, { token: eH, body: {} })).status === 200, 'END by the HOST hinge → the host calls the game')
      const ended = (await api(`/api/room/${ePin}/state`, { token: eW })).json['view'] as RoomView
      ok(ended.launched && ended.endedEarly && ended.end !== null, 'the end screen stands as it was (endedEarly flagged)')
      ok((await api(`/api/room/${ePin}/deploy`, { token: eW, body: { id: 'x', scope: 'district', source: 'act("farm", rate=1)' } })).status === 409, 'no deploys into an ended settlement')
      // teardown: END_GRACE_MS=1500 + SWEEP_INTERVAL_MS=400 on this server
      let gone = false
      for (let i = 0; i < 20 && !gone; i++) {
        await new Promise((r) => setTimeout(r, 400))
        gone = (await api(`/api/room/${ePin}/state`, { token: eW })).status === 404
      }
      ok(gone, 'TEARDOWN: the ended room is swept after the reading grace (sockets or not)')
    }

    // ── in-process floor: the clipped tongue + the clue engine + graces ──────
    {
      const stubEngine = new EngineHost(null)
      // THE CLIPPED TONGUE: no vowel (or y) in the alphabet — no PIN can ever
      // be a word/name; canon names are structurally retired, rite-only.
      ok(!/[AEIOUY]/.test(CODE_ALPHABET), 'PIN alphabet holds NO vowels (profanity-proof; names are earned, never drawn)')
      const plain = new Room('QQQQ', stubEngine)
      plain.seatJoin('Bob', 'k-bob')
      ok(plain.sim.chronicle.length === 0, 'founding is quiet — no draw-recognition (naming is the Rite, a future drop)')
      ok(plain.displayName === null && plain.viewFor(0).displayName === null, 'the earned-name slot exists and starts empty (Rite of Naming hook)')
      // THE CLUE ENGINE: canon static, instance seeded — same seed = same
      // draw forever; different rooms can differ; no slot survives resolution
      const loreReg = loadRegistry()
      const a1 = resolveRegistryForRoom(loreReg, seedFromCode('QQQQ'))
      const a2 = resolveRegistryForRoom(loreReg, seedFromCode('QQQQ'))
      ok(JSON.stringify(a1) === JSON.stringify(a2), 'CLUE ENGINE: resolution is deterministic per seed (replays/writeups stay honest)')
      ok(!JSON.stringify(a1.surfaces).includes('{{pool:'), 'CLUE ENGINE: every slot resolves (no template braces survive)')
      const surveyWord = (seed: number) => resolveRegistryForRoom(loreReg, seed).surfaces.find((s) => s.key === 'survey')!.fragment
      let differs = false
      for (let s2 = 1; s2 < 60 && !differs; s2++) differs = surveyWord(s2) !== surveyWord(1)
      ok(differs, "CLUE ENGINE: different rooms draw different instances (knowledge transfers as METHOD, not answer)")
      // finish graces: host end ⇒ short reading grace; launch ⇒ the longer one
      const now = Date.now()
      const endRoom = new Room('QQQC', stubEngine)
      endRoom.seatJoin('E', 'k-e')
      endRoom.command({ t: 'end' })
      ok(!endRoom.finishedFor(now + 30_000), 'ended room lives through the reading grace')
      ok(endRoom.finishedFor(now + 3 * 60_000), 'ended room dies after ~2 min (END_GRACE)')
      const launchRoom = new Room('QQQB', stubEngine)
      launchRoom.seatJoin('L', 'k-l')
      launchRoom.sim.structures.wall.complete = true
      launchRoom.sim.structures.granary.complete = true
      launchRoom.sim.structures.beacon.complete = true
      launchRoom.sim.structures.ark.complete = true
      launchRoom.command({ t: 'vote', player: 0, go: true })
      launchRoom.command({ t: 'launch' })
      ok(!launchRoom.finishedFor(now + 5 * 60_000), 'launched room holds the reveal for ~10 min')
      ok(launchRoom.finishedFor(now + 11 * 60_000), 'launched room dies after the reveal TTL')
      // the inactivity sweeper still covers abandoned rooms in every phase
      const reg = new RoomRegistry()
      const idle = reg.create()
      idle.touch()
      reg.sweep(Date.now() + 31 * 60_000, 30 * 60_000)
      ok(reg.get(idle.code) === undefined, 'IDLE SWEEP: an abandoned (HTTP-only) room is reaped after the inactivity TTL')
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
