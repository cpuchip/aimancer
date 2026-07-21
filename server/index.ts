// AIMANCER server — serves the built client (dist/) plus /healthz and /version
// (the deploy oracle), hosts the authoritative rooms on a same-origin
// WebSocket at /ws, AND exposes the FULL HTTP surface (the BYO-agent surface —
// everything a seat can do over ws works over HTTP, room lifecycle included):
//   GET  /api/rules                    — the complete rules, markdown, NO auth
//   POST /api/room                     — create a room (creator = host, seat 0)
//   POST /api/room/:pin/join          — join by PIN (reconnect-by-key honored)
//   GET  /api/room/:pin/agent-prompt  — WORKER token: the ready-to-paste prompt
//   POST /api/room/:pin/start         — HOST hinge: start the game
//   POST /api/room/:pin/phase         — HOST hinge: advance the weave
//   POST /api/room/:pin/hold          — HOST hinge: suspend a pending auto-advance
//   GET  /api/room/:pin/state          — redacted per token (public without one)
//   GET  /api/room/:pin/log            — command log + seed, redacted per token
//   POST /api/room/:pin/draft         — WORKER token: submit a script directly
//   POST /api/room/:pin/draft-request — either token: ask the apprentice (async)
//   POST /api/room/:pin/oracle        — either token: paid verify + dry-run report
//   POST /api/room/:pin/arm           — HINGE token ONLY (the hinge, always)
//   POST /api/room/:pin/disarm        — HINGE token (script-lifecycle control, D4)
//   POST /api/room/:pin/scrap         — either token (freeing a slot is safe)
//   POST /api/room/:pin/prospect      — either token: paid vein preview (own-seat)
//   POST /api/room/:pin/claim-contract — HINGE token (strategy is the human's)
// ASYMMETRY (CORE IDENTITY #2): GET state over HTTP is the agent's NARROW view
// — current effective prices only; the rush banner/forecast ride ONLY on the
// ws snapshots (board + phones). The human holds the map.
// Error shape everywhere: { ok: false, error } with 401 (no/unknown token),
// 403 (wrong surface), 404 (no room), 405 (method), 409 (sim rule refused —
// the spoken reason), 400 (malformed body).
// Static/healthz/version adapted from kernel-panic server/index.ts.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, readFile } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { mintKey, RoomRegistry, type Room } from './rooms.ts'
import { buildAgentPrompt } from './agentPrompt.ts'
import { rulesMarkdown } from '../shared/rules.ts'
import { oracle } from '../shared/sim/oracle.ts'
import type { DraftTier, Script, SimPhase } from '../shared/sim/types.ts'

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

/** The base URL the OUTSIDE world uses to reach us — for the paste-prompt.
 * Behind the house proxy the forwarded headers carry the public name. */
function externalBase(req: IncomingMessage): string {
  const first = (v: unknown): string => String(v ?? '').split(',')[0].trim()
  const proto = first(req.headers['x-forwarded-proto']) || 'http'
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host) || `localhost:${PORT}`
  return `${proto}://${host}`
}

// Pure and constant per process — compute once, serve forever.
const RULES_MD = rulesMarkdown()

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // GET /api/rules — the complete game reference (generated from balance.ts —
  // the wiki's twin). PUBLIC by design: rules carry no room or token material.
  if (url.pathname === '/api/rules') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(RULES_MD)
    return
  }

  // POST /api/room — create a room over HTTP (D4). The creator is seated as
  // host (seat 0) and gets BOTH tokens; optional body presets the room knobs
  // (dev-fast rooms stay possible from curl alone).
  if (url.pathname === '/api/room') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    let body: { name?: string; tickMs?: number; round1Ticks?: number; round2Ticks?: number; autoAdvance?: boolean }
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
    }
    const room = registry.create()
    room.configure({ tickMs: body.tickMs, round1Ticks: body.round1Ticks, round2Ticks: body.round2Ticks, autoAdvance: body.autoAdvance })
    const seated = room.seatJoin(typeof body.name === 'string' ? body.name : '', mintKey())
    if (!seated.ok) return sendJson(res, seated.code, { ok: false, error: seated.error }) // unreachable on a fresh room; belt+braces
    const seat = room.seats[seated.seat]
    room.touch()
    sendJson(res, 200, { ok: true, pin: room.code, seat: seated.seat, name: seat.name, key: seat.key, workerToken: seat.workerToken, hingeToken: seat.hingeToken })
    return
  }

  // /api/room/:pin/:action
  const m = url.pathname.match(/^\/api\/room\/([A-Za-z]{1,8})\/(state|draft|draft-request|oracle|arm|disarm|scrap|prospect|claim-contract|log|join|start|phase|hold|agent-prompt)$/)
  if (!m) {
    sendJson(res, 404, { ok: false, error: 'unknown api route' })
    return
  }
  const room: Room | undefined = registry.get(m[1])
  if (!room) {
    sendJson(res, 404, { ok: false, error: `no room '${m[1].toUpperCase()}'` })
    return
  }
  room.touch() // HTTP sign-of-life: agent-played rooms have no sockets to keep them alive
  const action = m[2]
  const token = bearerToken(req, url)
  const who = room.auth(token)
  // "agent connected": any worker-token call on the HTTP surface marks the
  // seat's agent live — EXCEPT agent-prompt, which is the PHONE fetching the
  // copy text (it would false-positive every seat on join).
  if (who && who.role === 'worker' && action !== 'agent-prompt') room.noteWorkerSeen(who.seat)

  if (action === 'join') {
    // join by PIN. Reconnect-by-key returns the SAME seat + tokens (agents
    // resume cleanly); no key in the body mints one and returns it.
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
    room.broadcastLobby() // phones in the lobby see the agent arrive
    sendJson(res, 200, { ok: true, pin: room.code, seat: seated.seat, rejoined: seated.rejoined, name: seat.name, key: seat.key, workerToken: seat.workerToken, hingeToken: seat.hingeToken })
    return
  }

  if (action === 'agent-prompt') {
    // the ready-to-paste "connect your agent" text — the phone renders + copies
    // it. WORKER token only: the text embeds that very token, and the hinge
    // stays on the phone (401 unknown, 403 hinge — the wrong surface to ask).
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
    // redacted per token: a seat token sees its own hand; no token = public
    // view. rich=false ALWAYS on HTTP: this is the agent's NARROW surface —
    // current prices only, never the rush banner/forecast (the board has it;
    // your human relays it — that's the game).
    sendJson(res, 200, { ok: true, view: room.viewFor(who ? who.seat : null, false) })
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

  let body: { script?: Script; tier?: DraftTier; id?: string; order?: string; tickMs?: number; round1Ticks?: number; round2Ticks?: number; autoAdvance?: boolean; to?: string }
  try {
    body = JSON.parse((await readBody(req)) || '{}')
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
    return
  }
  // sim rule refused (wrong phase, no tokens, no such script…) → 409 + the
  // spoken reason; the request was well-formed, the GAME said no.
  const refused = (r: { ok: false; error: string }) => sendJson(res, 409, { ok: false, error: r.error })

  if (action === 'start') {
    // starting is a HOST act on the HUMAN surface — tryStart carries the same
    // rules ws enforces and hands back the status for the refusal.
    const r = room.tryStart(token, body.tickMs, body.round1Ticks, body.round2Ticks, body.autoAdvance)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true, pin: room.code, tickMs: room.tickMs })
    return
  }

  if (action === 'hold') {
    // suspend a pending auto-advance — the same host-hinge act as phase (ws mirror)
    const r = room.tryHold(token)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true })
    return
  }

  if (action === 'phase') {
    // advancing the weave — same host-hinge act as start.
    if (typeof body.to !== 'string') return sendJson(res, 400, { ok: false, error: 'missing to' })
    const r = room.tryPhase(token, body.to as SimPhase)
    if (!r.ok) return sendJson(res, r.code, { ok: false, error: r.error })
    sendJson(res, 200, { ok: true, phase: body.to })
    return
  }

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
    // D4 tightening (the D3 flag, ruled): disarm is script-LIFECYCLE control,
    // so it lives with arm on the human surface — matches ws.
    if (who.role !== 'hinge') {
      return sendJson(res, 403, { ok: false, error: 'Disarm is script-lifecycle control — use the hinge token.' })
    }
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

  if (action === 'prospect') {
    // the paid vein preview — either surface (matches ws); the reveal lands in
    // you.prospects on the next /state read
    const r = room.command({ t: 'prospect', player: who.seat })
    if (!r.ok) return refused(r)
    sendJson(res, 200, { ok: true })
    return
  }

  if (action === 'claim-contract') {
    // strategy is the HUMAN's: claiming is a hinge act, like arm (matches ws)
    if (who.role !== 'hinge') {
      return sendJson(res, 403, { ok: false, error: "Claiming a contract is the human's call — use the hinge token." })
    }
    if (typeof body.id !== 'number' && typeof body.id !== 'string') return sendJson(res, 400, { ok: false, error: 'missing id' })
    const r = room.command({ t: 'claimContract', player: who.seat, id: Number(body.id) })
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
