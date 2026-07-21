// ENGINE INTEGRATION floor — spawns the REAL Go engine subprocess through the
// production EngineHost (server/engine.ts) and proves the whole seam:
// handshake, every shipped TEMPLATE runs clean and deterministic, KV memory
// round-trips, errors are values (compile/gas/sandbox), and the wall-clock
// TIMEOUT → KILL → RESPAWN path recovers (determinism makes respawn safe —
// the engine's own package doc asks the Node side to hold exactly this wall).
// Run: npm run enginetest.

import { EngineHost, resolveEngineBin } from './engine.ts'
import { TEMPLATES } from '../shared/templates.ts'
import { checkAction } from '../shared/sim/oracle.ts'
import type { Action } from '../shared/sim/types.ts'

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

/** A plausible seat world — the same shape Room.worldViewFor builds. */
function world(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tick: 7,
    district: 0,
    you: { tokens: 30, ore: 14, food: 9, parts: 6, integrity: 100 },
    veins: [
      { id: 1, rate: 3, reserve: 40 },
      { id: 2, rate: 5, reserve: 80 },
      { id: 3, rate: 2, reserve: 0 },
    ],
    structures: {
      wall: { parts: 10, required: 60, complete: false, hp: 50, hpMax: 300 },
      granary: { parts: 0, required: 30, complete: false, hp: 0, hpMax: 150 },
      beacon: { parts: 0, required: 40, complete: false, hp: 0, hpMax: 200 },
      ark: { parts: 0, required: 120, complete: false, hp: 0, hpMax: 600 },
    },
    granaryFood: 3,
    survivors: 0,
    storm: { inTicks: 12, severity: 20 },
    frontier: 'wall',
    dyads: [{ name: 'Solo', district: 0, parts: 6, contributed: 10 }],
    ...overrides,
  }
}

async function main(): Promise<void> {
  const bin = resolveEngineBin()
  ok(bin !== null, `engine binary resolved (${bin})`)
  if (!bin) process.exit(1)

  const host = new EngineHost(bin)
  const info = await host.warm()
  ok(info !== null, 'handshake captured')
  if (info) {
    ok(info.engine === 'aimancer-engine' && info.language === 'starlark' && info.protocol >= 1, `hello: ${info.engine} ${info.version} (${info.language}, protocol ${info.protocol})`)
  }

  // ── every shipped template runs clean, in-schema, and deterministic ────────
  for (const t of TEMPLATES) {
    const runs: string[] = []
    let memory: Record<string, unknown> = {}
    let allActions: Action[] = []
    for (const attempt of [0, 1]) {
      memory = {}
      allActions = []
      const lines: string[] = []
      for (let tickN = 0; tickN < 3; tickN++) {
        const out = await host.run({ script: t.source, world: world(), seed: 42, tick: tickN, gasLimit: 50_000, memory })
        if (out.err) {
          lines.push(`ERR:${out.err}`)
          break
        }
        memory = out.memory
        allActions.push(...out.actions)
        lines.push(JSON.stringify(out.actions) + '|' + JSON.stringify(out.logs) + '|' + out.gasUsed)
      }
      runs.push(lines.join('\n'))
      void attempt
    }
    ok(!runs[0].includes('ERR:'), `template '${t.id}' runs clean (${runs[0].includes('ERR:') ? runs[0] : `${allActions.length} actions over 3 ticks`})`)
    ok(runs[0] === runs[1], `template '${t.id}' is deterministic (byte-identical double run)`)
    ok(allActions.every((a) => checkAction(a).length === 0), `template '${t.id}' emits only in-schema actions`)
  }
  // template semantics spot checks
  {
    const miner = TEMPLATES.find((t) => t.id === 'miner')!
    const out = await host.run({ script: miner.source, world: world(), seed: 1, tick: 0, gasLimit: 50_000, memory: {} })
    const a = out.actions[0] as Action
    ok(out.actions.length === 1 && a.type === 'gather' && a['node'] === 2, 'miner targets the richest LIVE vein')
    const dry = await host.run({ script: miner.source, world: world({ veins: [{ id: 1, rate: 3, reserve: 0 }] }), seed: 1, tick: 0, gasLimit: 50_000, memory: {} })
    ok(dry.actions.length === 0 && dry.logs.some((l) => l.includes('no live veins')), 'miner idles honestly on a dead field')
    const builder = TEMPLATES.find((t) => t.id === 'builder')!
    const b = await host.run({ script: builder.source, world: world(), seed: 1, tick: 0, gasLimit: 50_000, memory: {} })
    const ba = b.actions[0] as Action
    ok(ba?.type === 'contribute' && ba['structure'] === 'wall', 'builder aims at the frontier')
    const bDone = await host.run({ script: builder.source, world: world({ frontier: null }), seed: 1, tick: 0, gasLimit: 50_000, memory: {} })
    const bda = bDone.actions[0] as Action
    ok(bda?.type === 'contribute' && bda['structure'] === 'wall', 'builder tops up the wall when everything stands')
  }

  // ── KV memory round-trip through the real subprocess ──────────────────────
  {
    const src = 'n = recall("n", 0) + 1\nremember("n", n)\nprint("n", n)\nact("farm", rate=1)\n'
    let memory: Record<string, unknown> = {}
    for (let i = 0; i < 5; i++) {
      const out = await host.run({ script: src, world: world(), seed: 9, tick: i, gasLimit: 50_000, memory })
      memory = out.memory
    }
    ok((memory as { n?: number }).n === 5, `KV memory chains across 5 ticks (n=${(memory as { n?: number }).n})`)
  }

  // ── errors are values ──────────────────────────────────────────────────────
  {
    const bad = await host.run({ script: 'this is not starlark', world: world(), seed: 1, tick: 0, gasLimit: 50_000, memory: {} })
    ok((bad.err ?? '').includes('compile'), 'syntax error → compile error value')
    const gas = await host.run({ script: 'x = 0\nwhile True:\n    x += 1\n', world: world(), seed: 1, tick: 0, gasLimit: 2_000, memory: {} })
    ok((gas.err ?? '').startsWith('gas:'), 'infinite loop → exact gas halt')
    ok(gas.gasUsed === 2_000, `gasUsed == gasLimit on overrun (${gas.gasUsed})`)
    const sandbox = await host.run({ script: 'load("json.star", "json")', world: world(), seed: 1, tick: 0, gasLimit: 50_000, memory: {} })
    ok(sandbox.err !== undefined && sandbox.err !== '', 'load() refused — the sandbox holds')
  }

  // ── the TIMEOUT → KILL → RESPAWN path (seat fault, then recovery) ─────────
  {
    let timedOut = false
    try {
      // the engine package doc's own hostile case: big-int arithmetic burns
      // wall-clock CPU inside single ops without burning gas — the exact hole
      // this Node-side wall exists to cover. memLimitBytes is widened so the
      // engine's OWN allocation watchdog can't win the race and answer with a
      // fast error value — this test pins the WALL-CLOCK path specifically
      // (the watchdog path is the engine repo's to test).
      const hostile = 'x = 10\nfor i in range(26):\n    x = x * x\nact("farm", rate=1)\n'
      await host.run({ script: hostile, world: world(), seed: 1, tick: 0, gasLimit: 50_000, memory: {}, memLimitBytes: 4 * 1024 * 1024 * 1024 }, 250)
    } catch (e) {
      timedOut = e instanceof Error && e.message.includes('timeout')
    }
    ok(timedOut, 'wall-clock timeout rejects (SEAT FAULT — nothing logged, replay untouched)')
    // the host respawns a fresh subprocess and serves again — determinism
    // makes this safe by construction
    const back = await host.run({ script: 'act("farm", rate=2)\n', world: world(), seed: 1, tick: 0, gasLimit: 50_000, memory: {} })
    ok(!back.err && back.actions.length === 1, 'RESPAWN: the next run lands on a fresh subprocess')
  }

  host.shutdown()
  console.log(failed === 0 ? `ENGINETEST OK — ${passed} assertions` : `ENGINETEST FAILED — ${failed} failures (${passed} passed)`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
