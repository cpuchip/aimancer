// AIMANCER server — serves the built client (dist/) plus /healthz and /version
// (the deploy oracle), hosts the authoritative rooms on a same-origin
// WebSocket at /ws, AND exposes the FULL HTTP action mirror (the BYO-agent
// surface — everything a seat can do over ws works over HTTP; D4 adds the
// join prompt + MCP on top):
//   GET  /api/room/:pin/state          — redacted per token (public without one)
//   GET  /api/room/:pin/log            — command log + seed, redacted per token
//   POST /api/room/:pin/draft         — WORKER token: submit a script directly
//   POST /api/room/:pin/draft-request — either token: ask the apprentice (async)
//   POST /api/room/:pin/oracle        — either token: paid verify + dry-run report
//   POST /api/room/:pin/arm           — HINGE token ONLY (the hinge, always)
//   POST /api/room/:pin/disarm        — either token (turning OFF is always safe)
//   POST /api/room/:pin/scrap         — either token (freeing a slot is safe)
// Error shape everywhere: { ok: false, error } with 401 (no/unknown token),
// 403 (wrong surface), 404 (no room), 405 (method), 409 (sim rule refused —
// the spoken reason), 400 (malformed body).
// Static/healthz/version adapted from kernel-panic server/index.ts.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, readFile } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { RoomRegistry, type Room } from './rooms.ts'
import { oracle } from '../shared/sim/oracle.ts'
import type { DraftTier, Script } from '../shared/sim/types.ts'

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

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // /api/room/:pin/:action
  const m = url.pathname.match(/^\/api\/room\/([A-Za-z]{1,8})\/(state|draft|draft-request|oracle|arm|disarm|scrap|log)$/)
  if (!m) {
    sendJson(res, 404, { ok: false, error: 'unknown api route' })
    return
  }
  const room: Room | undefined = registry.get(m[1])
  if (!room) {
    sendJson(res, 404, { ok: false, error: `no room '${m[1].toUpperCase()}'` })
    return
  }
  const action = m[2]
  const token = bearerToken(req, url)
  const who = room.auth(token)

  if (action === 'state') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    // redacted per token: a seat token sees its own hand; no token = public view
    sendJson(res, 200, { ok: true, view: room.viewFor(who ? who.seat : null) })
    return
  }

  if (action === 'log') {
    // the command log + seed (replay theater's feed) — per-token redaction
    // lives in Room.logView (other seats' draft bodies stripped; host token
    // gets the full log after the reveal only)
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    sendJson(res, 200, { ok: true, ...room.logView(token) })
    return
  }

  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
  if (!who) return sendJson(res, 401, { ok: false, error: 'missing or unknown token' })

  let body: { script?: Script; tier?: DraftTier; id?: string; order?: string }
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
    return
  }
  // sim rule refused (wrong phase, no tokens, no such script…) → 409 + the
  // spoken reason; the request was well-formed, the GAME said no.
  const refused = (r: { ok: false; error: string }) => sendJson(res, 409, { ok: false, error: r.error })

  if (action === 'draft') {
    if (who.role !== 'worker') {
      return sendJson(res, 403, { ok: false, error: 'drafts come from the worker surface — use the worker token' })
    }
    if (!body.script) return sendJson(res, 400, { ok: false, error: 'missing script' })
    const r = room.command({ t: 'draftAccepted', player: who.seat, script: body.script, tier: body.tier === 'smart' ? 'smart' : 'cheap' })
    if (!r.ok) return refused(r)
    sendJson(res, 200, { ok: true, id: body.script.id })
    return
  }

  if (action === 'draft-request') {
    // asking the apprentice is safe from either surface; the debit lands NOW,
    // drafts arrive async — poll state (you.pending / you.hand)
    const tier: DraftTier = body.tier === 'smart' ? 'smart' : 'cheap'
    const r = room.requestDrafts(who.seat, tier, typeof body.order === 'string' ? body.order : undefined)
    if (!r.ok) return refused(r)
    sendJson(res, 200, { ok: true, reqId: r.reqId, tier })
    return
  }

  if (action === 'oracle') {
    // verification is safe from either surface (paid; round-2 only — the sim
    // refuses round-1 checks and the refusal comes back as a 409)
    if (!body.id) return sendJson(res, 400, { ok: false, error: 'missing id' })
    const r = room.command({ t: 'oracleCheck', player: who.seat, id: body.id })
    if (!r.ok) return refused(r)
    const slot = room.sim!.players[who.seat].scripts.find((sl) => sl.script.id === body.id)
    sendJson(res, 200, { ok: true, id: body.id, report: slot ? oracle(room.sim!, who.seat, slot.script) : null })
    return
  }

  if (action === 'arm') {
    // THE HINGE, enforced at the HTTP surface too: no worker path to arm.
    if (who.role !== 'hinge') {
      return sendJson(res, 403, { ok: false, error: 'ARM requires the hinge token — only the human seat can arm a script' })
    }
    if (!body.id) return sendJson(res, 400, { ok: false, error: 'missing id' })
    const r = room.command({ t: 'arm', player: who.seat, id: body.id })
    if (!r.ok) return refused(r)
    sendJson(res, 200, { ok: true })
    return
  }

  if (action === 'disarm') {
    // turning OFF is always safe — either surface may pull the plug (matches ws)
    if (!body.id) return sendJson(res, 400, { ok: false, error: 'missing id' })
    const r = room.command({ t: 'disarm', player: who.seat, id: body.id })
    if (!r.ok) return refused(r)
    sendJson(res, 200, { ok: true })
    return
  }

  if (action === 'scrap') {
    // freeing a hand slot is safe from either surface (matches ws)
    if (!body.id) return sendJson(res, 400, { ok: false, error: 'missing id' })
    const r = room.command({ t: 'scrap', player: who.seat, id: body.id })
    if (!r.ok) return refused(r)
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

// ── Rooms over a same-origin /ws WebSocket ───────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (data) => registry.route(ws, data.toString()))
  ws.on('close', () => registry.close(ws))
  ws.on('error', () => registry.close(ws))
})

// Each room ticks on its OWN cadence (tickMs is a room setting — ~25s at show
// time, 2s in dev); this loop just checks who's due.
setInterval(() => {
  const now = Date.now()
  for (const room of registry.all()) room.maybeTick(now)
}, 100)

const EMPTY_TTL_MS = Number(process.env.EMPTY_TTL_MS) || 30 * 60_000 // drop abandoned rooms after 30m
setInterval(() => registry.sweep(Date.now(), EMPTY_TTL_MS), 30_000)

server.listen(PORT, () => {
  console.log(`aimancer server on :${PORT} (version ${VERSION}) — http + ws (/ws) + api (/api)`)
})
