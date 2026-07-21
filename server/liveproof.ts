// LIVE PROOF driver (D3): plays ONE room end-to-end against whatever REAL
// apprentice endpoint the running server is configured with (APPRENTICE_*).
// Not part of the green bar (smoke/wstest are hermetic) — this is the
// rehearsal tool: order → real drafts → oracle verdicts → verified arms →
// widgets SOLD, with latencies printed.
//
//   1. terminal A: APPRENTICE_BASE_URL=… APPRENTICE_MODEL_CHEAP=… npm run dev:server
//   2. terminal B: npm run liveproof   (LIVEPROOF_BASE to point elsewhere)

import WebSocket from 'ws'
import type { RoomView, ServerMessage } from '../shared/protocol.ts'
import { DRAFT_COST_CHEAP, ORACLE_COST } from '../shared/sim/balance.ts'
import type { DraftTier } from '../shared/sim/types.ts'

const BASE = process.env.LIVEPROOF_BASE ?? 'http://localhost:8080'
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws'

let view: RoomView | null = null
let welcome: Extract<ServerMessage, { type: 'welcome' }> | null = null
const waiters: Array<() => void> = []
const ws = new WebSocket(WS_URL)

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage
  if (msg.type === 'welcome') welcome = msg
  if (msg.type === 'snapshot') view = msg.view
  if (msg.type === 'error') console.log(`  [server] ${msg.message}`)
  for (const w of waiters.splice(0)) w()
})

async function waitFor<T>(pred: () => T | null | undefined | false, what: string, ms = 60000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const hit = pred()
    if (hit) return hit
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise<void>((res) => {
      const t = setTimeout(res, 100)
      waiters.push(() => {
        clearTimeout(t)
        res()
      })
    })
  }
}

async function api(path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api/room/${view!.room}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json() }
}

interface DraftResult {
  latencyMs: number
  ids: string[]
}

/** Ask the apprentice over HTTP (worker token) and wait for the batch. */
async function requestDrafts(tier: DraftTier, order: string): Promise<DraftResult> {
  const before = new Set((view?.you?.hand ?? []).map((sl) => sl.script.id))
  const t0 = Date.now()
  const r = await api('draft-request', welcome!.workerToken, { tier, order })
  if (r.status !== 200) {
    console.log(`  draft-request refused (${r.status}): ${r.body.error}`)
    return { latencyMs: 0, ids: [] }
  }
  await waitFor(() => (view?.you?.pending.length ?? 1) === 0 || null, `batch ${r.body.reqId} to settle`)
  const latencyMs = Date.now() - t0
  const ids = (view?.you?.hand ?? []).map((sl) => sl.script.id).filter((id) => !before.has(id))
  return { latencyMs, ids }
}

async function main(): Promise<void> {
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res())
    ws.once('error', rej)
  })
  ws.send(JSON.stringify({ type: 'join', room: '', name: 'Liveproof', key: `lp-${Date.now()}` }))
  await waitFor(() => welcome, 'welcome')
  ws.send(JSON.stringify({ type: 'start', token: welcome!.hingeToken, tickMs: 800, round1Ticks: 3, round2Ticks: 400 }))
  await waitFor(() => view?.started || null, 'start')
  console.log(`room ${view!.room} · apprentice: ${view!.apprentice} · tick 0.8s · rounds 3/400`)
  if (view!.apprentice !== 'live') console.log('  ⚠ practice mode — set APPRENTICE_* env on the server for a real live proof')

  const latencies: number[] = []
  const flawsCaught: string[] = []
  let drafts = 0

  // round 1 (naive): one real order, drafts land, YOLO nothing — just proof of flow
  console.log('\nROUND 1 (naive): ordering a draft…')
  const r1 = await requestDrafts('cheap', 'gather matter quickly')
  latencies.push(r1.latencyMs)
  drafts += r1.ids.length
  console.log(`  ${r1.ids.length} draft(s) in ${r1.latencyMs}ms: ${r1.ids.join(', ')}`)

  await waitFor(() => view!.ticksRemaining === 0 || null, 'round-1 budget to run out')
  ws.send(JSON.stringify({ type: 'phase', token: welcome!.hingeToken, to: 'intermission' }))
  await waitFor(() => (view!.phase === 'intermission') || null, 'intermission')
  ws.send(JSON.stringify({ type: 'phase', token: welcome!.hingeToken, to: 'round2' }))
  await waitFor(() => (view!.phase === 'round2') || null, 'round2')
  console.log('\nROUND 2 (verified): the oracle is online')

  // the goal chain: green harvest + refine + sell armed → widgets ship
  const wanted: Record<string, string> = {
    harvest: 'I need a script that harvests matter fast',
    refine: 'I need a script that refines matter into widgets',
    sell: 'I need a script that sells widgets',
  }
  // the driver is a patient engineer: it waits for the rate limit to refill
  // before spending (regen is 5 per tick — the real economy)
  const waitTokens = (n: number) =>
    waitFor(() => (view!.players[view!.you!.index].tokens >= n ? true : null), `${n} tokens to regen`, 60000)

  const armed = new Set<string>()
  for (let round = 0; round < 15 && armed.size < 3; round++) {
    const missing = Object.keys(wanted).find((v) => !armed.has(v))!
    await waitTokens(DRAFT_COST_CHEAP + ORACLE_COST)
    const res = await requestDrafts('cheap', wanted[missing])
    if (res.ids.length === 0) continue
    latencies.push(res.latencyMs)
    drafts += res.ids.length
    console.log(`  order "${wanted[missing]}" → ${res.ids.length} draft(s) in ${res.latencyMs}ms`)
    for (const id of res.ids) {
      const slot = view!.you!.hand.find((sl) => sl.script.id === id)!
      await waitTokens(ORACLE_COST)
      const o = await api('oracle', welcome!.workerToken, { id })
      if (o.status !== 200) {
        console.log(`    ${id} (${slot.script.verb}): oracle refused — ${o.body.error}`)
        continue
      }
      if (o.body.report.ok) {
        console.log(`    ${id} (${slot.script.verb}): 🔮 GREEN`)
        if (slot.script.verb in wanted && !armed.has(slot.script.verb)) {
          const a = await api('arm', welcome!.hingeToken, { id })
          if (a.status === 200) {
            armed.add(slot.script.verb)
            console.log(`    ${id}: ✅ ARMED (verified)`)
          }
        } else {
          await api('scrap', welcome!.workerToken, { id }) // keep the hand lean
        }
      } else {
        flawsCaught.push(`${id} (${slot.script.verb}): ${o.body.report.reasons[0]}`)
        console.log(`    ${id} (${slot.script.verb}): 🔮 RED — ${o.body.report.reasons[0]}`)
        await api('scrap', welcome!.workerToken, { id })
      }
    }
  }

  console.log(`\narmed chain: ${[...armed].join(' → ') || '(none)'} — waiting for widgets to SHIP…`)
  const sold = await waitFor(
    () => {
      const me = view?.players[view.you?.index ?? 0]
      return me && me.widgetsSold > 0 ? me : null
    },
    'widgets sold',
    120000,
  ).catch(() => null)

  const me = view!.players[view!.you!.index]
  console.log('\n══ LIVE PROOF SUMMARY ══')
  console.log(`room ${view!.room} · apprentice ${view!.apprentice}`)
  console.log(`drafts delivered: ${drafts} · latencies ms: [${latencies.join(', ')}]`)
  console.log(`oracle caught ${flawsCaught.length} flawed draft(s):`)
  for (const f of flawsCaught) console.log(`  · ${f}`)
  console.log(`widgets sold: ${me.widgetsSold} · score: ${me.score} · waste: ${me.waste}`)
  console.log(sold && flawsCaught.length > 0 ? '\nPROOF: order → real drafts → oracle catch → verified arm → widgets SHIPPED ✔' : '\npartial: see above')
  ws.close()
  process.exit(sold ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
