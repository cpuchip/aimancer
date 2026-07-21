// AIMANCER server — ARK PIVOT. Serves the built client (dist/), /healthz and
// /version (the deploy oracle), the authoritative rooms on /ws, AND the full
// HTTP surface (the BYO-agent surface — everything a seat can do over ws
// works over HTTP):
//   GET  /api/rules                    — the complete rules, markdown, NO auth
//   GET  /api/templates                — the Starlark template library, NO auth
//   POST /api/room                     — create a settlement (creator = host, seat 0)
//   POST /api/room/:pin/join          — DROP-IN join by PIN (reconnect-by-key honored)
//   GET  /api/room/:pin/agent-prompt  — WORKER token: the ready-to-paste prompt
//   GET  /api/room/:pin/state          — redacted per token (public without one)
//   GET  /api/room/:pin/log            — command log + replay header (engine pinned)
//   POST /api/room/:pin/deploy        — either token; scope='shared' runs THE GATE
//                                        (engine dry-run — red ⇒ 409 + report)
//   POST /api/room/:pin/undeploy      — either token
//   POST /api/room/:pin/oracle        — either token: paid verify (engine dry-run)
//   POST /api/room/:pin/vote          — HINGE token ONLY (the human's voice)
//   POST /api/room/:pin/launch        — HOST HINGE only (majority must stand)
// Error shape everywhere: { ok:false, error } with 400 malformed · 401 no/bad
// token · 403 wrong surface · 404 no room · 405 method · 409 the game said no
// (including the deploy gate, which also carries `report`).
// BREAKING vs the pre-pivot API (documented in ROADMAP.md): draft/arm/disarm/
// scrap/prospect/claim-contract/start/phase/hold are GONE — the ark game has
// deploy/undeploy/oracle/vote/launch instead.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, readFile } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { mintKey, RoomRegistry, type Room } from './rooms.ts'
import { buildAgentPrompt } from './agentPrompt.ts'
import { rulesMarkdown } from '../shared/rules.ts'
import { TEMPLATES } from '../shared/templates.ts'
import { engineHost } from './engine.ts'
import type { ScriptScope } from '../shared/sim/types.ts'

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
    sendJson(res, 200, { ok: true, pin: room.code, seat: seated.seat, name: seat.name, key: seat.key, workerToken: seat.workerToken, hingeToken: seat.hingeToken, tickMs: room.tickMs })
    return
  }

  const m = url.pathname.match(/^\/api\/room\/([A-Za-z]{1,8})\/(state|log|join|agent-prompt|deploy|undeploy|oracle|vote|launch)$/)
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
    sendJson(res, 200, { ok: true, pin: room.code, seat: seated.seat, rejoined: seated.rejoined, name: seat.name, key: seat.key, workerToken: seat.workerToken, hingeToken: seat.hingeToken })
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

  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
  if (!who) return sendJson(res, 401, { ok: false, error: 'missing or unknown token' })

  let body: { id?: string; name?: string; source?: string; scope?: string; go?: boolean }
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
    return
  }

  if (action === 'deploy') {
    // district scope: your branch, lands immediately (YOLO allowed).
    // shared scope: THE DEPLOY GATE — engine dry-run must be green or 409.
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
setInterval(() => registry.sweep(Date.now(), EMPTY_TTL_MS), 30_000)

server.listen(PORT, () => {
  console.log(`aimancer server on :${PORT} (version ${VERSION}) — http + ws (/ws) + api (/api)`)
  // warm the engine subprocess and pin its identity for replay headers
  void engineHost()
    .warm()
    .then((info) => console.log(info ? `[engine] ${info.engine} ${info.version} (${info.language}, protocol ${info.protocol})` : '[engine] UNAVAILABLE — scripts will not run'))
})
