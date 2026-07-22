// AIMANCER server — ARK PIVOT. Serves the built client (dist/), /healthz and
// /version (the deploy oracle), the authoritative rooms on /ws, AND the full
// HTTP surface (the BYO-agent surface — everything a seat can do over ws
// works over HTTP):
//   GET  /api/rules                    — the complete rules, markdown, NO auth
//   GET  /api/templates                — the Starlark template library, NO auth
//   GET  /api/help[/:topic]            — help docs (documented topics public;
//                                        the API holds more than the list admits)
//   POST /api/room                     — create a settlement (creator = host, seat 0)
//   POST /api/room/:pin/join          — DROP-IN join by PIN (reconnect-by-key honored)
//   GET  /api/room/:pin/agent-prompt  — WORKER token: the ready-to-paste prompt
//   GET  /api/room/:pin/state          — redacted per token (public without one)
//   GET  /api/room/:pin/log            — command log + replay header (engine pinned)
//   POST /api/room/:pin/deploy        — either token, either scope, DIRECT
//                                        (FREEDOM UPDATE: the only deploy gate
//                                        is the seat's OWN policy — 409 when
//                                        YOUR gate blocks, report attached)
//   POST /api/room/:pin/undeploy      — either token
//   POST /api/room/:pin/oracle        — either token: paid verify (engine dry-run)
//   GET  /api/room/:pin/gate-policy   — your seat's policy (either token)
//   PUT  /api/room/:pin/gate-policy   — HINGE only: the human sets the gates
//   POST /api/room/:pin/beta-run      — either token: the MIRROR YARD (fork +
//                                        rehearse N ticks, private report, ⚡)
//   GET  /api/room/:pin/chronicle     — the shared lore-memory (public read)
//   POST /api/room/:pin/chronicle     — either token: post a claim (⚡, deduped)
//   POST /api/room/:pin/vote          — HINGE token ONLY (the human's voice;
//                                        hinge CUSTODY is the player's choice)
//   POST /api/room/:pin/launch        — HOST HINGE only (majority must stand)
//   POST /api/room/:pin/end           — HOST HINGE only: call the game (end
//                                        screen, then teardown after a grace)
// Error shape everywhere: { ok:false, error } with 400 malformed · 401 no/bad
// token · 403 wrong surface · 404 no room · 405 method · 409 the game said no
// (including your own gate policy, which also carries `report`).
// BREAKING vs the pre-pivot API (documented in ROADMAP.md): draft/arm/disarm/
// scrap/prospect/claim-contract/start/phase/hold are GONE — the ark game has
// deploy/undeploy/oracle/vote/launch/end instead.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, readFile } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { mintKey, RoomRegistry, type Room } from './rooms.ts'
import { buildAgentPrompt } from './agentPrompt.ts'
import { rulesMarkdown, rulesSections } from '../shared/rules.ts'
import { TEMPLATES } from '../shared/templates.ts'
import { engineHost } from './engine.ts'
import { hiddenRegistry } from './registry.ts'
import type { ScriptScope } from '../shared/sim/types.ts'

/** How both tokens are labeled in every join/create response — a CLI-only
 * player (no phone page) must know which is which: hinge-token CUSTODY is the
 * player's choice; the ENDPOINT gating (vote/launch/end/gate-policy = hinge)
 * is the structural minimum and never moves. */
const TOKEN_ROLES = {
  worker: "the agent's surface — state/deploy/oracle/beta-run/chronicle",
  hinge: "the human's voice — the launch vote, gate policy, host end/launch (custody is yours to delegate at vote time)",
} as const

const PORT = Number(process.env.PORT ?? 8080)
const DIST = join(process.cwd(), 'dist')

function readVersion(): string {
  try {
    return readFileSync(join(DIST, 'version.txt'), 'utf8').trim()
  } catch {
    return process.env.VITE_GIT_SHA?.trim() || 'dev'
  }
}
const VERSION = readVersion()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
}

const registry = new RoomRegistry()

// ── HTTP API helpers ─────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function bearerToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers.authorization ?? ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return url.searchParams.get('token') ?? ''
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function externalBase(req: IncomingMessage): string {
  const first = (v: unknown): string => String(v ?? '').split(',')[0].trim()
  const proto = first(req.headers['x-forwarded-proto']) || 'http'
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host) || `localhost:${PORT}`
  return `${proto}://${host}`
}

const RULES_MD = rulesMarkdown()

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/api/rules') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(RULES_MD)
    return
  }

  // the agentless floor: the template library is public reference material
  if (url.pathname === '/api/templates') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    sendJson(res, 200, { ok: true, templates: TEMPLATES })
    return
  }

  // HELP — documented topics are public (the rules, per section). Hidden
  // topics exist too; they answer only to a seat token in a room that has
  // earned them, and an unearned topic is indistinguishable from an unknown
  // one. The index lists ONLY the documented topics — deliberately.
  const helpMatch = url.pathname.match(/^\/api\/help(?:\/([a-z0-9-]{1,40}))?$/)
  if (helpMatch) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    const topic = helpMatch[1]
    if (!topic) {
      sendJson(res, 200, { ok: true, topics: rulesSections().map((s) => ({ id: s.id, title: s.title })) })
      return
    }
    const documented = rulesSections().find((s) => s.id === topic)
    if (documented) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`# ${documented.title}\n\n${documented.body}\n`)
      return
    }
    // hidden: resolve the token to a seat in SOME live room (archaeology
    // needs your settlement credentials)
    const token = bearerToken(req, url)
    if (token) {
      for (const room of registry.all()) {
        const who = room.auth(token)
        if (!who) continue
        room.touch()
        const fragment = room.hiddenHelp(who.seat, topic)
        if (fragment) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(fragment + '\n')
          return
        }
        break
      }
    }
    sendJson(res, 404, { ok: false, error: 'no help for that topic' })
    return
  }

  // POST /api/room — create a settlement; the creator is seated as HOST
  // (seat 0, the launch-confirm hinge) and gets BOTH tokens. The world is
  // live immediately — continuous play, no start step.
  if (url.pathname === '/api/room') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    let body: { name?: string; tickMs?: number }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
    }
    const room = registry.create()
    room.configure({ tickMs: body.tickMs })
    const seated = room.seatJoin(typeof body.name === 'string' ? body.name : '', mintKey())
    if (!seated.ok) return sendJson(res, seated.code, { ok: false, error: seated.error })
    const seat = room.seats[seated.seat]
    room.touch()
    sendJson(res, 200, { ok: true, pin: room.code, seat: seated.seat, name: seat.name, key: seat.key, workerToken: seat.workerToken, hingeToken: seat.hingeToken, tokenRoles: TOKEN_ROLES, tickMs: room.tickMs })
    return
  }

  const m = url.pathname.match(/^\/api\/room\/([A-Za-z]{1,8})\/([a-z0-9-]{1,40})$/)
  if (!m) {
    sendJson(res, 404, { ok: false, error: 'unknown api route' })
    return
  }
  const room: Room | undefined = registry.get(m[1])
  if (!room) {
    sendJson(res, 404, { ok: false, error: `no settlement '${m[1].toUpperCase()}'` })
    return
  }
  room.touch()
  const action = m[2]
  const token = bearerToken(req, url)
  const who = room.auth(token)
  // "agent connected" liveness: any worker-token call marks the seat's agent
  // live — EXCEPT the phone's own calls (x-aimancer-phone) and the prompt
  // fetch, which would false-positive every seat.
  if (who && who.role === 'worker' && action !== 'agent-prompt' && !req.headers['x-aimancer-phone']) room.noteWorkerSeen(who.seat)

  if (action === 'join') {
    // DROP-IN: join anytime until the launch. Reconnect-by-key returns the
    // SAME seat + tokens.
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    let body: { name?: string; key?: string }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
    }
    const key = typeof body.key === 'string' && body.key ? body.key : mintKey()
    const seated = room.seatJoin(typeof body.name === 'string' ? body.name : '', key)
    if (!seated.ok) return sendJson(res, seated.code, { ok: false, error: seated.error })
    const seat = room.seats[seated.seat]
    sendJson(res, 200, { ok: true, pin: room.code, seat: seated.seat, rejoined: seated.rejoined, name: seat.name, key: seat.key, workerToken: seat.workerToken, hingeToken: seat.hingeToken, tokenRoles: TOKEN_ROLES })
    return
  }

  if (action === 'agent-prompt') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    if (!who) return sendJson(res, 401, { ok: false, error: 'missing or unknown token' })
    if (who.role !== 'worker') {
      return sendJson(res, 403, { ok: false, error: 'the agent prompt embeds the WORKER token — fetch it with the worker token (the hinge stays on your phone)' })
    }
    const text = buildAgentPrompt({
      baseUrl: externalBase(req),
      pin: room.code,
      name: room.seats[who.seat].name,
      workerToken: token,
      tickMs: room.tickMs,
    })
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(text)
    return
  }

  if (action === 'state') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    sendJson(res, 200, { ok: true, view: room.viewFor(who ? who.seat : null) })
    return
  }

  if (action === 'log') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    sendJson(res, 200, { ok: true, ...room.logView(token) })
    return
  }

  // GATE POLICY: GET = your own policy (either token); PUT = hinge only
  if (action === 'gate-policy') {
    if (req.method === 'GET') {
      const r = room.gatePolicyFor(token)
      if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
      return sendJson(res, 200, { ok: true, seat: r.seat, policy: r.policy })
    }
    if (req.method === 'PUT') {
      let body: unknown
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
      }
      const r = room.trySetGatePolicy(token, body)
      if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
      return sendJson(res, 200, { ok: true, policy: r.policy })
    }
    return sendJson(res, 405, { ok: false, error: 'GET or PUT' })
  }

  // CHRONICLE read: public — the settlement's shared memory
  if (action === 'chronicle' && req.method === 'GET') {
    const entries = room.chronicleEntries({
      author: url.searchParams.get('author') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      limit: Number(url.searchParams.get('limit')) || undefined,
    })
    return sendJson(res, 200, { ok: true, count: room.sim.chronicle.length, entries })
  }

  // Anything not on the documented surface: perhaps the API holds more than
  // the docs admit (hidden endpoints answer a seat token in a room that has
  // earned them) — else an honest 404.
  const KNOWN_ACTIONS = new Set(['state', 'log', 'join', 'agent-prompt', 'deploy', 'undeploy', 'oracle', 'gate-policy', 'beta-run', 'chronicle', 'vote', 'launch', 'end'])
  if (!KNOWN_ACTIONS.has(action)) {
    if (req.method === 'GET' && who) {
      const fragment = room.hiddenEndpoint(who.seat, action)
      if (fragment) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(fragment + '\n')
        return
      }
    }
    return sendJson(res, 404, { ok: false, error: 'unknown api route' })
  }

  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
  if (!who) return sendJson(res, 401, { ok: false, error: 'missing or unknown token' })

  let body: { id?: string; name?: string; source?: string; scope?: string; go?: boolean; script?: string; ticks?: number; text?: string; evidence?: unknown; relatesTo?: unknown }
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
    return
  }

  if (action === 'deploy') {
    // DIRECT deploy, either scope (FREEDOM UPDATE) — the only gate is the
    // seat's OWN policy; a policy block is a 409 with the spoken reason.
    if (typeof body.source !== 'string') return sendJson(res, 400, { ok: false, error: 'missing source' })
    const r = await room.tryDeploy(token, body.id, body.name ?? '', body.source, (body.scope ?? 'district') as ScriptScope)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error, ...(r.report ? { report: r.report } : {}) })
    sendJson(res, 200, { ok: true, id: r.id, verified: r.verified, ...(r.report ? { report: r.report } : {}) })
    return
  }

  if (action === 'undeploy') {
    if (!body.id) return sendJson(res, 400, { ok: false, error: 'missing id' })
    const r = room.command({ t: 'undeploy', player: who.seat, id: body.id })
    if (!r.ok) return sendJson(res, 409, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true })
    return
  }

  if (action === 'oracle') {
    if (!body.id) return sendJson(res, 400, { ok: false, error: 'missing id' })
    const r = await room.tryOracle(token, body.id)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true, id: body.id, report: r.report })
    return
  }

  // THE MIRROR YARD: fork + rehearse, private report, ⚡ from the balance
  if (action === 'beta-run') {
    const source = typeof body.script === 'string' ? body.script : typeof body.source === 'string' ? body.source : ''
    const r = await room.tryBetaRun(token, source, (body.scope ?? 'district') as ScriptScope, body.ticks)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true, report: r.report })
    return
  }

  // THE CHRONICLE: post a claim (either token — the dyad speaks together)
  if (action === 'chronicle') {
    const r = room.tryChronicle(token, body.text, body.evidence, body.relatesTo)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true, id: r.id })
    return
  }

  if (action === 'vote') {
    if (typeof body.go !== 'boolean') return sendJson(res, 400, { ok: false, error: 'missing go (boolean)' })
    const r = room.tryVote(token, body.go)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true })
    return
  }

  if (action === 'launch') {
    const r = room.tryLaunch(token)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true })
    return
  }

  // HOST END: call the game (anti-immortal-rooms — teardown after the grace)
  if (action === 'end') {
    const r = room.tryEnd(token)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true })
    return
  }
}

// ── Static + health (kernel-panic pattern) ───────────────────────────────────

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://local')
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  if (url.pathname === '/version') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(VERSION)
    return
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => sendJson(res, 500, { ok: false, error: String(e) }))
    return
  }
  const safe = normalize(url.pathname).replace(/^([.\\/])+/, '')
  let file = join(DIST, safe === '' ? 'index.html' : safe)
  if (!existsSync(file) || extname(file) === '') file = join(DIST, 'index.html')
  readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found (build the client: npm run build)')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(buf)
  })
}

const server = createServer(handle)

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (data) => registry.route(ws, data.toString()))
  ws.on('close', () => registry.close(ws))
  ws.on('error', () => registry.close(ws))
})

setInterval(() => {
  const now = Date.now()
  for (const room of registry.all()) room.maybeTick(now)
}, 100)

const EMPTY_TTL_MS = Number(process.env.EMPTY_TTL_MS) || 30 * 60_000
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 30_000
setInterval(() => registry.sweep(Date.now(), EMPTY_TTL_MS), SWEEP_INTERVAL_MS)

server.listen(PORT, () => {
  console.log(`aimancer server on :${PORT} (version ${VERSION}) — http + ws (/ws) + api (/api)`)
  const lore = hiddenRegistry()
  console.log(`[lore] hidden surfaces: ${lore.surfaces.length} (${lore.source})`)
  // warm the engine subprocess and pin its identity for replay headers
  void engineHost()
    .warm()
    .then((info) => console.log(info ? `[engine] ${info.engine} ${info.version} (${info.language}, protocol ${info.protocol})` : '[engine] UNAVAILABLE — scripts will not run'))
})
