// AIMANCER oracle floor — deterministic assertions over the sim.
// Run: npm run smoke. Green before every commit (the house discipline).
// Harness pattern adapted from kernel-panic shared/sim/smoke.ts.
//
// The key contracts: replay identity (seed + command log → identical state
// hash), every DSL verb, every flaw class CAUGHT by the oracle, the seeded
// gremlin/market schedules, token regen/spend, auto-disarm on red (the oracle
// is the switch), scoring — and the inverse hypothesis: a YOLO'd hallucinated
// script MUST die publicly; a test that can't fail proves nothing.

import { mulberry32 } from '../rng.ts'
import {
  BOOST_BLOWUP_WASTE,
  DEAD_SCRIPT_WASTE,
  DRAFT_COST_CHEAP,
  DRAFT_COST_SMART,
  MARKET_MAX,
  MARKET_MIN,
  MAX_SCRIPTS,
  ORACLE_COST,
  REFINE_RATIO,
  SCORE_PER_UPTIME,
  SCORE_PER_WIDGET,
  SCORE_WASTE_MULT,
  TOKEN_CAP,
  TOKEN_REGEN,
  TOKEN_START,
} from './balance.ts'
import { FLAW_CLASSES, flawScript, sampleScript } from './flaws.ts'
import { oracle, staticCheck } from './oracle.ts'
import { apply, newGame, RuleError, score, snap, stateHash, tick, validateShape } from './sim.ts'
import { pressureAt, stepMarket } from './world.ts'
import { VERBS, type Command, type Script, type SimEvent, type SimState } from './types.ts'

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
function throws(fn: () => void, name: string): void {
  try {
    fn()
    failed++
    console.error(`FAIL  ${name} (did not throw)`)
  } catch (e) {
    if (e instanceof RuleError) {
      passed++
      console.log(`  ok  ${name}`)
    } else {
      failed++
      console.error(`FAIL  ${name} (wrong error: ${e})`)
    }
  }
}

/** Run a game from a command log: entries are either ticks or commands.
 * Mirrors the server: a RuleError'd command is rejected and skipped (rejection
 * is itself deterministic, so replay identity still holds). Collects every
 * event emitted along the way. */
function play(seed: number, log: Array<Command | 'tick'>, players = 1): { s: SimState; events: SimEvent[] } {
  const s = newGame(seed, players)
  const events: SimEvent[] = []
  for (const entry of log) {
    if (entry === 'tick') tick(s)
    else {
      try {
        apply(s, entry)
      } catch (e) {
        if (!(e instanceof RuleError)) throw e
      }
    }
    events.push(...s.events)
    s.events = [] // drained — so command events aren't double-counted
  }
  return { s, events }
}

const H = (rate = 1): Script => ({ id: 'h1', verb: 'harvest', params: { rate } })

// ── 1. Replay identity: seed + command log → identical state hash ────────────
console.log('replay identity')
{
  const log: Array<Command | 'tick'> = [
    { t: 'draftAccepted', script: H(2), tier: 'cheap' },
    { t: 'oracleCheck', id: 'h1' },
    { t: 'arm', id: 'h1' },
    'tick', 'tick', 'tick',
    { t: 'draftAccepted', script: { id: 'r1', verb: 'refine', params: { rate: 1 } }, tier: 'smart' },
    { t: 'arm', id: 'r1' }, // YOLO
    ...Array(20).fill('tick') as 'tick'[],
    { t: 'draftAccepted', script: { id: 'bad', verb: 'harvst', params: { rate: 2 } }, tier: 'cheap' },
    { t: 'arm', id: 'bad' }, // YOLO a hallucination
    ...Array(20).fill('tick') as 'tick'[],
    { t: 'disarm', id: 'h1' },
    ...Array(10).fill('tick') as 'tick'[],
  ]
  const a = play(77, log)
  const b = play(77, log)
  ok(snap(a.s) === snap(b.s), 'identical seed+commands → identical state')
  ok(stateHash(a.s) === stateHash(b.s), `replay hash proof: ${stateHash(a.s)} == ${stateHash(b.s)}`)
  const c = play(78, log)
  ok(stateHash(c.s) !== stateHash(a.s), `different seed → different hash (${stateHash(c.s)})`)
}

// ── 2. Token economy: regen, cap, draft/oracle costs ─────────────────────────
console.log('token economy')
{
  const s = newGame(5)
  ok(s.players[0].tokens === TOKEN_START, `workshop opens with ${TOKEN_START} tokens`)
  tick(s)
  ok(s.players[0].tokens === TOKEN_START + TOKEN_REGEN, 'tokens regen per tick like a rate limit')
  for (let i = 0; i < 20; i++) tick(s)
  ok(s.players[0].tokens === TOKEN_CAP, `regen caps at ${TOKEN_CAP}`)
  apply(s, { t: 'draftAccepted', script: H(), tier: 'cheap' })
  ok(s.players[0].tokens === TOKEN_CAP - DRAFT_COST_CHEAP, `a cheap draft costs ${DRAFT_COST_CHEAP}`)
  apply(s, { t: 'draftAccepted', script: { id: 'h2', verb: 'harvest', params: { rate: 2 } }, tier: 'smart' })
  ok(s.players[0].tokens === TOKEN_CAP - DRAFT_COST_CHEAP - DRAFT_COST_SMART, `a smart draft costs ${DRAFT_COST_SMART}`)
  const before = s.players[0].tokens
  apply(s, { t: 'oracleCheck', id: 'h1' })
  ok(s.players[0].tokens === before - ORACLE_COST, `an oracle check costs ${ORACLE_COST}`)

  const poor = newGame(5)
  poor.players[0].tokens = 2
  throws(() => apply(poor, { t: 'draftAccepted', script: H(), tier: 'cheap' }), 'cannot draft without tokens')
  poor.players[0].tokens = 3
  apply(poor, { t: 'draftAccepted', script: H(), tier: 'cheap' })
  throws(() => apply(poor, { t: 'oracleCheck', id: 'h1' }), 'cannot oracle without tokens')

  const full = newGame(5)
  full.players[0].tokens = TOKEN_CAP
  for (let i = 0; i < MAX_SCRIPTS; i++) {
    apply(full, { t: 'draftAccepted', script: { id: `s${i}`, verb: 'harvest', params: { rate: 1 } }, tier: 'cheap' })
  }
  throws(() => apply(full, { t: 'draftAccepted', script: { id: 'one-more', verb: 'harvest', params: { rate: 1 } }, tier: 'cheap' }), `hand caps at ${MAX_SCRIPTS} scripts`)
  throws(() => apply(full, { t: 'draftAccepted', script: { id: 's0', verb: 'sell', params: { amount: 1 } }, tier: 'cheap' }), 'duplicate script id rejected')
}

// ── 3. Structural gate vs the oracle's job ───────────────────────────────────
console.log('structural gate')
{
  const s = newGame(1)
  // hallucinated-but-JSON-shaped drafts ARE accepted (the oracle catches them later)
  apply(s, { t: 'draftAccepted', script: { id: 'x1', verb: 'harvst', params: { rate: 1 } }, tier: 'cheap' })
  apply(s, { t: 'draftAccepted', script: { id: 'x2', verb: 'harvest', params: { rte: 1 } }, tier: 'cheap' })
  ok(s.players[0].scripts.length === 2, 'hallucinated drafts enter the hand (comedy admitted)')
  // structurally hostile input is rejected at the boundary
  throws(() => apply(s, { t: 'draftAccepted', script: { id: 'x3', verb: 'harvest', params: { rate: 'lots' } } as unknown as Script, tier: 'cheap' }), 'non-number param rejected')
  throws(() => apply(s, { t: 'draftAccepted', script: { id: '', verb: 'harvest', params: {} }, tier: 'cheap' }), 'empty id rejected')
  throws(() => apply(s, { t: 'draftAccepted', script: { id: 'x4', verb: 'harvest', params: { rate: 1 }, when: { field: 'tick', op: '>', value: NaN } }, tier: 'cheap' }), 'NaN condition value rejected')
}

// ── 4. Every DSL verb does its job ───────────────────────────────────────────
console.log('verbs')
{
  // harvest
  const s = newGame(9)
  apply(s, { t: 'draftAccepted', script: H(3), tier: 'cheap' })
  apply(s, { t: 'oracleCheck', id: 'h1' })
  apply(s, { t: 'arm', id: 'h1' })
  tick(s)
  ok(s.players[0].matter === 3, 'harvest gains matter at its rate')

  // refine (ratio) — seed the matter directly
  const s2 = newGame(9)
  s2.players[0].matter = 10
  apply(s2, { t: 'draftAccepted', script: { id: 'r1', verb: 'refine', params: { rate: 2 } }, tier: 'cheap' })
  apply(s2, { t: 'oracleCheck', id: 'r1' })
  apply(s2, { t: 'arm', id: 'r1' })
  tick(s2)
  ok(s2.players[0].widgets === 2 && s2.players[0].matter === 10 - 2 * REFINE_RATIO, `refine converts ${REFINE_RATIO} matter per widget`)
  ok(s2.players[0].widgetsShipped === 2, 'refined widgets count as shipped')

  // sell (at the market rate)
  const s3b = newGame(9)
  s3b.players[0].widgets = 4
  apply(s3b, { t: 'draftAccepted', script: { id: 'sl', verb: 'sell', params: { amount: 3 } }, tier: 'cheap' })
  apply(s3b, { t: 'oracleCheck', id: 'sl' })
  apply(s3b, { t: 'arm', id: 'sl' })
  const tokensBefore = s3b.players[0].tokens
  const marketBefore = s3b.market
  tick(s3b)
  const expected = Math.min(TOKEN_CAP, tokensBefore + TOKEN_REGEN + 3 * s3b.market)
  ok(s3b.players[0].widgets === 1, 'sell moves widgets out of inventory')
  ok(s3b.players[0].tokens === expected, `sell pays amount × market rate (rate ${marketBefore}→${s3b.market})`)

  // patch + boost are proven in sections 6 and 7
}

// ── 5. Market schedule: seeded drift within bounds ───────────────────────────
console.log('market schedule')
{
  const path: number[] = []
  const s = newGame(42)
  for (let i = 0; i < 100; i++) {
    tick(s)
    path.push(s.market)
  }
  ok(path.every((m) => m >= MARKET_MIN && m <= MARKET_MAX), `market stays within [${MARKET_MIN}..${MARKET_MAX}]`)
  ok(new Set(path).size > 1, 'market actually drifts over time')
  // pure-function determinism, replayed independently of a SimState
  let m = newGame(42).market
  const path2: number[] = []
  for (let t = 1; t <= 100; t++) {
    m = stepMarket(m, 42, t)
    path2.push(m)
  }
  ok(JSON.stringify(path) === JSON.stringify(path2), 'market path is a pure function of seed+tick')
}

// ── 6. Gremlin: pressure ramps, spikes land, patch shields ───────────────────
console.log('gremlin')
{
  ok(pressureAt(0) === 0 && pressureAt(8) === 1 && pressureAt(80) === 10 && pressureAt(800) === 10, 'pressure ramps on schedule and caps')

  // same seed, two games: one patched, one not — the unpatched one suffers more
  function runShop(patched: boolean): number {
    const s = newGame(1234)
    apply(s, { t: 'draftAccepted', script: H(1), tier: 'cheap' })
    apply(s, { t: 'oracleCheck', id: 'h1' })
    apply(s, { t: 'arm', id: 'h1' })
    if (patched) {
      apply(s, { t: 'draftAccepted', script: { id: 'p1', verb: 'patch', params: { strength: 6 } }, tier: 'cheap' })
      apply(s, { t: 'oracleCheck', id: 'p1' })
      apply(s, { t: 'arm', id: 'p1' })
    }
    for (let i = 0; i < 40; i++) tick(s)
    return s.players[0].waste
  }
  const unpatched = runShop(false)
  const patchedWaste = runShop(true)
  ok(unpatched > 0, `the gremlin bites an unpatched workshop (waste ${unpatched})`)
  ok(patchedWaste < unpatched, `patch shields (waste ${patchedWaste} < ${unpatched})`)

  // a YOLO-armed (unverified) script draws heavier spike damage than a verified
  // one. Deterministic seed search: find a world whose first 31 ticks contain a
  // spike (31 keeps pressure < 4, so the verified twin can't be corrupted).
  function runYolo(seed: number, verified: boolean): number {
    const s = newGame(seed)
    apply(s, { t: 'draftAccepted', script: H(1), tier: 'cheap' })
    if (verified) apply(s, { t: 'oracleCheck', id: 'h1' })
    apply(s, { t: 'arm', id: 'h1' })
    for (let i = 0; i < 31; i++) tick(s)
    return s.players[0].waste
  }
  let spikeSeed = 0
  for (let seed = 1; seed <= 200 && spikeSeed === 0; seed++) {
    if (runYolo(seed, false) > 0) spikeSeed = seed
  }
  ok(spikeSeed > 0, `found a world with an early spike (seed ${spikeSeed})`)
  const yoloWaste = runYolo(spikeSeed, false)
  const verifiedWaste = runYolo(spikeSeed, true)
  ok(yoloWaste > verifiedWaste, `the gremlin exploits unverified scripts hardest (${yoloWaste} > ${verifiedWaste})`)
}

// ── 7. Boost: multiplies output, small blowup risk ───────────────────────────
console.log('boost')
{
  // find a seed whose first tick doesn't blow the boost — then output is ×mult
  let proven = false
  for (let seed = 1; seed < 60 && !proven; seed++) {
    const s = newGame(seed)
    apply(s, { t: 'draftAccepted', script: H(2), tier: 'cheap' })
    apply(s, { t: 'oracleCheck', id: 'h1' })
    apply(s, { t: 'arm', id: 'h1' })
    apply(s, { t: 'draftAccepted', script: { id: 'b1', verb: 'boost', params: { mult: 3 } }, tier: 'cheap' })
    apply(s, { t: 'oracleCheck', id: 'b1' })
    apply(s, { t: 'arm', id: 'b1' })
    tick(s)
    if (!s.events.some((e) => e.t === 'blowup')) {
      ok(s.players[0].matter === 6, `boost multiplies harvest output (rate 2 × mult 3 = 6, seed ${seed})`)
      proven = true
    }
  }
  ok(proven, 'found a non-blowup first tick to prove the multiplier')

  // run long enough and the risk WILL land: blowup event, waste, blown status
  let blew = false
  outer: for (let seed = 1; seed < 20; seed++) {
    const s = newGame(seed)
    apply(s, { t: 'draftAccepted', script: { id: 'b1', verb: 'boost', params: { mult: 4 } }, tier: 'cheap' })
    apply(s, { t: 'oracleCheck', id: 'b1' })
    apply(s, { t: 'arm', id: 'b1' })
    for (let i = 0; i < 200; i++) {
      const wasteBefore = s.players[0].waste
      tick(s)
      if (s.events.some((e) => e.t === 'blowup')) {
        const slot = s.players[0].scripts[0]
        ok(slot.status === 'blown' && !slot.armed, 'a blown boost is dead in the water')
        ok(s.players[0].waste >= wasteBefore + BOOST_BLOWUP_WASTE, 'blowup counts as waste')
        throws(() => apply(s, { t: 'arm', id: 'b1' }), 'a blown script cannot be re-armed')
        blew = true
        break outer
      }
    }
  }
  ok(blew, 'boost risk eventually lands (seeded, deterministic)')
}

// ── 8. THE ORACLE: every flaw class caught, on every verb ────────────────────
console.log('oracle catches every flaw class')
{
  for (const verb of VERBS) {
    const base = sampleScript(verb, 'base')
    ok(staticCheck(base).ok, `${verb}: the valid sample is green`)
  }
  for (const cls of FLAW_CLASSES) {
    for (const verb of VERBS) {
      let caught = 0
      let representable = 0
      const N = 10
      for (let i = 0; i < N; i++) {
        const prng = mulberry32(i * 7919 + 17)
        const base = sampleScript(verb, 'f')
        if (i % 2 === 1) base.when = { field: 'matter', op: '>', value: 5 } // flaws over conditioned scripts too
        const { script: bad } = flawScript(base, prng, cls)
        try {
          validateShape(bad)
          representable++
        } catch {
          /* structurally rejected — would never reach the oracle */
        }
        if (!staticCheck(bad).ok) caught++
      }
      ok(caught === N && representable === N, `${cls} on ${verb}: ${caught}/${N} caught, all structurally admissible`)
    }
  }
  // the flawed variant really is a DIFFERENT script
  const prng = mulberry32(3)
  const orig = sampleScript('harvest', 'same')
  const { script: flawed } = flawScript(orig, prng)
  ok(JSON.stringify(orig) !== JSON.stringify(flawed), 'flawScript changes the script')
  ok(flawed.id === orig.id, 'flawScript preserves the id (same script, subtly broken)')
}

// ── 9. Oracle dry-run: predictions and advisories ────────────────────────────
console.log('oracle dry-run')
{
  const s = newGame(7)
  const rep = oracle(s, 0, { id: 'd1', verb: 'harvest', params: { rate: 2 } })
  ok(rep.ok && rep.prediction !== null && rep.prediction.length === 3, 'green verdict carries a 3-tick prediction')
  ok(rep.prediction!.every((p) => p.matter === 2 && p.ran), 'harvest predicts its per-tick matter yield')

  const repSell = oracle(s, 0, { id: 'd2', verb: 'sell', params: { amount: 2 } })
  ok(repSell.ok && repSell.prediction!.every((p) => p.tokens === 0), 'selling with no widgets predicts zero yield')
  ok(repSell.reasons.some((r) => r.includes('nothing to sell')), 'and says why in plain words')

  const repIdle = oracle(s, 0, { id: 'd3', verb: 'harvest', params: { rate: 1 }, when: { field: 'matter', op: '>', value: 500 } })
  ok(repIdle.ok && repIdle.prediction!.every((p) => !p.ran), 'a gated script predicts idle ticks')
  ok(repIdle.reasons.some((r) => r.includes('idle')), 'idle advisory is human-readable')

  const repBoost = oracle(s, 0, { id: 'd4', verb: 'boost', params: { mult: 3 } })
  ok(repBoost.ok && repBoost.reasons.some((r) => r.includes('blowup risk')), 'boost advisory names its blowup risk')

  const repBad = oracle(s, 0, { id: 'd5', verb: 'harvest', params: { rate: 50 } })
  ok(!repBad.ok && repBad.prediction === null, 'red verdict: no prediction, only reasons')
  ok(repBad.reasons.some((r) => r.includes('off by 10x')), 'the off-by-10x hint reads human')

  const repImp = oracle(s, 0, { id: 'd6', verb: 'harvest', params: { rate: 1 }, when: { field: 'tokens', op: '<', value: 0 } })
  ok(!repImp.ok && repImp.reasons.some((r) => r.includes('can never be true')), 'impossible condition goes red with a reason')
}

// ── 10. Lifecycle: draft → arm → the switch (INVERSE HYPOTHESIS lives here) ──
console.log('lifecycle + the oracle is the switch')
{
  // draftAccepted enters the queue unarmed
  const s = newGame(11)
  apply(s, { t: 'draftAccepted', script: H(1), tier: 'cheap' })
  const slot = s.players[0].scripts[0]
  ok(!slot.armed && slot.status === 'drafted', 'a draft enters the hand unarmed')

  // arming without an oracle pass is YOLO
  apply(s, { t: 'arm', id: 'h1' })
  ok(slot.armed && slot.yolo, 'arming unverified = YOLO')
  apply(s, { t: 'disarm', id: 'h1' })
  ok(!slot.armed && slot.status === 'disarmed', 'disarm pulls the plug')

  // oracle-green then arm = not YOLO
  apply(s, { t: 'oracleCheck', id: 'h1' })
  apply(s, { t: 'arm', id: 'h1' })
  ok(slot.armed && !slot.yolo && slot.everGreen, 'oracle-green arm is a verified arm')

  // MUST-FAIL: a YOLO'd hallucination MUST misfire, die, and cost waste
  const y = newGame(11)
  apply(y, { t: 'draftAccepted', script: { id: 'lie', verb: 'harvest', params: { rte: 3 } }, tier: 'cheap' })
  apply(y, { t: 'arm', id: 'lie' }) // no oracle — free, risky
  tick(y)
  const dead = y.players[0].scripts[0]
  ok(dead.status === 'dead' && !dead.armed, 'INVERSE: a YOLO hallucination MUST die at runtime')
  ok(y.players[0].waste >= DEAD_SCRIPT_WASTE, 'the misfire costs waste')
  ok(y.events.some((e) => e.t === 'misfire'), 'the misfire is a public event (comedy delivered)')
  throws(() => apply(y, { t: 'arm', id: 'lie' }), 'a dead script cannot be re-armed')

  // the SAME hallucination, oracle-checked while armed → auto-disarm, no death
  const g = newGame(11)
  apply(g, { t: 'draftAccepted', script: { id: 'lie', verb: 'harvest', params: { rte: 3 } }, tier: 'cheap' })
  apply(g, { t: 'arm', id: 'lie' })
  apply(g, { t: 'oracleCheck', id: 'lie' })
  const saved = g.players[0].scripts[0]
  ok(!saved.armed && saved.status === 'autoDisarmed', 'a red paid check on an armed script disarms it (the switch)')
  ok(saved.status !== 'dead', 'verified-in-time beats dead')

  // auto-renew: an oracle-green armed script stays armed tick after tick
  const a = newGame(11)
  apply(a, { t: 'draftAccepted', script: H(1), tier: 'cheap' })
  apply(a, { t: 'oracleCheck', id: 'h1' })
  apply(a, { t: 'arm', id: 'h1' })
  for (let i = 0; i < 30; i++) tick(a) // pressure < corrupt threshold this whole window
  ok(a.players[0].scripts[0].armed, 'auto-renew keeps a green script armed across 30 ticks')
  ok(a.players[0].uptime > 0, 'and it accrues uptime')
}

// ── 11. Corruption → the switch flips (green protected, YOLO suffers) ────────
console.log('corruption: protected vs YOLO')
{
  // Two players, same world: p0 verifies, p1 YOLOs the same script shape.
  const s = newGame(4242, 2)
  apply(s, { t: 'draftAccepted', player: 0, script: H(1), tier: 'cheap' })
  apply(s, { t: 'oracleCheck', player: 0, id: 'h1' })
  apply(s, { t: 'arm', player: 0, id: 'h1' })
  apply(s, { t: 'draftAccepted', player: 1, script: H(1), tier: 'cheap' })
  apply(s, { t: 'arm', player: 1, id: 'h1' }) // YOLO
  const seen = { corrupted: false, autoDisarm: false, misfire: false }
  let guard = 1000
  while (guard-- > 0) {
    tick(s)
    for (const e of s.events) {
      if (e.t === 'corrupted') seen.corrupted = true
      if (e.t === 'autoDisarm' && e.player === 0) seen.autoDisarm = true
      if (e.t === 'misfire' && e.player === 1) seen.misfire = true
    }
    if (seen.autoDisarm && seen.misfire) break
  }
  ok(seen.corrupted, 'gremlin spikes corrupt armed scripts (seeded, deterministic)')
  ok(seen.autoDisarm, 'a corrupted GREEN script auto-disarms on its per-tick re-oracle — the oracle is the switch, literal')
  ok(seen.misfire, 'a corrupted YOLO script misfires publicly instead')
  const p0 = s.players[0].scripts[0]
  const p1 = s.players[1].scripts[0]
  ok(p0.status === 'autoDisarmed' && p0.armed === false, 'verified workshop: script benched, not dead')
  ok(p1.status === 'dead', 'YOLO workshop: script dead')
  ok(!staticCheck(p0.script).ok, 'the corrupted script really is oracle-red now')
  ok(s.players[1].waste > s.players[0].waste, `YOLO costs more (waste ${s.players[1].waste} > ${s.players[0].waste})`)
}

// ── 12. Conditions gate execution ────────────────────────────────────────────
console.log('conditions')
{
  const s = newGame(13)
  apply(s, { t: 'draftAccepted', script: { id: 'h1', verb: 'harvest', params: { rate: 2 }, when: { field: 'tick', op: '>', value: 4 } }, tier: 'cheap' })
  apply(s, { t: 'oracleCheck', id: 'h1' })
  apply(s, { t: 'arm', id: 'h1' })
  for (let i = 0; i < 4; i++) tick(s) // ticks 1..4 — condition false
  ok(s.players[0].matter === 0, 'a gated script waits for its condition')
  tick(s) // tick 5 — condition true
  ok(s.players[0].matter === 2, 'and fires the tick the condition turns true')
}

// ── 13. Scoring: widgets shipped + uptime − waste ────────────────────────────
console.log('scoring')
{
  const s = newGame(1)
  const w = s.players[0]
  w.widgetsShipped = 3
  w.uptime = 7
  w.waste = 2
  ok(score(w) === 3 * SCORE_PER_WIDGET + 7 * SCORE_PER_UPTIME - 2 * SCORE_WASTE_MULT, 'score formula holds')

  // a working workshop outscores an idle one over the same world
  function run(withScripts: boolean): number {
    const g = newGame(31337)
    // TOKEN_START affords 2 verified drafts, not 3 (a real balance datum) —
    // fund this workshop so the test exercises three verbs at once.
    g.players[0].tokens = TOKEN_CAP
    if (withScripts) {
      apply(g, { t: 'draftAccepted', script: H(3), tier: 'cheap' })
      apply(g, { t: 'oracleCheck', id: 'h1' })
      apply(g, { t: 'arm', id: 'h1' })
      apply(g, { t: 'draftAccepted', script: { id: 'r1', verb: 'refine', params: { rate: 1 } }, tier: 'cheap' })
      apply(g, { t: 'oracleCheck', id: 'r1' })
      apply(g, { t: 'arm', id: 'r1' })
      apply(g, { t: 'draftAccepted', script: { id: 'p1', verb: 'patch', params: { strength: 4 } }, tier: 'cheap' })
      apply(g, { t: 'oracleCheck', id: 'p1' })
      apply(g, { t: 'arm', id: 'p1' })
    }
    for (let i = 0; i < 50; i++) tick(g)
    return score(g.players[0])
  }
  const working = run(true)
  const idle = run(false)
  ok(working > idle, `automation pays (score ${working} > ${idle})`)
  ok(idle <= 0, 'an idle workshop earns nothing (waste only)')
}

// ── 14. Events feed the board ────────────────────────────────────────────────
console.log('events')
{
  const s = newGame(2)
  apply(s, { t: 'draftAccepted', script: H(1), tier: 'smart' })
  ok(s.events.some((e) => e.t === 'drafted' && e.tier === 'smart'), 'drafted event carries its tier')
  apply(s, { t: 'oracleCheck', id: 'h1' })
  ok(s.events.some((e) => e.t === 'oracle' && e.ok), 'oracle verdicts are public events')
  apply(s, { t: 'arm', id: 'h1' })
  ok(s.events.some((e) => e.t === 'armed' && e.yolo === false), 'armed event says whether it was YOLO')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
