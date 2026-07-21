// LIVE PROBE — runs against a REAL deployed server (default the production
// site) and proves the ark loop end to end over plain HTTP: create a
// settlement, deploy a template script, watch the engine actually run it for
// a tick, and leave. The post-deploy verification oracle.
//
//   npx tsx server/liveproof.ts                       # against production
//   npx tsx server/liveproof.ts http://localhost:8080 # against local
//
// Exit 0 = the live site creates rooms, gates deploys, runs REAL Starlark.

import { TEMPLATES } from '../shared/templates.ts'
import type { RoomView } from '../shared/protocol.ts'

const BASE = (process.argv[2] ?? 'https://aimancer.cpuchip.net').replace(/\/+$/, '')

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

async function api(path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.body !== undefined ? 'POST' : 'GET',
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function main(): Promise<void> {
  console.log(`LIVE PROBE against ${BASE}`)
  ok((await (await fetch(`${BASE}/healthz`)).text()) === 'ok', '/healthz')
  console.log(`  /version = ${await (await fetch(`${BASE}/version`)).text()}`)

  const rules = await (await fetch(`${BASE}/api/rules`)).text()
  ok(rules.includes('deploy gate'), '/api/rules serves the ark game')

  // create a fast probe room (1s ticks) and deploy the miner template
  const created = await api('/api/room', { body: { name: 'liveproof', tickMs: 1000 } })
  ok(created.status === 200, 'room created over HTTP')
  const pin = created.json['pin'] as string
  const worker = created.json['workerToken'] as string
  const hinge = created.json['hingeToken'] as string
  console.log(`  probe settlement ${pin}`)

  const miner = TEMPLATES.find((t) => t.id === 'miner')!
  const dep = await api(`/api/room/${pin}/deploy`, { token: worker, body: { id: 'probe', scope: 'district', source: miner.source } })
  ok(dep.status === 200, 'template deployed over HTTP')

  // THE GATE, live: a red shared deploy must 409
  const gate = await api(`/api/room/${pin}/deploy`, { token: worker, body: { id: 'red', scope: 'shared', source: 'act("blastoff")' } })
  ok(gate.status === 409, 'deploy gate live: red shared deploy → 409')

  // the vote hinge split, live
  ok((await api(`/api/room/${pin}/vote`, { token: worker, body: { go: true } })).status === 403, 'vote with worker token → 403 (hinge is structural, live)')
  ok((await api(`/api/room/${pin}/vote`, { token: hinge, body: { go: true } })).status === 409, 'hinge vote reaches the sim (ark not built)')

  // watch the ENGINE actually run the script
  let mined: RoomView | null = null
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 700))
    const st = await api(`/api/room/${pin}/state`, { token: worker })
    const view = st.json['view'] as RoomView
    if (view && view.dyads[0] && view.dyads[0].ore > 0) {
      mined = view
      break
    }
  }
  ok(mined !== null, 'ENGINE LIVE: the deployed script gathered real ore on the deployed site')
  if (mined) {
    const sc = mined.you!.scripts[0]
    console.log(`  tick ${mined.tick}: ore=${mined.dyads[0].ore} lastTick="${sc.lastTick?.note}" gas=${sc.lastTick?.gasUsed} engine=${mined.engine?.version}`)
    ok(mined.engine !== null, 'engine identity pinned in the live view')
  }

  console.log(failed === 0 ? `LIVEPROOF OK — ${passed} assertions` : `LIVEPROOF FAILED — ${failed} failures (${passed} passed)`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
