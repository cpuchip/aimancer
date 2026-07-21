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
  draftFlawRoll,
  fallbackDraft,
  injectApprenticeFlaws,
  parseDrafts,
  practiceDrafts,
  systemPrompt,
} from '../apprentice.ts'
import {
  APPRENTICE_FLAW_CHEAP_PCT,
  APPRENTICE_FLAW_SMART_PCT,
  BOOST_BLOWUP_WASTE,
  CORRUPT_THRESHOLD,
  DEAD_SCRIPT_WASTE,
  DRAFT_COST_CHEAP,
  DRAFT_COST_SMART,
  GREMLIN_RAMP_TICKS,
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
  VERB_PARAMS,
} from './balance.ts'
import { freshEvents, newFeedCursor } from '../eventFeed.ts'
import { ROUND1_TICKS_DEFAULT, ROUND2_TICKS_DEFAULT } from '../mpConfig.ts'
import { rulesMarkdown, rulesSections } from '../rules.ts'
import { FLAW_CLASSES, flawScript, sampleScript } from './flaws.ts'
import { oracle, staticCheck } from './oracle.ts'
import { apply, computeDelta, newGame, RuleError, score, snap, stateHash, tick, ticksRemaining, ticksRunning, validateShape } from './sim.ts'
import { pressureAt, stepMarket } from './world.ts'
import { CONDITION_FIELDS, CONDITION_OPS, VERBS, type Command, type PhaseTicks, type Script, type SimEvent, type SimState } from './types.ts'

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
function play(seed: number, log: Array<Command | 'tick'>, players = 1, phaseTicks?: Partial<PhaseTicks>): { s: SimState; events: SimEvent[] } {
  const s = newGame(seed, players, [], phaseTicks)
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

/** A game advanced straight to round 2 — the full-rules phase (oracle live,
 * auto-renew live). The reseed makes it byte-identical to a fresh world, so
 * every assertion that held on a D1 fresh game holds here unchanged. */
function newGameR2(seed = 1, numPlayers = 1, names: string[] = []): SimState {
  const s = newGame(seed, numPlayers, names)
  apply(s, { t: 'phase', to: 'intermission' })
  apply(s, { t: 'phase', to: 'round2' })
  s.events = [] // drop the transition events — tests start clean
  return s
}

const H = (rate = 1): Script => ({ id: 'h1', verb: 'harvest', params: { rate } })

// ── 1. Replay identity: seed + command log → identical state hash ────────────
// The log CROSSES ALL FOUR PHASES (phase advances are commands, so a replay
// carries the whole 40-minute weave — D2's replay-determinism requirement).
console.log('replay identity (across phases)')
{
  const log: Array<Command | 'tick'> = [
    // round 1 — naive: YOLO arms only, oracle attempts are refused (and the
    // refusal is itself deterministic — this one stays in the log on purpose)
    { t: 'draftAccepted', script: H(2), tier: 'cheap' },
    { t: 'oracleCheck', id: 'h1' }, // REFUSED in round1 — deterministic no-op
    { t: 'arm', id: 'h1' }, // YOLO
    'tick', 'tick', 'tick',
    { t: 'draftAccepted', script: { id: 'bad', verb: 'harvst', params: { rate: 2 } }, tier: 'cheap' },
    { t: 'arm', id: 'bad' }, // YOLO a hallucination — it will die
    ...Array(9).fill('tick') as 'tick'[],
    // intermission — frozen; stock the hand
    { t: 'phase', to: 'intermission' },
    'tick', 'tick', // no-ops (frozen)
    { t: 'draftAccepted', script: { id: 'r1', verb: 'refine', params: { rate: 1 } }, tier: 'smart' },
    { t: 'scrap', id: 'bad' }, // clear the corpse
    // round 2 — verified: fresh world, oracle live
    { t: 'phase', to: 'round2' },
    { t: 'oracleCheck', id: 'r1' },
    { t: 'arm', id: 'r1' },
    { t: 'draftAccepted', script: H(3), tier: 'cheap' },
    { t: 'oracleCheck', id: 'h1' },
    { t: 'arm', id: 'h1' },
    ...Array(19).fill('tick') as 'tick'[],
    { t: 'disarm', id: 'h1' },
    'tick', 'tick',
    { t: 'phase', to: 'reveal' },
    'tick', // no-op (game over)
  ]
  const cfg = { round1: 12, round2: 19 }
  const a = play(77, log, 1, cfg)
  const b = play(77, log, 1, cfg)
  ok(snap(a.s) === snap(b.s), 'identical seed+commands → identical state ACROSS ALL FOUR PHASES')
  ok(stateHash(a.s) === stateHash(b.s), `replay hash proof: ${stateHash(a.s)} == ${stateHash(b.s)}`)
  ok(a.s.phase === 'reveal' && a.s.round1Summary !== null && a.s.round2Summary !== null, 'the replay lands in reveal with both summaries captured')
  const c = play(78, log, 1, cfg)
  ok(stateHash(c.s) !== stateHash(a.s), `different seed → different hash (${stateHash(c.s)})`)
}

// ── 2. Token economy: regen, cap, draft/oracle costs ─────────────────────────
console.log('token economy')
{
  const s = newGameR2(5)
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

  const poor = newGameR2(5)
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
  const s = newGameR2(9)
  apply(s, { t: 'draftAccepted', script: H(3), tier: 'cheap' })
  apply(s, { t: 'oracleCheck', id: 'h1' })
  apply(s, { t: 'arm', id: 'h1' })
  tick(s)
  ok(s.players[0].matter === 3, 'harvest gains matter at its rate')

  // refine (ratio) — seed the matter directly
  const s2 = newGameR2(9)
  s2.players[0].matter = 10
  apply(s2, { t: 'draftAccepted', script: { id: 'r1', verb: 'refine', params: { rate: 2 } }, tier: 'cheap' })
  apply(s2, { t: 'oracleCheck', id: 'r1' })
  apply(s2, { t: 'arm', id: 'r1' })
  tick(s2)
  ok(s2.players[0].widgets === 2 && s2.players[0].matter === 10 - 2 * REFINE_RATIO, `refine converts ${REFINE_RATIO} matter per widget`)
  ok(s2.players[0].widgetsSold === 0, 'refined widgets are INVENTORY, not score — selling is what ships')

  // sell (at the market rate)
  const s3b = newGameR2(9)
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
  ok(s3b.players[0].widgetsSold === 3, 'sold widgets are the scored count (shipping IS selling)')

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
    const s = newGameR2(1234)
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
    const s = newGameR2(seed)
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
    const s = newGameR2(seed)
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
    const s = newGameR2(seed)
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
  const s = newGameR2(11)
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

  // MUST-FAIL: a YOLO'd hallucination MUST misfire, die, and cost waste.
  // Run in ROUND 1 on purpose: naive-round chaos is the show's first act.
  const y = newGame(11)
  apply(y, { t: 'draftAccepted', script: { id: 'lie', verb: 'harvest', params: { rte: 3 } }, tier: 'cheap' })
  apply(y, { t: 'arm', id: 'lie' }) // no oracle — free, risky
  tick(y)
  const dead = y.players[0].scripts[0]
  ok(dead.status === 'dead' && !dead.armed, 'INVERSE: a YOLO hallucination MUST die at runtime (round 1 chaos included)')
  ok(y.players[0].waste >= DEAD_SCRIPT_WASTE, 'the misfire costs waste')
  ok(y.events.some((e) => e.t === 'misfire'), 'the misfire is a public event (comedy delivered)')
  throws(() => apply(y, { t: 'arm', id: 'lie' }), 'a dead script cannot be re-armed')

  // the SAME hallucination, oracle-checked while armed → auto-disarm, no death
  const g = newGameR2(11)
  apply(g, { t: 'draftAccepted', script: { id: 'lie', verb: 'harvest', params: { rte: 3 } }, tier: 'cheap' })
  apply(g, { t: 'arm', id: 'lie' })
  apply(g, { t: 'oracleCheck', id: 'lie' })
  const saved = g.players[0].scripts[0]
  ok(!saved.armed && saved.status === 'autoDisarmed', 'a red paid check on an armed script disarms it (the switch)')
  ok(saved.status !== 'dead', 'verified-in-time beats dead')

  // auto-renew: an oracle-green armed script stays armed tick after tick
  const a = newGameR2(11)
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
  const s = newGameR2(4242, 2)
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
  const s = newGameR2(13)
  apply(s, { t: 'draftAccepted', script: { id: 'h1', verb: 'harvest', params: { rate: 2 }, when: { field: 'tick', op: '>', value: 4 } }, tier: 'cheap' })
  apply(s, { t: 'oracleCheck', id: 'h1' })
  apply(s, { t: 'arm', id: 'h1' })
  for (let i = 0; i < 4; i++) tick(s) // ticks 1..4 — condition false
  ok(s.players[0].matter === 0, 'a gated script waits for its condition')
  tick(s) // tick 5 — condition true
  ok(s.players[0].matter === 2, 'and fires the tick the condition turns true')
}

// ── 13. Scoring: widgets SOLD + uptime − waste ───────────────────────────────
console.log('scoring (sold, not produced)')
{
  const s = newGame(1)
  const w = s.players[0]
  w.widgetsSold = 3
  w.uptime = 7
  w.waste = 2
  ok(score(w) === 3 * SCORE_PER_WIDGET + 7 * SCORE_PER_UPTIME - 2 * SCORE_WASTE_MULT, 'score formula holds (per widget SOLD)')

  // producing without selling scores only uptime — the market is load-bearing
  const hoard = newGameR2(31337)
  hoard.players[0].matter = 30
  apply(hoard, { t: 'draftAccepted', script: { id: 'r1', verb: 'refine', params: { rate: 2 } }, tier: 'cheap' })
  apply(hoard, { t: 'oracleCheck', id: 'r1' })
  apply(hoard, { t: 'arm', id: 'r1' })
  for (let i = 0; i < 5; i++) tick(hoard)
  const hw = hoard.players[0]
  ok(hw.widgets > 0 && hw.widgetsSold === 0, `a warehouse full of unsold widgets (${hw.widgets}) has sold nothing`)
  ok(score(hw) === hw.uptime * SCORE_PER_UPTIME - hw.waste * SCORE_WASTE_MULT, 'unsold widgets contribute ZERO score')

  // a working workshop (that SELLS) outscores an idle one over the same world
  function run(withScripts: boolean): number {
    const g = newGameR2(31337)
    // TOKEN_START affords 2 verified drafts, not 3 (a real balance datum) —
    // fund this workshop so the test exercises four verbs at once.
    g.players[0].tokens = TOKEN_CAP
    if (withScripts) {
      apply(g, { t: 'draftAccepted', script: H(3), tier: 'cheap' })
      apply(g, { t: 'oracleCheck', id: 'h1' })
      apply(g, { t: 'arm', id: 'h1' })
      apply(g, { t: 'draftAccepted', script: { id: 'r1', verb: 'refine', params: { rate: 1 } }, tier: 'cheap' })
      apply(g, { t: 'oracleCheck', id: 'r1' })
      apply(g, { t: 'arm', id: 'r1' })
      apply(g, { t: 'draftAccepted', script: { id: 'sl', verb: 'sell', params: { amount: 2 } }, tier: 'cheap' })
      apply(g, { t: 'oracleCheck', id: 'sl' })
      apply(g, { t: 'arm', id: 'sl' })
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
  const s = newGameR2(2)
  apply(s, { t: 'draftAccepted', script: H(1), tier: 'smart' })
  ok(s.events.some((e) => e.t === 'drafted' && e.tier === 'smart'), 'drafted event carries its tier')
  apply(s, { t: 'oracleCheck', id: 'h1' })
  ok(s.events.some((e) => e.t === 'oracle' && e.ok), 'oracle verdicts are public events')
  apply(s, { t: 'arm', id: 'h1' })
  ok(s.events.some((e) => e.t === 'armed' && e.yolo === false), 'armed event says whether it was YOLO')
}

// ── 15. THE PHASE MACHINE (D2): the 40-minute weave, in the sim ──────────────
console.log('phase machine')
{
  const s = newGame(21, 2, ['Ada', 'Bob'], { round1: 5, round2: 7 })
  ok(s.phase === 'round1', 'a new game opens in round 1 (the room lobby is pre-sim)')
  ok(ticksRemaining(s) === 5, 'round-1 countdown reads the budget')

  // ROUND 1 IS NAIVE: the oracle is refused BY THE SIM — a rule, not UI hiding
  apply(s, { t: 'draftAccepted', player: 0, script: H(2), tier: 'cheap' })
  try {
    apply(s, { t: 'oracleCheck', player: 0, id: 'h1' })
    ok(false, 'oracle in round 1 must be refused')
  } catch (e) {
    ok(e instanceof RuleError && e.message.includes("hasn't been invented"), `oracle refused in round 1, in plain words ("${e instanceof Error ? e.message : e}")`)
  }
  apply(s, { t: 'arm', player: 0, id: 'h1' }) // YOLO is the only arm in round 1
  ok(s.players[0].scripts[0].yolo, 'every round-1 arm is a YOLO arm')

  // the tick budget freezes the world when spent
  for (let i = 0; i < 9; i++) tick(s)
  ok(s.tick === 5, `round 1 stops at its budget (tick ${s.tick} of 5) — extra ticks no-op`)
  ok(ticksRemaining(s) === 0 && !ticksRunning(s), 'spent budget: 0 remaining, world holds for the host')

  // only the lawful advance works
  throws(() => apply(s, { t: 'phase', to: 'round2' }), 'cannot skip intermission')
  throws(() => apply(s, { t: 'phase', to: 'reveal' }), 'cannot jump to reveal')
  apply(s, { t: 'phase', to: 'intermission' })
  ok(s.phase === 'intermission', 'host advances round1 → intermission')
  ok(s.round1Summary !== null && s.round1Summary.atTick === 5, 'round-1 summary captured at the freeze')
  ok(s.events.some((e) => e.t === 'phase' && e.phase === 'intermission'), 'the advance is a public event')

  // intermission: frozen world, drafts allowed, arms refused, oracle still absent
  const hashBefore = stateHash(s)
  tick(s)
  tick(s)
  ok(stateHash(s) === hashBefore, 'intermission ticks are no-ops (world frozen)')
  apply(s, { t: 'draftAccepted', player: 0, script: { id: 'r1', verb: 'refine', params: { rate: 1 } }, tier: 'smart' })
  ok(s.players[0].scripts.some((sl) => sl.script.id === 'r1'), 'drafting during intermission stocks the hand')
  throws(() => apply(s, { t: 'arm', player: 0, id: 'r1' }), 'arming is refused while the world is frozen')
  throws(() => apply(s, { t: 'oracleCheck', player: 0, id: 'r1' }), 'the oracle stays uninvented until round 2')

  // round 2: fresh world, same seed; names + stocked drafts carry, nothing else
  apply(s, { t: 'phase', to: 'round2' })
  ok(s.phase === 'round2' && s.tick === 0, 'round 2 restarts the clock')
  ok(s.players[0].tokens === TOKEN_START && s.players[0].matter === 0 && s.players[0].waste === 0, 'resources reset to opening values')
  ok(s.players[0].name === 'Ada' && s.players[1].name === 'Bob', 'names carry')
  ok(s.players[0].scripts.length === 1 && s.players[0].scripts[0].script.id === 'r1', 'ONLY un-played drafts carry (the armed h1 is gone)')
  ok(ticksRemaining(s) === 7, 'round-2 countdown reads its own budget')
  apply(s, { t: 'oracleCheck', player: 0, id: 'r1' })
  ok(s.players[0].scripts[0].everGreen, 'the oracle exists now')

  // reveal: full stop
  for (let i = 0; i < 7; i++) tick(s)
  apply(s, { t: 'phase', to: 'reveal' })
  ok(s.round2Summary !== null && s.round2Summary.atTick === 7, 'round-2 summary captured at the reveal')
  const frozen = stateHash(s)
  tick(s)
  ok(stateHash(s) === frozen, 'reveal ticks are no-ops')
  throws(() => apply(s, { t: 'draftAccepted', player: 0, script: H(1), tier: 'cheap' }), 'no drafting after the reveal')
  throws(() => apply(s, { t: 'phase', to: 'round1' }), 'nothing comes after the reveal')
}

// ── 16. Same-seed fairness: round 2 replays round 1's schedule exactly ───────
console.log('re-seed fairness')
{
  // Schedule fingerprint: per-tick (market, gremlin, spike?) over K empty ticks.
  function scheduleHash(s: SimState, ticks: number): string {
    const path: Array<[number, number, boolean]> = []
    for (let i = 0; i < ticks; i++) {
      tick(s)
      path.push([s.market, s.gremlin, s.events.some((e) => e.t === 'gremlinSpike')])
    }
    return JSON.stringify(path)
  }
  const K = 40
  // world A: a lived-in round 1 (commands, deaths, drama), then round 2
  const a = newGame(9001, 2, [], { round1: 6, round2: 0 })
  apply(a, { t: 'draftAccepted', player: 0, script: H(2), tier: 'cheap' })
  apply(a, { t: 'arm', player: 0, id: 'h1' })
  apply(a, { t: 'draftAccepted', player: 1, script: { id: 'lie', verb: 'harvst', params: { rate: 2 } }, tier: 'cheap' })
  apply(a, { t: 'arm', player: 1, id: 'lie' })
  for (let i = 0; i < 6; i++) tick(a)
  apply(a, { t: 'phase', to: 'intermission' })
  apply(a, { t: 'phase', to: 'round2' })
  // world B: a virgin same-seed game — the reference schedule
  const b = newGame(9001, 2, [], { round1: 0, round2: 0 })
  const hashA = scheduleHash(a, K)
  const hashB = scheduleHash(b, K)
  ok(hashA === hashB, `round 2's market+gremlin schedule == a fresh same-seed run (${K} ticks, fingerprints match)`)
}

// ── 17. Delta math: the reveal's table ───────────────────────────────────────
console.log('delta math')
{
  const s = newGame(55, 2, ['Kim', 'Lee'], { round1: 3, round2: 3 })
  // round 1: Kim YOLOs a lie (dies, waste); Lee does nothing
  apply(s, { t: 'draftAccepted', player: 0, script: { id: 'x', verb: 'harvest', params: { rte: 1 } }, tier: 'cheap' })
  apply(s, { t: 'arm', player: 0, id: 'x' })
  for (let i = 0; i < 3; i++) tick(s)
  apply(s, { t: 'phase', to: 'intermission' })
  const r1 = s.round1Summary!
  ok(r1.players[0].disasters === 1 && r1.players[0].score < 0, 'round 1: the YOLO death is on the books')
  ok(computeDelta(s) === null, 'no delta before round 2 exists')
  apply(s, { t: 'phase', to: 'round2' })
  // round 2: Kim sells verified widgets
  s.players[0].widgets = 6
  apply(s, { t: 'draftAccepted', player: 0, script: { id: 'sl', verb: 'sell', params: { amount: 2 } }, tier: 'cheap' })
  apply(s, { t: 'oracleCheck', player: 0, id: 'sl' })
  apply(s, { t: 'arm', player: 0, id: 'sl' })
  for (let i = 0; i < 3; i++) tick(s)
  apply(s, { t: 'phase', to: 'reveal' })
  const d = computeDelta(s)!
  ok(d !== null, 'reveal computes the delta')
  const kim = d.players[0]
  ok(kim.dScore === kim.r2.score - kim.r1.score, 'per-player dScore is r2 − r1')
  ok(kim.dScore > 0, `Kim improved with the oracle (Δ ${kim.dScore})`)
  ok(kim.dDisasters === -1, 'disasters went DOWN in the verified round')
  const t = d.totals
  ok(t.score === t.r2Score - t.r1Score, 'aggregate delta is consistent with the round totals')
  ok(t.score === d.players.reduce((acc, p) => acc + p.dScore, 0), 'aggregate == sum of player deltas')
}

// ── 18. Scrap: frees the slot, cannot scrap a live script ────────────────────
console.log('scrap')
{
  const s = newGameR2(3)
  apply(s, { t: 'draftAccepted', script: H(1), tier: 'cheap' })
  apply(s, { t: 'draftAccepted', script: { id: 'lie', verb: 'harvest', params: { rte: 2 } }, tier: 'cheap' })
  apply(s, { t: 'arm', id: 'lie' })
  tick(s) // the lie dies
  ok(s.players[0].scripts.length === 2, 'two slots before scrapping')
  apply(s, { t: 'scrap', id: 'lie' })
  ok(s.players[0].scripts.length === 1 && !s.players[0].scripts.some((sl) => sl.script.id === 'lie'), 'scrapping a dead script frees its slot')
  ok(s.events.some((e) => e.t === 'scrapped'), 'scrap is a public event')
  apply(s, { t: 'arm', id: 'h1' })
  throws(() => apply(s, { t: 'scrap', id: 'h1' }), 'an ARMED script cannot be scrapped (disarm first)')
  apply(s, { t: 'disarm', id: 'h1' })
  apply(s, { t: 'scrap', id: 'h1' })
  ok(s.players[0].scripts.length === 0, 'disarm-then-scrap empties the hand')
  // the freed id is usable again — the hand really is free
  apply(s, { t: 'draftAccepted', script: H(2), tier: 'cheap' })
  ok(s.players[0].scripts.length === 1, 'a scrapped id can be re-drafted')
  // a full hand of corpses can be cleared (the D1 clog, solved)
  const full = newGameR2(6)
  full.players[0].tokens = TOKEN_CAP
  for (let i = 0; i < MAX_SCRIPTS; i++) apply(full, { t: 'draftAccepted', script: { id: `s${i}`, verb: 'harvest', params: { rate: 1 } }, tier: 'cheap' })
  throws(() => apply(full, { t: 'draftAccepted', script: { id: 'no', verb: 'harvest', params: { rate: 1 } }, tier: 'cheap' }), 'hand still caps')
  apply(full, { t: 'scrap', id: 's0' })
  apply(full, { t: 'draftAccepted', script: { id: 'yes', verb: 'harvest', params: { rate: 1 } }, tier: 'cheap' })
  ok(full.players[0].scripts.length === MAX_SCRIPTS, 'scrap → draft refills the hand')
}

// ── 19. Event feed dedup: eventSeq slices exactly the unseen tail ────────────
console.log('event feed dedup')
{
  const s = newGameR2(8)
  const cursor = newFeedCursor()
  const seen: SimEvent[] = []
  // snapshot after EVERY command/tick — the server's push-on-change pattern
  const snapshot = () => seen.push(...freshEvents(cursor, s.events, s.eventSeq))
  apply(s, { t: 'draftAccepted', script: H(1), tier: 'cheap' })
  snapshot()
  snapshot() // a second push of the SAME state (e.g. another player acted)
  apply(s, { t: 'arm', id: 'h1' })
  snapshot() // events array now holds [drafted, armed] — drafted must NOT repeat
  tick(s)
  snapshot()
  const draftedCount = seen.filter((e) => e.t === 'drafted').length
  const armedCount = seen.filter((e) => e.t === 'armed').length
  ok(draftedCount === 1, `duplicate-append FIXED: 'drafted' delivered exactly once (got ${draftedCount})`)
  ok(armedCount === 1, `'armed' delivered exactly once across overlapping snapshots`)
  // the watermark survives the round-2 reset (eventSeq is monotonic)
  const s2 = newGame(8, 1, [], { round1: 2, round2: 5 })
  const c2 = newFeedCursor()
  const seen2: SimEvent[] = []
  const snap2 = () => seen2.push(...freshEvents(c2, s2.events, s2.eventSeq))
  tick(s2); snap2()
  tick(s2); snap2()
  apply(s2, { t: 'phase', to: 'intermission' }); snap2()
  apply(s2, { t: 'phase', to: 'round2' }); snap2(); snap2()
  const phaseEvents = seen2.filter((e) => e.t === 'phase').length
  ok(phaseEvents === 2, `phase events cross the reset exactly once each (got ${phaseEvents})`)
}

// ── 20. The async apprentice: escrow economics (D3) ──────────────────────────
console.log('async apprentice economics')
{
  const s = newGameR2(70)
  const w = s.players[0]
  ok(w.tokens === TOKEN_START, 'fixture opens at TOKEN_START')

  // draftRequested debits IMMEDIATELY — the player pays before the model runs
  apply(s, { t: 'draftRequested', reqId: 'q1', tier: 'smart' })
  ok(w.tokens === TOKEN_START - DRAFT_COST_SMART, `a smart request debits ${DRAFT_COST_SMART} up front`)
  ok(w.pending.length === 1 && w.pending[0].reqId === 'q1' && w.pending[0].tier === 'smart', 'the request sits in escrow')
  ok(s.events.some((e) => e.t === 'draftRequested' && e.tier === 'smart'), 'the ask is a public event')
  throws(() => apply(s, { t: 'draftRequested', reqId: 'q1', tier: 'cheap' }), 'duplicate reqId refused')

  // arriving drafts are 0-cost — already paid
  const before = w.tokens
  apply(s, { t: 'draftAccepted', script: H(2), tier: 'smart', reqId: 'q1' })
  apply(s, { t: 'draftAccepted', script: { id: 'h2', verb: 'sell', params: { amount: 2 } }, tier: 'smart', reqId: 'q1' })
  ok(w.tokens === before, 'delivered drafts cost NOTHING extra (0-cost, already paid)')
  ok(w.scripts.length === 2, 'both drafts landed in the hand')
  throws(() => apply(s, { t: 'draftAccepted', script: { id: 'h3', verb: 'patch', params: { strength: 1 } }, tier: 'smart', reqId: 'zz' }), 'a delivery without escrow is refused')

  // settle closes the escrow; the total cost of the whole round-trip = the tier price
  apply(s, { t: 'draftSettled', reqId: 'q1' })
  ok(w.pending.length === 0, 'settle clears the escrow')
  ok(w.tokens === TOKEN_START - DRAFT_COST_SMART, 'request + 2 drafts + settle == exactly the tier price')
  throws(() => apply(s, { t: 'draftSettled', reqId: 'q1' }), 'double-settle refused')

  // the refund path: request + fail == net zero
  apply(s, { t: 'draftRequested', reqId: 'q2', tier: 'cheap' })
  const afterDebit = w.tokens
  ok(afterDebit === TOKEN_START - DRAFT_COST_SMART - DRAFT_COST_CHEAP, 'cheap request debits too')
  apply(s, { t: 'draftFailed', reqId: 'q2', reason: 'timeout' })
  ok(w.tokens === afterDebit + DRAFT_COST_CHEAP, `a failed request refunds its ${DRAFT_COST_CHEAP}`)
  ok(w.pending.length === 0, 'the failed escrow is gone')
  ok(s.events.some((e) => e.t === 'draftFailed' && e.refund === DRAFT_COST_CHEAP), 'the refund is a public event (spoken-friendly)')
  throws(() => apply(s, { t: 'draftFailed', reqId: 'q2' }), 'double-fail refused')

  // broke: the request itself refuses
  const poor = newGameR2(70)
  poor.players[0].tokens = DRAFT_COST_CHEAP - 1
  throws(() => apply(poor, { t: 'draftRequested', reqId: 'q1', tier: 'cheap' }), 'cannot request drafts without tokens')

  // full hand: the request refuses up front (no doomed escrow)
  const full = newGameR2(70)
  full.players[0].tokens = TOKEN_CAP
  for (let i = 0; i < MAX_SCRIPTS; i++) apply(full, { t: 'draftAccepted', script: { id: `s${i}`, verb: 'harvest', params: { rate: 1 } }, tier: 'cheap' })
  throws(() => apply(full, { t: 'draftRequested', reqId: 'q1', tier: 'cheap' }), 'a full workshop cannot request drafts')

  // refund respects the cap: no token minting through the refund door
  const capped = newGameR2(70)
  capped.players[0].tokens = TOKEN_CAP
  apply(capped, { t: 'draftRequested', reqId: 'q1', tier: 'smart' })
  for (let i = 0; i < 5; i++) tick(capped) // regen climbs back to the cap
  ok(capped.players[0].tokens === TOKEN_CAP, 'regen restored the cap while the request was in flight')
  apply(capped, { t: 'draftFailed', reqId: 'q1' })
  ok(capped.players[0].tokens === TOKEN_CAP, 'the refund cannot push past TOKEN_CAP')
}

// ── 21. Hybrid hallucination: seeded, deterministic, at the tier rate ────────
console.log('seeded flaw injection + parsing')
{
  const drafts = (): Script[] => [
    { id: 'tmp', verb: 'harvest', params: { rate: 2 } },
    { id: 'tmp', verb: 'sell', params: { amount: 3 } },
    { id: 'tmp', verb: 'refine', params: { rate: 1 } },
  ]
  // same room+tick+seat+request → byte-identical output, every time
  const a = injectApprenticeFlaws(drafts(), 4242, 7, 1, 'q3', 'cheap')
  const b = injectApprenticeFlaws(drafts(), 4242, 7, 1, 'q3', 'cheap')
  ok(JSON.stringify(a) === JSON.stringify(b), 'same room+tick+seat+request → same flaw pattern (deterministic)')
  const patterns = new Set<string>()
  for (let seed = 1; seed <= 30; seed++) {
    patterns.add(injectApprenticeFlaws(drafts(), seed, 7, 1, 'q3', 'cheap').map((d) => (d.flawed ? 'F' : '.')).join(''))
  }
  ok(patterns.size > 1, `different rooms flaw differently (${patterns.size} distinct patterns across 30 seeds)`)

  // flawed drafts are ALWAYS oracle-red; clean drafts pass through untouched
  let flawedTotal = 0
  let cleanIdentical = true
  for (let r = 0; r < 50; r++) {
    const out = injectApprenticeFlaws(drafts(), 99, r, 0, `q${r}`, 'cheap')
    for (let i = 0; i < out.length; i++) {
      if (out[i].flawed) {
        flawedTotal++
        if (staticCheck(out[i].script).ok) cleanIdentical = false // a flawed draft that passes the oracle breaks the contract
      } else if (JSON.stringify(out[i].script) !== JSON.stringify(drafts()[i])) {
        cleanIdentical = false
      }
    }
  }
  ok(flawedTotal > 0, `injection actually fires (${flawedTotal} flawed across 150 rolls)`)
  ok(cleanIdentical, 'every flawed draft is oracle-RED; every clean draft is untouched')

  // the tier rates hold (deterministic sample, so the bounds are stable)
  function rate(tier: 'cheap' | 'smart'): number {
    let flawed = 0
    const N = 2000
    for (let i = 0; i < N; i++) if (draftFlawRoll(1234, i % 40, i % 8, `r${i}`, i % 3, tier)) flawed++
    return (flawed / N) * 100
  }
  const cheapRate = rate('cheap')
  const smartRate = rate('smart')
  ok(Math.abs(cheapRate - APPRENTICE_FLAW_CHEAP_PCT) < 5, `cheap flaw rate ≈ ${APPRENTICE_FLAW_CHEAP_PCT}% (measured ${cheapRate.toFixed(1)}%)`)
  ok(Math.abs(smartRate - APPRENTICE_FLAW_SMART_PCT) < 4, `smart flaw rate ≈ ${APPRENTICE_FLAW_SMART_PCT}% (measured ${smartRate.toFixed(1)}%)`)
  ok(cheapRate > smartRate, 'cheap hallucinates more than smart — you get what you pay for')

  // practice mode: seeded, valid by construction, 2-3 drafts
  const p1 = practiceDrafts(31337, 4, 0, 'q9', 'cheap')
  const p2 = practiceDrafts(31337, 4, 0, 'q9', 'cheap')
  ok(JSON.stringify(p1) === JSON.stringify(p2), 'practice drafts are deterministic (seeded)')
  ok(p1.length >= 2 && p1.length <= 3, `practice serves 2-3 drafts (got ${p1.length})`)
  ok(p1.every((d) => staticCheck({ ...d, id: 'x' }).ok), 'practice drafts are valid by construction (flaws come from injection)')

  // the organic fallback is seeded and always red (an honest hallucination)
  const f1 = fallbackDraft(31337, 4, 0, 'q9')
  const f2 = fallbackDraft(31337, 4, 0, 'q9')
  ok(JSON.stringify(f1) === JSON.stringify(f2), 'the gibberish fallback is deterministic')
  ok(!staticCheck({ ...f1, id: 'x' }).ok, 'the gibberish fallback is oracle-RED (the apprentice really hallucinated)')

  // defensive parsing (loom's lesson): strict, fenced, prose-wrapped, garbage
  const strict = parseDrafts('[{"verb":"harvest","params":{"rate":2}},{"verb":"sell","params":{"amount":"3"}}]')
  ok(strict.length === 2 && strict[0].verb === 'harvest', 'strict JSON parses')
  ok(strict[1].params['amount'] === 3, 'numeric strings are coerced (models do that)')
  const fenced = parseDrafts('Sure! Here are your drafts:\n```json\n[{"verb":"refine","params":{"rate":1}}]\n```\nEnjoy!')
  ok(fenced.length === 1 && fenced[0].verb === 'refine', 'fenced JSON with prose parses (tolerated, not trusted)')
  const wrapped = parseDrafts('I suggest: [{"verb":"patch","params":{"strength":4}}] — good luck')
  ok(wrapped.length === 1 && wrapped[0].verb === 'patch', 'a bare array inside prose parses')
  ok(parseDrafts('You should really harvest more, boss!').length === 0, 'pure prose parses to NOTHING (the organic path)')
  ok(parseDrafts('').length === 0, 'empty content parses to nothing')
  const hallucinated = parseDrafts('[{"verb":"transmogrify","params":{"vibes":11}}]')
  ok(hallucinated.length === 1 && hallucinated[0].verb === 'transmogrify', 'semantic hallucinations SURVIVE parsing — catching them is the oracle\'s job')
  const five = parseDrafts(JSON.stringify(Array.from({ length: 5 }, () => ({ verb: 'harvest', params: { rate: 1 } }))))
  ok(five.length === 3, 'a chatty model is clamped to 3 drafts')

  // the prompt teaches the REAL bounds (interpolated from balance.ts — no drift)
  ok(systemPrompt().includes('"rate": integer 1..5') && systemPrompt().includes('"mult": integer 2..4'), 'the system prompt carries the live balance bounds')
}

// ── 22. Replay identity WITH the async apprentice flow ───────────────────────
console.log('replay with async drafts')
{
  // the log a real room would write: request (paid) → world ticks while the
  // model thinks → drafts arrive as data → settle; plus a failed request; the
  // whole thing CROSSES the round-2 reseed (escrow carries).
  const log: Array<Command | 'tick'> = [
    { t: 'draftRequested', reqId: 'q1', tier: 'smart' },
    'tick', 'tick', // latency absorbed — the world keeps moving
    { t: 'draftAccepted', script: { id: 'q1a', verb: 'harvest', params: { rate: 3 } }, tier: 'smart', reqId: 'q1' },
    { t: 'draftAccepted', script: { id: 'q1b', verb: 'harvst', params: { rate: 30 } }, tier: 'smart', reqId: 'q1' }, // a hallucination, as data
    { t: 'draftSettled', reqId: 'q1' },
    { t: 'arm', id: 'q1a' },
    ...Array(10).fill('tick') as 'tick'[],
    { t: 'draftRequested', reqId: 'q2', tier: 'cheap' }, // in flight across the phase line…
    { t: 'phase', to: 'intermission' },
    { t: 'phase', to: 'round2' },
    { t: 'draftAccepted', script: { id: 'q2a', verb: 'sell', params: { amount: 2 } }, tier: 'cheap', reqId: 'q2' }, // …lands in round 2
    { t: 'draftSettled', reqId: 'q2' },
    { t: 'draftRequested', reqId: 'q3', tier: 'smart' },
    'tick', 'tick',
    { t: 'draftFailed', reqId: 'q3', reason: 'timeout' }, // refund, replayed identically
    ...Array(6).fill('tick') as 'tick'[],
  ]
  const cfg = { round1: 12, round2: 19 }
  const a = play(4141, log, 1, cfg)
  const b = play(4141, log, 1, cfg)
  ok(snap(a.s) === snap(b.s), 'identical seed+commands → identical state (LLM output rides the log as data)')
  ok(stateHash(a.s) === stateHash(b.s), `replay hash proof with async drafts: ${stateHash(a.s)}`)
  ok(a.s.players[0].scripts.some((sl) => sl.script.id === 'q2a'), 'a request paid in round 1 delivers into the round-2 hand (escrow carries the reseed)')
  ok(a.s.players[0].pending.length === 0, 'no escrow left dangling')
  ok(a.events.filter((e) => e.t === 'draftFailed').length === 1, 'the refund happened exactly once')
  // and the economics held: q2 was paid in round 1 (reset wiped it), q3 refunded
  const w = a.s.players[0]
  const expectedFromR2 = Math.min(TOKEN_CAP, TOKEN_START + 8 * TOKEN_REGEN) // 8 round-2 ticks of regen (q3 pay+refund nets 0)
  ok(w.tokens === expectedFromR2, `round-2 tokens are pure regen after the paid/refunded wash (${w.tokens})`)
}

// ── 23. Per-script yield legibility: lastRun tells the truth per slot ────────
// The hotfix for "multiples of a thing don't seem to work": a STARVED script
// (shared-resource saturation) must be distinguishable from a dead one — for
// the phone card AND the agent reading its own /state.
console.log('per-script lastRun yield')
{
  // harvest reports its gain
  const s = newGameR2(9)
  apply(s, { t: 'draftAccepted', script: H(3), tier: 'cheap' })
  apply(s, { t: 'oracleCheck', id: 'h1' })
  apply(s, { t: 'arm', id: 'h1' })
  tick(s)
  const hr = s.players[0].scripts[0].lastRun
  ok(hr !== null && hr.ran && hr.dMatter === 3 && hr.note === '+3 matter', `harvest lastRun carries the yield (${hr?.note})`)

  // TWO refiners on thin matter: the first eats, the second STARVES — and says so
  const s2 = newGameR2(9)
  s2.players[0].matter = 3 // exactly one widget's worth
  for (const id of ['r1', 'r2']) {
    apply(s2, { t: 'draftAccepted', script: { id, verb: 'refine', params: { rate: 1 } }, tier: 'cheap' })
    apply(s2, { t: 'oracleCheck', id })
    apply(s2, { t: 'arm', id })
  }
  tick(s2)
  const [ra, rb] = s2.players[0].scripts.map((sl) => sl.lastRun)
  ok(ra !== null && ra.ran && ra.dWidgets === 1, 'slot-order: the first refiner gets the matter')
  ok(rb !== null && rb.ran && rb.dWidgets === 0 && rb.note.includes('starved'), `the starved duplicate SAYS it starved (${rb?.note})`)

  // a gated script reports idle, not starving
  const s3 = newGameR2(13)
  apply(s3, { t: 'draftAccepted', script: { id: 'g1', verb: 'harvest', params: { rate: 2 }, when: { field: 'tick', op: '>', value: 4 } }, tier: 'cheap' })
  apply(s3, { t: 'oracleCheck', id: 'g1' })
  apply(s3, { t: 'arm', id: 'g1' })
  tick(s3)
  const gr = s3.players[0].scripts[0].lastRun
  ok(gr !== null && !gr.ran && gr.note.includes('idle'), `condition-false reads as idle (${gr?.note})`)

  // an empty-handed seller reports nothing-to-sell
  const s4 = newGameR2(9)
  apply(s4, { t: 'draftAccepted', script: { id: 'sl', verb: 'sell', params: { amount: 2 } }, tier: 'cheap' })
  apply(s4, { t: 'oracleCheck', id: 'sl' })
  apply(s4, { t: 'arm', id: 'sl' })
  tick(s4)
  const sr = s4.players[0].scripts[0].lastRun
  ok(sr !== null && sr.ran && sr.dWidgets === 0 && sr.note === 'nothing to sell', `sell with no inventory says so (${sr?.note})`)

  // a real sale reports the token gain
  s4.players[0].widgets = 5
  tick(s4)
  const sr2 = s4.players[0].scripts[0].lastRun
  ok(sr2 !== null && sr2.dWidgets === -2 && sr2.dTokens > 0 && sr2.note.startsWith('sold 2'), `sell reports units + tokens (${sr2?.note})`)

  // determinism: lastRun is pure f(seed+log) — same run twice, identical snap
  const mk = () => {
    const x = newGameR2(77)
    x.players[0].matter = 3
    for (const id of ['r1', 'r2']) {
      apply(x, { t: 'draftAccepted', script: { id, verb: 'refine', params: { rate: 1 } }, tier: 'cheap' })
      apply(x, { t: 'oracleCheck', id })
      apply(x, { t: 'arm', id })
    }
    for (let i = 0; i < 5; i++) tick(x)
    return x
  }
  ok(snap(mk()) === snap(mk()), 'lastRun rides the snapshot deterministically (replay identity holds)')
}

// ── The rules — ONE source of truth (shared/rules.ts) ────────────────────────
// The reference is GENERATED from balance.ts/mpConfig.ts; these assertions
// prove the real constants made it into the text — if a number is retuned,
// the wiki and /api/rules follow automatically and this stays green.
console.log('rules — one source of truth')
{
  const sections = rulesSections()
  const md = rulesMarkdown()
  const ids = sections.map((sc) => sc.id)
  ok(new Set(ids).size === ids.length && ids.length >= 9, `sections carry unique anchors (${ids.length} sections)`)
  ok(sections.every((sc) => sc.body.trim().length > 100 && sc.title.length > 0), 'every section has a real title + body')
  ok(!md.includes('undefined') && !md.includes('NaN') && !/\$\{/.test(md), 'no interpolation holes (undefined/NaN/${) in the text')

  // the dyad + covenant line
  ok(md.includes('your apprentice drafts · only a human arms'), 'the covenant line is in the rules')
  ok(md.toLowerCase().includes('worker token') && md.toLowerCase().includes('hinge token'), 'the two-token split is taught')

  // scoring + economy carry the LIVE constants
  ok(md.includes(`× ${SCORE_PER_WIDGET}`) && md.includes(`× ${SCORE_WASTE_MULT}`), 'the scoring formula carries the live weights')
  ok(md.includes(`Start ${TOKEN_START}, regen +${TOKEN_REGEN} per tick, cap ${TOKEN_CAP}`), 'the token economy line carries start/regen/cap')
  ok(md.includes(`cheap draft ${DRAFT_COST_CHEAP}⚡`) && md.includes(`smart draft ${DRAFT_COST_SMART}⚡`) && md.includes(`oracle check ${ORACLE_COST}⚡`), 'every price comes from balance.ts')
  ok(md.includes(`${APPRENTICE_FLAW_CHEAP_PCT}%`) && md.includes(`${APPRENTICE_FLAW_SMART_PCT}%`), 'both tier flaw rates are in the draft table')
  ok(md.includes(`${MAX_SCRIPTS} scripts`), 'the hand cap is stated')

  // the verb table: every verb, every param, every bound — straight from VERB_PARAMS
  const verbsBody = sections.find((sc) => sc.id === 'verbs')!.body
  for (const v of VERBS) ok(verbsBody.includes(`| \`${v}\` |`), `verb table row: ${v}`)
  for (const [verb, specs] of Object.entries(VERB_PARAMS)) {
    for (const sp of specs) ok(verbsBody.includes(`\`${sp.name}\` ${sp.min}..${sp.max}`), `bounds in the table: ${verb}.${sp.name} ${sp.min}..${sp.max}`)
  }
  ok(verbsBody.includes(`${REFINE_RATIO} matter per widget`) && verbsBody.includes('starved'), 'refine saturation (needs matter) is taught')
  ok(verbsBody.includes('nothing to sell'), 'sell saturation (needs widgets) is taught')

  // conditions: the full field + op sets
  const condBody = sections.find((sc) => sc.id === 'conditions')!.body
  for (const f of CONDITION_FIELDS) ok(condBody.includes(`\`${f}\``), `condition field listed: ${f}`)
  for (const o of CONDITION_OPS) ok(condBody.includes(`\`${o}\``), `condition op listed: ${o}`)

  // phases: round budgets + what changes per round
  const phasesBody = sections.find((sc) => sc.id === 'phases')!.body
  ok(phasesBody.includes(`| ${ROUND1_TICKS_DEFAULT} |`) && phasesBody.includes(`| ${ROUND2_TICKS_DEFAULT} |`), 'round tick budgets come from mpConfig')
  ok(phasesBody.includes('DOES NOT EXIST') && md.includes('auto-renew'), 'round-1 no-oracle + round-2 auto-renew are taught')

  // gremlin: the pressure/spike/corruption chain
  const gremBody = sections.find((sc) => sc.id === 'gremlin')!.body
  ok(gremBody.includes(`every ${GREMLIN_RAMP_TICKS} ticks`) && gremBody.includes(`≥ ${CORRUPT_THRESHOLD}`), 'gremlin ramp + corruption threshold carry the constants')
  ok(gremBody.includes('attack surface'), 'YOLO-as-attack-surface is taught')

  // the API quick reference covers EVERY server route (drift-catcher: add a
  // route without documenting it and this fails)
  const apiBody = sections.find((sc) => sc.id === 'api')!.body
  const routes = ['state', 'draft', 'draft-request', 'oracle', 'arm', 'disarm', 'scrap', 'log', 'join', 'start', 'phase', 'hold', 'agent-prompt']
  for (const r of routes) ok(apiBody.includes(`/api/room/:pin/${r}\``), `api reference covers /api/room/:pin/${r}`)
  ok(apiBody.includes('`/api/room`') && apiBody.includes('`/api/rules`'), 'api reference covers create + the rules endpoint itself')
  ok(!/\b[wh]_[A-Za-z0-9]{6,}/.test(md), 'the rules text carries no token-shaped material')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
