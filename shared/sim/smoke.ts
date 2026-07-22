// AIMANCER smoke — the deterministic oracle floor for the ARK sim.
// Run: npm run smoke  (tsx shared/sim/smoke.ts). Exit 0 = green.
//
// The pre-pivot suite (rounds/phases/DSL/flaws/apprentice escrow) is RETIRED
// with the phase machine itself — deliberately, with the ark pivot. What
// carries forward: replay identity, token economy, vein mechanics, event
// feed dedup, rules-text drift checks. What's new: storms, milestones, THE
// DEPLOY GATE, the launch vote, drop-in joins, capacity, and
// engine-actions-as-data replay.

import {
  ACTIONS_PER_TICK_MAX,
  ARK_PARTS_REQUIRED,
  BEACON_PARTS_REQUIRED,
  BETA_RUN_COST,
  CHRONICLE_COST,
  CHRONICLE_MAX_ENTRIES,
  CHRONICLE_TEXT_MAX,
  CONTRIBUTE_RATE_MAX,
  DEPLOY_COST,
  DISTRICT_INTEGRITY_MAX,
  GRANARY_PARTS_REQUIRED,
  MAX_DYADS,
  ORACLE_COST,
  ORE_PER_PART,
  SCRIPT_KILL_THRESHOLD,
  SCRIPT_RUN_COST,
  SCRIPT_SLOTS_BASE,
  SOURCE_MAX_BYTES,
  STORM_FIRST_TICK,
  STORM_SEVERITY_BASE,
  STORM_SEVERITY_RAMP,
  STORM_UNVERIFIED_EXTRA,
  SURVIVOR_FOOD_COST,
  SURVIVOR_PERIOD,
  SURVIVORS_PER_SLOT,
  TOKEN_CAP,
  TOKEN_REGEN,
  TOKEN_START,
  VEIN_ID_MAX,
  VEINS_INITIAL,
  WALL_HP_PER_PART,
  WALL_PARTS_REQUIRED,
} from './balance.ts'
import { freshEvents, newFeedCursor } from '../eventFeed.ts'
import { defaultGatePolicy, describeGatePolicy, normalizeGatePolicy } from '../gatePolicy.ts'
import { rulesMarkdown } from '../rules.ts'
import { TEMPLATES } from '../templates.ts'
import { checkAction, judgeDryRun, staticCheck } from './oracle.ts'
import { apply, countStorms, goVotes, launchMajority, newGame, replay, RuleError, scriptSlots, snap, stateHash, tick, ticksRunning } from './sim.ts'
import { milestoneFrontier, nextStorm, stormAt, stormSpec, structureUnlocked, veinSpec } from './world.ts'
import type { Action, Command, SimEvent, SimState } from './types.ts'

let pass = 0
let failCount = 0
function ok(cond: boolean, name: string): void {
  if (cond) {
    pass++
  } else {
    failCount++
    console.error(`✗ ${name}`)
  }
}
function throws(fn: () => void, name: string): void {
  try {
    fn()
    failCount++
    console.error(`✗ ${name} (no error thrown)`)
  } catch (e) {
    ok(e instanceof RuleError, `${name} (RuleError)`)
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const SRC = 'act("farm", rate=1)\n'

function join(s: SimState, name: string): void {
  apply(s, { t: 'joinDistrict', name })
}
function dep(s: SimState, p: number, id: string, scope: 'district' | 'shared', verified = false, source = SRC): void {
  apply(s, { t: 'deploy', player: p, id, name: id, source, scope, verified, ...(verified ? { verdict: { ok: true, reasons: [] } } : {}) })
}
function stk(s: SimState, p: number, id: string, actions: Action[], extra: { err?: string; starved?: boolean } = {}): void {
  apply(s, { t: 'scriptTick', player: p, id, actions, gasUsed: 10, ...extra })
}
/** A game with n dyads joined at tick 0. */
function game(n = 2, seed = 7): SimState {
  const s = newGame(seed)
  for (let i = 0; i < n; i++) join(s, `D${i + 1}`)
  return s
}
function evTypes(s: SimState): string[] {
  return s.events.map((e) => e.t)
}

// ── 1. Drop-in joins: districts in order, full refusal, join-after-launch ───
{
  const s = newGame(11)
  ok(s.dyads.length === 0, 'settlement starts empty')
  ok(!ticksRunning(s), 'no ticks before the first dyad')
  join(s, 'Ada')
  ok(ticksRunning(s), 'ticks run once a dyad is seated')
  ok(s.dyads[0].district === 0, 'first dyad claims district 0')
  ok(s.dyads[0].tokens === TOKEN_START, 'opening tokens')
  ok(s.dyads[0].integrity === DISTRICT_INTEGRITY_MAX, 'opening integrity')
  tick(s)
  tick(s)
  join(s, 'Bob') // MID-GAME drop-in
  ok(s.dyads[1].district === 1, 'drop-in mid-game gets the next district')
  ok(s.dyads[1].joinedAtTick === 2, 'join tick recorded')
  ok(evTypes(s).includes('joined'), 'join emits an event')
  for (let i = 2; i < MAX_DYADS; i++) join(s, `P${i}`)
  throws(() => join(s, 'overflow'), 'settlement full refuses')
  ok(s.dyads.length === MAX_DYADS, 'seat cap holds')
  ok(s.veins.length === VEINS_INITIAL, 'the opening vein field')
}

// ── 2. Token economy: regen, cap, costs, starvation ─────────────────────────
{
  const s = game(1)
  const d = s.dyads[0]
  tick(s)
  ok(d.tokens === Math.min(TOKEN_CAP, TOKEN_START + TOKEN_REGEN), 'regen lands per tick')
  for (let i = 0; i < 20; i++) tick(s)
  ok(d.tokens === TOKEN_CAP, 'regen caps')
  dep(s, 0, 'a', 'district')
  ok(d.tokens === TOKEN_CAP - DEPLOY_COST, 'deploy costs')
  apply(s, { t: 'oracleResult', player: 0, id: 'a', ok: true, reasons: [] })
  ok(d.tokens === TOKEN_CAP - DEPLOY_COST - ORACLE_COST, 'oracle check costs')
  const before = d.tokens
  stk(s, 0, 'a', [{ type: 'farm', rate: 1 }])
  ok(d.tokens === before - SCRIPT_RUN_COST, 'a script run costs')
  ok(d.food === 1, 'the run acted')
  d.tokens = 0
  stk(s, 0, 'a', [{ type: 'farm', rate: 1 }], { starved: true })
  ok(d.scripts[0].lastTick?.ran === false, 'starved script did not run')
  ok((d.scripts[0].lastTick?.note ?? '').includes('starved'), 'starved note is honest')
  ok(d.food === 1, 'starved script yielded nothing')
  // defensive determinism: a scriptTick logged as un-starved but arriving at
  // zero tokens still resolves to starved (never throws, never acts)
  stk(s, 0, 'a', [{ type: 'farm', rate: 1 }])
  ok(d.food === 1 && d.scripts[0].lastTick?.ran === false, 'zero-token run resolves starved deterministically')
}

// ── 3. Deploy rules: bounds, scopes, slots, THE GATE backstop ───────────────
{
  const s = game(1)
  throws(() => apply(s, { t: 'deploy', player: 0, id: '', name: '', source: SRC, scope: 'district', verified: false }), 'empty id refused')
  throws(() => apply(s, { t: 'deploy', player: 0, id: 'x', name: 'x', source: '', scope: 'district', verified: false }), 'empty source refused')
  throws(
    () => apply(s, { t: 'deploy', player: 0, id: 'x', name: 'x', source: 'x'.repeat(SOURCE_MAX_BYTES + 1), scope: 'district', verified: false }),
    'oversized source refused',
  )
  throws(() => apply(s, { t: 'deploy', player: 0, id: 'x', name: 'x', source: SRC, scope: 'main' as never, verified: false }), 'bad scope refused')
  // FREEDOM UPDATE: an UNVERIFIED shared deploy is representable and legal —
  // the server-imposed gate is gone (the seat's own policy lives server-side)
  dep(s, 0, 'free', 'shared', false)
  ok(s.dyads[0].scripts.find((x) => x.id === 'free')?.verified === false, 'unverified shared deploy lands (FREEDOM: no sim backstop)')
  apply(s, { t: 'undeploy', player: 0, id: 'free' })
  dep(s, 0, 'a', 'district')
  throws(() => dep(s, 0, 'a', 'district'), 'duplicate running id refused')
  dep(s, 0, 'b', 'district')
  dep(s, 0, 'c', 'district')
  ok(scriptSlots(s) === SCRIPT_SLOTS_BASE, 'base script slots')
  throws(() => dep(s, 0, 'd', 'district'), 'slots full refused')
  apply(s, { t: 'undeploy', player: 0, id: 'a' })
  ok(s.dyads[0].scripts.find((x) => x.id === 'a')?.status === 'stopped', 'undeploy stops')
  dep(s, 0, 'd', 'district') // freed slot
  ok(s.dyads[0].scripts.filter((x) => x.status === 'running').length === SCRIPT_SLOTS_BASE, 'slot math')
  throws(() => dep(s, 0, 'a', 'shared', true), 'redeploy still respects slots')
  apply(s, { t: 'undeploy', player: 0, id: 'd' })
  dep(s, 0, 'a', 'shared', true) // redeploy replaces the stopped record
  ok(s.dyads[0].scripts.filter((x) => x.id === 'a').length === 1, 'redeploy replaces, never duplicates')
  ok(s.dyads[0].scripts.find((x) => x.id === 'a')?.verified === true, 'shared deploy lands verified')
  throws(() => apply(s, { t: 'undeploy', player: 0, id: 'zz' }), 'undeploy unknown refused')
  throws(() => apply(s, { t: 'deploy', player: 5, id: 'q', name: 'q', source: SRC, scope: 'district', verified: false }), 'unknown dyad refused')
}

// ── 4. Actions: gather/farm/craft semantics, caps, unknown honesty ──────────
{
  const s = game(1, 13)
  const d = s.dyads[0]
  dep(s, 0, 'w', 'district')
  const vein = s.veins[0]
  const draw = Math.min(3, vein.rate)
  stk(s, 0, 'w', [{ type: 'gather', node: vein.id, rate: 3 }])
  ok(d.ore === draw, `gather draws min(rate, vein.rate) — got ${d.ore}, want ${draw}`)
  ok(vein.reserve === vein.reserveMax - draw, 'gather drains the vein')
  stk(s, 0, 'w', [{ type: 'gather', node: 999, rate: 3 }])
  ok((d.scripts[0].lastTick?.note ?? '').includes('no vein'), 'gathering a phantom vein idles honestly')
  vein.reserve = 1
  stk(s, 0, 'w', [{ type: 'gather', node: vein.id, rate: 5 }])
  ok(vein.reserve === 0, 'vein drained')
  ok(evTypes(s).includes('veinExhausted'), 'exhaustion announced')
  stk(s, 0, 'w', [{ type: 'gather', node: vein.id, rate: 5 }])
  ok((d.scripts[0].lastTick?.note ?? '').includes('dry'), 'dry vein idles honestly')
  d.ore = ORE_PER_PART * 2 + 1
  stk(s, 0, 'w', [{ type: 'craft', amount: 2 }])
  ok(d.parts === 2 && d.ore === 1, 'craft consumes ore at the ratio')
  stk(s, 0, 'w', [{ type: 'craft', amount: 2 }])
  ok((d.scripts[0].lastTick?.note ?? '').includes('starved'), 'craft starves honestly')
  const stockBefore = d.ore + d.food + d.parts
  stk(s, 0, 'w', [{ type: 'buld', amount: 5 }])
  ok(d.ore + d.food + d.parts === stockBefore, 'unknown action moves nothing')
  ok((d.scripts[0].lastTick?.note ?? '').includes('unknown action'), 'unknown action named honestly')
  const many: Action[] = Array.from({ length: ACTIONS_PER_TICK_MAX + 5 }, () => ({ type: 'farm', rate: 1 }))
  const food0 = d.food
  stk(s, 0, 'w', many)
  ok(d.food === food0 + ACTIONS_PER_TICK_MAX, `action cap applied (${ACTIONS_PER_TICK_MAX}/tick)`)
}

// ── 5. SCOPE at runtime (FREEDOM): district can't touch shared; shared can,
//      verified or not — verification is storm armor, not a runtime lock ─────
{
  const s = game(1)
  const d = s.dyads[0]
  d.parts = 15
  dep(s, 0, 'yolo', 'district') // district scope — the yard boundary
  stk(s, 0, 'yolo', [{ type: 'contribute', structure: 'wall', amount: 5 }])
  ok(s.structures.wall.parts === 0, 'SCOPE: district script contribution dropped')
  ok(d.parts === 15, 'SCOPE: parts stay home')
  ok(evTypes(s).includes('gateRefused'), 'SCOPE: refusal is public')
  ok((d.scripts[0].lastTick?.note ?? '').includes('GATE'), 'SCOPE: note is honest')
  // FREEDOM: an UNVERIFIED shared script contributes — the runtime lock is gone
  dep(s, 0, 'free', 'shared', false)
  stk(s, 0, 'free', [{ type: 'contribute', structure: 'wall', amount: 5 }])
  ok(s.structures.wall.parts === 5, 'FREEDOM: unverified shared script contributes')
  ok(d.parts === 10 && d.contributed === 5, 'contribution bookkeeping')
  ok(s.structures.wall.hp === 5 * WALL_HP_PER_PART, 'wall parts add HP')
  ok(evTypes(s).includes('contributed'), 'contribution announced')
  // the oracle still switches VERIFIED (storm armor + the badge) — but a red
  // check no longer stops the work
  dep(s, 0, 'good', 'shared', true)
  ok(s.dyads[0].scripts.find((x) => x.id === 'good')?.verified === true, 'policy-verified shared deploy lands verified')
  apply(s, { t: 'oracleResult', player: 0, id: 'good', ok: false, reasons: ['edited into nonsense'] })
  ok(s.dyads[0].scripts.find((x) => x.id === 'good')?.verified === false, 'red verdict revokes verified (armor off)')
  stk(s, 0, 'good', [{ type: 'contribute', structure: 'wall', amount: 5 }])
  ok(s.structures.wall.parts === 10, 'FREEDOM: red verdict does NOT stop shared work (the storm prices it instead)')
  apply(s, { t: 'oracleResult', player: 0, id: 'good', ok: true, reasons: [] })
  ok(s.dyads[0].scripts.find((x) => x.id === 'good')?.verified === true, 'green verdict re-arms the armor')
}

// ── 6. Milestones: strict order, latch, frontier ────────────────────────────
{
  const s = game(1)
  const d = s.dyads[0]
  d.parts = 500
  dep(s, 0, 'b', 'shared', true)
  d.tokens = 500 // the test isn't about ⚡ — keep every run fed
  ok(structureUnlocked(s, 'wall'), 'wall unlocked from the start')
  ok(!structureUnlocked(s, 'granary'), 'granary locked behind the wall')
  ok(milestoneFrontier(s) === 'wall', 'frontier starts at the wall')
  stk(s, 0, 'b', [{ type: 'contribute', structure: 'granary', amount: 5 }])
  ok(s.structures.granary.parts === 0, 'locked structure takes nothing')
  ok((d.scripts[0].lastTick?.note ?? '').includes('locked'), 'lock is named honestly')
  const wallTicks = Math.ceil(WALL_PARTS_REQUIRED / CONTRIBUTE_RATE_MAX)
  for (let i = 0; i < wallTicks; i++) stk(s, 0, 'b', [{ type: 'contribute', structure: 'wall', amount: CONTRIBUTE_RATE_MAX }])
  ok(s.structures.wall.complete, 'wall completes at its parts requirement')
  ok(milestoneFrontier(s) === 'granary', 'frontier advances')
  ok(structureUnlocked(s, 'granary'), 'granary unlocks after the wall')
  const hpBefore = s.structures.wall.hp
  stk(s, 0, 'b', [{ type: 'contribute', structure: 'wall', amount: 2 }])
  ok(s.structures.wall.hp === Math.min(s.structures.wall.hpMax, hpBefore + 2 * WALL_HP_PER_PART), 'wall over-contribution repairs HP')
  d.food = 20
  stk(s, 0, 'b', [{ type: 'store', amount: 5 }])
  ok(s.granaryFood === 0, 'store refused before the granary stands')
  for (let i = 0; i < Math.ceil(GRANARY_PARTS_REQUIRED / CONTRIBUTE_RATE_MAX); i++) stk(s, 0, 'b', [{ type: 'contribute', structure: 'granary', amount: CONTRIBUTE_RATE_MAX }])
  ok(s.structures.granary.complete, 'granary completes')
  stk(s, 0, 'b', [{ type: 'store', amount: 5 }])
  ok(s.granaryFood === 5 && d.food === 15, 'store moves food into the granary')
  ok(milestoneFrontier(s) === 'beacon', 'frontier at the beacon')
}

// ── 7. Storms: schedule, escalation, wall absorbs, unverified suffer ────────
{
  const sp1 = stormSpec(42, 1)
  const sp2 = stormSpec(42, 2)
  ok(sp1.tick >= STORM_FIRST_TICK && sp1.tick < STORM_FIRST_TICK + 10, 'first storm near its knob')
  ok(sp2.severity === STORM_SEVERITY_BASE + STORM_SEVERITY_RAMP, 'severity escalates by index')
  ok(sp2.tick > sp1.tick, 'storms are ordered')
  ok(nextStorm(42, 0).index === 1, 'countdown sees storm 1 first')
  ok(nextStorm(42, sp1.tick).index === 2, 'countdown rolls to storm 2 after landing tick')
  ok(stormAt(42, sp1.tick)?.index === 1, 'stormAt finds the landing tick')
  ok(countStorms(42, sp1.tick) === 1, 'countStorms counts landings')

  const s = game(2, 42)
  const [a, b] = s.dyads
  a.ore = 30
  b.ore = 30
  dep(s, 0, 'ver', 'shared', true) // verified → no extra
  dep(s, 1, 'yolo1', 'district') // unverified ×2 → extra + kill candidate
  dep(s, 1, 'yolo2', 'district')
  while (s.tick < sp1.tick) tick(s)
  const landed = s.events.find((e) => e.t === 'stormLanded') as Extract<SimEvent, { t: 'stormLanded' }> | undefined
  ok(landed !== undefined, 'storm landed on schedule')
  if (landed) {
    ok(landed.absorbed === 0, 'no wall — nothing absorbed')
    ok(landed.damage[0] === sp1.severity, 'verified district takes the overflow only')
    ok(landed.damage[1] === sp1.severity + 2 * STORM_UNVERIFIED_EXTRA, 'unverified scripts add damage')
  }
  ok(a.integrity === DISTRICT_INTEGRITY_MAX - sp1.severity, 'integrity chewed')
  ok(a.stormDamage > 0 && b.stormDamage > a.stormDamage, 'verification correlation is visible')
  ok(a.ore < 30, 'stockpiles scorch')
  const killed = s.dyads[1].scripts.filter((x) => x.status === 'killed').length
  ok(sp1.severity + 2 * STORM_UNVERIFIED_EXTRA >= SCRIPT_KILL_THRESHOLD ? killed === 1 : killed === 0, 'storm kills ONE unverified script at threshold')
  ok(evTypes(s).includes('scriptKilled') === (killed === 1), 'kill announced')

  const s2 = game(1, 42)
  s2.structures.wall.hp = 500
  s2.structures.wall.hpMax = 500
  while (s2.tick < sp1.tick) tick(s2)
  const landed2 = s2.events.find((e) => e.t === 'stormLanded') as Extract<SimEvent, { t: 'stormLanded' }> | undefined
  ok(landed2 !== undefined && landed2.absorbed === sp1.severity, 'the wall absorbs for everyone')
  ok(s2.dyads[0].integrity === DISTRICT_INTEGRITY_MAX, 'walled district unhurt')
  ok(s2.structures.wall.hp === 500 - sp1.severity, 'absorption drains wall HP')

  const s3 = game(1, 42)
  let warned = false
  while (s3.tick < sp1.tick - 1) {
    tick(s3)
    if (s3.events.some((e) => e.t === 'stormWarning')) warned = true
  }
  ok(warned, 'storm warning fires ahead of landing')
}

// ── 8. Survivors: beacon + granary food → arrivals raise capacity ───────────
{
  const s = game(1)
  s.structures.wall.complete = true
  s.structures.granary.complete = true
  s.structures.beacon.complete = true
  s.granaryFood = SURVIVOR_FOOD_COST * 3 + 1
  const slots0 = scriptSlots(s)
  let arrivals = 0
  for (let i = 0; i < SURVIVOR_PERIOD * 4 + 2; i++) {
    tick(s)
    arrivals += s.events.filter((e) => e.t === 'survivorArrived').length
  }
  ok(arrivals === 3, `exactly the fed survivors arrive (got ${arrivals})`)
  ok(s.granaryFood === 1, 'each arrival eats')
  ok(s.survivors === 3, 'survivors counted')
  ok(scriptSlots(s) === Math.min(8, slots0 + Math.floor(3 / SURVIVORS_PER_SLOT)), 'survivors raise script capacity')
  const s2 = game(1)
  s2.granaryFood = 100 // food but NO beacon
  for (let i = 0; i < SURVIVOR_PERIOD + 1; i++) tick(s2)
  ok(s2.survivors === 0, 'no beacon, no survivors')
}

// ── 9. The vote + the launch: majority math, end stats, full stop ───────────
{
  const s = game(3)
  throws(() => apply(s, { t: 'vote', player: 0, go: true }), 'vote before the ark refused')
  throws(() => apply(s, { t: 'launch' }), 'launch before the ark refused')
  s.structures.wall.complete = true
  s.structures.granary.complete = true
  s.structures.beacon.complete = true
  s.structures.ark.parts = ARK_PARTS_REQUIRED
  s.structures.ark.complete = true
  apply(s, { t: 'vote', player: 0, go: true })
  ok(goVotes(s) === 1 && !launchMajority(s), '1 GO of 3 is no majority')
  throws(() => apply(s, { t: 'launch' }), 'launch without majority refused')
  apply(s, { t: 'vote', player: 1, go: false })
  ok(!launchMajority(s), 'a NO-GO is not a GO')
  apply(s, { t: 'vote', player: 1, go: true }) // revote — minds change
  ok(goVotes(s) === 2 && launchMajority(s), '2 GO of 3 is a majority (revote honored)')
  s.dyads[1].integrity = 0 // one district in rubble for the end screen
  apply(s, { t: 'launch' })
  ok(s.launched, 'launched')
  ok(!ticksRunning(s), 'the world rests after the launch')
  ok(s.end !== null, 'end stats captured')
  if (s.end) {
    ok(s.end.goVotes === 2 && s.end.dyads.length === 3, 'end stats carry the vote + dyads')
    ok(s.end.dyads[1].survived === false && s.end.dyads[0].survived === true, 'survival recorded per district')
  }
  throws(() => apply(s, { t: 'vote', player: 2, go: true }), 'no votes after launch')
  throws(() => join(s, 'late'), 'no joins after launch')
  const t0 = s.tick
  tick(s)
  ok(s.tick === t0, 'ticks are no-ops after launch')
}

// ── 10. scriptTick semantics: errors discard actions, legibility holds ──────
{
  const s = game(1)
  const d = s.dyads[0]
  dep(s, 0, 'e', 'district')
  stk(s, 0, 'e', [{ type: 'farm', rate: 3 }], { err: 'runtime: boom at line 3' })
  ok(d.food === 0, 'error discards partial actions')
  ok(d.scripts[0].errStreak === 1, 'errStreak counts')
  ok((d.scripts[0].lastTick?.note ?? '').startsWith('error:'), 'error note is honest')
  ok(evTypes(s).includes('scriptError'), 'errors are public')
  stk(s, 0, 'e', [{ type: 'farm', rate: 3 }])
  ok(d.scripts[0].errStreak === 0, 'a clean run clears the streak')
  ok(d.scripts[0].lastTick?.dFood === 3, 'per-tick yield deltas recorded')
  throws(() => stk(s, 0, 'zz', []), 'scriptTick on unknown script refused')
  apply(s, { t: 'undeploy', player: 0, id: 'e' })
  throws(() => stk(s, 0, 'e', []), 'scriptTick on a stopped script refused (server race guard)')
}

// ── 11. REPLAY IDENTITY: the full arc, engine actions as data ───────────────
{
  const seed = 99
  const live = newGame(seed)
  const log: Array<{ atTick: number; cmd: Command }> = []
  const cmd = (c: Command) => {
    apply(live, c)
    log.push({ atTick: live.tick, cmd: c })
  }
  cmd({ t: 'joinDistrict', name: 'Ada' })
  cmd({ t: 'deploy', player: 0, id: 'm', name: 'miner', source: SRC, scope: 'district', verified: false })
  for (let i = 0; i < 30; i++) {
    const vein = live.veins.find((v) => v.reserve > 0)
    if (vein && live.dyads[0].tokens >= SCRIPT_RUN_COST) {
      cmd({ t: 'scriptTick', player: 0, id: 'm', actions: [{ type: 'gather', node: vein.id, rate: 3 }, { type: 'craft', amount: 1 }], gasUsed: 42 })
    }
    tick(live)
    if (i === 10) cmd({ t: 'joinDistrict', name: 'Bob' }) // drop-in mid-log
    if (i === 12) cmd({ t: 'deploy', player: 1, id: 'b', name: 'builder', source: SRC, scope: 'shared', verified: true, verdict: { ok: true, reasons: [] } })
    if (i === 13) cmd({ t: 'oracleResult', player: 0, id: 'm', ok: true, reasons: [] })
    if (i > 13 && i % 3 === 0 && live.dyads[1].tokens >= SCRIPT_RUN_COST) {
      cmd({ t: 'scriptTick', player: 1, id: 'b', actions: [{ type: 'farm', rate: 2 }], gasUsed: 7 })
    }
  }
  const replayed = replay(seed, log, live.tick)
  ok(stateHash(replayed) === stateHash(live), 'REPLAY IDENTITY: seed + log → identical hash')
  ok(snap(replayed) === snap(live), 'REPLAY IDENTITY: byte-identical snapshots')
  const w1 = newGame(seed)
  const w2 = newGame(seed)
  join(w1, 'x')
  join(w2, 'x')
  for (let i = 0; i < 60; i++) {
    tick(w1)
    tick(w2)
  }
  ok(stateHash(w1) === stateHash(w2), 'pure ticking is deterministic')
  ok(veinSpec(seed, VEIN_ID_MAX).id === VEIN_ID_MAX, 'vein specs are pure')
}

// ── 12. Event feed dedup: eventSeq slices exactly the unseen tail ───────────
{
  const s = game(1)
  const cursor = newFeedCursor()
  tick(s)
  freshEvents(cursor, s.events, s.eventSeq)
  const again = freshEvents(cursor, s.events, s.eventSeq)
  ok(again.length === 0, 'feed cursor dedups within a tick')
  dep(s, 0, 'x', 'district')
  const afterCmd = freshEvents(cursor, s.events, s.eventSeq)
  ok(afterCmd.length === 1 && afterCmd[0].t === 'deployed', 'feed cursor sees exactly the new event')
}

// ── 13. The oracle module: static checks + action schema + dry-run judge ────
{
  ok(!staticCheck('').ok, 'empty source is red')
  ok(!staticCheck('x'.repeat(SOURCE_MAX_BYTES + 1)).ok, 'oversized source is red')
  ok(staticCheck(SRC).ok, 'a plain script passes static')
  ok(checkAction({ type: 'gather', node: 1, rate: 3 }).length === 0, 'gather in bounds')
  ok(checkAction({ type: 'gather', node: 0, rate: 3 }).length > 0, 'gather bad node caught')
  ok(checkAction({ type: 'gather', node: 1, rate: 99 }).length > 0, 'gather rate off-by-10x caught')
  ok(checkAction({ type: 'harvest', rate: 3 }).length > 0, 'unknown (pre-pivot!) verb caught')
  ok(checkAction({ type: 'contribute', structure: 'wall', amount: 3 }).length === 0, 'contribute in bounds')
  ok(checkAction({ type: 'contribute', structure: 'walls', amount: 3 }).length > 0, 'phantom structure caught')
  const red = judgeDryRun(SRC, { actions: [], logs: [], gasUsed: 5, err: 'gas: gas limit exceeded: too many steps' })
  ok(!red.ok, 'engine error ⇒ red')
  const red2 = judgeDryRun(SRC, { actions: [{ type: 'buld', amount: 1 }], logs: [], gasUsed: 5, err: null })
  ok(!red2.ok, 'out-of-schema action ⇒ red')
  const green = judgeDryRun(SRC, { actions: [{ type: 'farm', rate: 2 }], logs: ['hi'], gasUsed: 5, err: null })
  ok(green.ok && green.actions.length === 1, 'clean dry-run ⇒ green with actions attached')
  const idle = judgeDryRun(SRC, { actions: [], logs: [], gasUsed: 5, err: null })
  ok(idle.ok && (idle.reasons[0] ?? '').includes('watcher'), 'idle run ⇒ green with a note')
}

// ── 14. Rules text: the constants really made it in (drift guard) ───────────
{
  const md = rulesMarkdown()
  for (const [label, needle] of [
    ['wall parts', `| Wall | ${WALL_PARTS_REQUIRED} |`],
    ['granary parts', `| Granary | ${GRANARY_PARTS_REQUIRED} |`],
    ['beacon parts', `| Beacon | ${BEACON_PARTS_REQUIRED} |`],
    ['ark parts', `| THE ARK | ${ARK_PARTS_REQUIRED} |`],
    ['oracle cost', `${ORACLE_COST}⚡`],
    ['deploy cost', `${DEPLOY_COST}⚡`],
    ['regen', `+${TOKEN_REGEN}/tick`],
    ['storm base', `severity ${STORM_SEVERITY_BASE}`],
    ['unverified extra', `+${STORM_UNVERIFIED_EXTRA}`],
    ['gate-policy words', 'GATE POLICY'],
    ['freedom words', 'You deploy directly'],
    ['mirror yard', 'Mirror Yard'],
    ['beta cost', `${BETA_RUN_COST}⚡`],
    ['chronicle words', 'Chronicle'],
    ['chronicle cost', `${CHRONICLE_COST}⚡`],
    ['the honest hint', 'more than it admits'],
    ['host end', 'end the game early'],
    ['hinge custody', 'handed, not taken'],
    ['vote words', 'GO/NO-GO'],
    ['veins initial', `${VEINS_INITIAL} at settlement founding`],
  ] as const) {
    ok(md.includes(needle), `rules carry ${label}`)
  }
  // the smith template derives from ORE_PER_PART (the drift-catcher pattern)
  const smith = TEMPLATES.find((t) => t.id === 'smith')!
  ok(smith.blurb.includes(`${ORE_PER_PART} ore = 1 part`), 'smith blurb derives from ORE_PER_PART')
  ok(smith.source.includes(`>= ${ORE_PER_PART}`) && smith.source.includes(`>= ${ORE_PER_PART * 2}`), 'smith thresholds derive from ORE_PER_PART')
  ok(TEMPLATES.length >= 4, 'the template library holds the agentless floor')
  ok(TEMPLATES.some((t) => t.scope === 'shared'), 'a shared-scope template exists')
  ok(TEMPLATES.every((t) => staticCheck(t.source).ok), 'every template passes static checks')
}

// ── 15. PACING: the arc is completable and storms punish neglect ────────────
{
  const s = game(3, 5)
  for (const p of [0, 1, 2]) apply(s, { t: 'deploy', player: p, id: 'auto', name: 'auto', source: SRC, scope: 'shared', verified: true, verdict: { ok: true, reasons: [] } })
  let launchedAt: number | null = null
  for (let i = 0; i < 500 && !launchedAt; i++) {
    for (let p = 0; p < 3; p++) {
      const d = s.dyads[p]
      if (d.tokens < SCRIPT_RUN_COST) continue
      const actions: Action[] = []
      const vein = [...s.veins].filter((v) => v.reserve > 0).sort((x, y) => y.rate - x.rate)[0]
      if (vein) actions.push({ type: 'gather', node: vein.id, rate: 5 })
      actions.push({ type: 'farm', rate: 3 })
      if (d.ore >= ORE_PER_PART) actions.push({ type: 'craft', amount: 2 })
      const frontier = milestoneFrontier(s)
      if (d.parts > 0) actions.push({ type: 'contribute', structure: frontier ?? 'wall', amount: 5 })
      if (s.structures.granary.complete && d.food >= 6) actions.push({ type: 'store', amount: 5 })
      apply(s, { t: 'scriptTick', player: p, id: 'auto', actions, gasUsed: 50 })
    }
    tick(s)
    if (s.structures.ark.complete && !s.launched) {
      for (let p = 0; p < 3; p++) apply(s, { t: 'vote', player: p, go: true })
      apply(s, { t: 'launch' })
      launchedAt = s.tick
    }
  }
  ok(launchedAt !== null, 'the full arc completes with legal play')
  if (launchedAt) {
    console.log(`   (pacing: 3-dyad scripted room launched at tick ${launchedAt}; ${countStorms(5, launchedAt)} storms weathered)`)
    ok(launchedAt >= 80 && launchedAt <= 450, `arc length in the meeting band (launched at tick ${launchedAt})`)
    ok(countStorms(5, launchedAt) >= 1, 'the arc weathers storms on the way')
    ok(s.end !== null && s.end.totalParts >= WALL_PARTS_REQUIRED + GRANARY_PARTS_REQUIRED + BEACON_PARTS_REQUIRED + ARK_PARTS_REQUIRED, 'the parts ledger adds up')
  }
  const idleS = game(1, 5)
  for (let i = 0; i < 120; i++) tick(idleS)
  ok(idleS.dyads[0].integrity < DISTRICT_INTEGRITY_MAX, 'an unwalled settlement pays for it')
}

// ── 16. SPEND: the beta debit command (economy replays; service does not) ───
{
  const s = game(1)
  const d = s.dyads[0]
  apply(s, { t: 'spend', player: 0, amount: BETA_RUN_COST, reason: 'beta-run' })
  ok(d.tokens === TOKEN_START - BETA_RUN_COST, 'spend debits')
  throws(() => apply(s, { t: 'spend', player: 0, amount: 0, reason: 'x' }), 'spend zero refused')
  throws(() => apply(s, { t: 'spend', player: 0, amount: -3, reason: 'x' }), 'spend negative refused')
  throws(() => apply(s, { t: 'spend', player: 0, amount: 9999, reason: 'beta-run' }), 'spend beyond balance refused')
  ok(d.tokens === TOKEN_START - BETA_RUN_COST, 'refused spends move nothing')
}

// ── 17. THE CHRONICLE: cost, dedupe, relates-to, discovery-free, caps ───────
{
  const s = game(2)
  const [a, b] = s.dyads
  apply(s, { t: 'chronicle', player: 0, text: 'vein 2 dries around tick 40', evidence: ['state tick 41'] })
  ok(s.chronicle.length === 1 && s.chronicle[0].id === 1 && s.chronicle[0].author === 0, 'claim lands with id 1')
  ok(a.tokens === TOKEN_START - CHRONICLE_COST, 'a claim costs ⚡')
  ok(s.chronicle[0].kind === 'claim' && s.chronicle[0].evidence[0] === 'state tick 41', 'kind + evidence recorded')
  ok(evTypes(s).includes('chronicle'), 'the chronicle speaks on the feed')
  throws(() => apply(s, { t: 'chronicle', player: 1, text: 'vein 2 dries around tick 40' }), 'exact duplicate refused (novelty dedupe)')
  throws(() => apply(s, { t: 'chronicle', player: 1, text: '  VEIN 2   dries around tick 40 ' }), 'case/whitespace-normalized duplicate refused')
  ok(b.tokens === TOKEN_START, 'refused claims cost nothing')
  apply(s, { t: 'chronicle', player: 1, text: 'the storm schedule is seeded', relatesTo: [1] })
  ok(s.chronicle[1].relatesTo[0] === 1, 'relates-to links an earlier entry')
  throws(() => apply(s, { t: 'chronicle', player: 1, text: 'phantom link', relatesTo: [99] }), 'relates-to a phantom entry refused')
  throws(() => apply(s, { t: 'chronicle', player: 0, text: '' }), 'empty entry refused')
  throws(() => apply(s, { t: 'chronicle', player: 0, text: 'x'.repeat(CHRONICLE_TEXT_MAX + 1) }), 'oversized entry refused')
  const t0 = a.tokens
  apply(s, { t: 'chronicle', player: 0, kind: 'discovery', free: true, text: '[discovery] the salvage yard — first uncovered by D1' })
  ok(a.tokens === t0, 'discovery auto-entries are FREE')
  ok(s.chronicle[2].kind === 'discovery', 'discovery kind recorded')
  const ev = s.events.find((e) => e.t === 'chronicle' && e.kind === 'discovery')
  ok(ev !== undefined && 'snippet' in ev && (ev as { snippet: string }).snippet.includes('salvage'), 'discovery event carries the snippet')
  ok(CHRONICLE_MAX_ENTRIES >= 100, 'the book holds a real game')
}

// ── 18. HOST END: end screen as it stands, no launch, the world rests ───────
{
  const s = game(2)
  for (let i = 0; i < 5; i++) tick(s)
  apply(s, { t: 'end' })
  ok(s.launched && s.endedEarly, 'end latches the game over, flagged early')
  ok(s.end !== null && s.end.launchedAtTick === s.tick, 'end stats captured as they stand')
  ok(evTypes(s).includes('ended'), 'the end is announced')
  const t0 = s.tick
  tick(s)
  ok(s.tick === t0, 'ticks are no-ops after the end')
  throws(() => apply(s, { t: 'vote', player: 0, go: true }), 'no votes after the end')
  throws(() => apply(s, { t: 'end' }), 'no double end')
  const s2 = game(1)
  ok(!s2.endedEarly, 'a fresh game is not ended')
  s2.structures.wall.complete = true
  s2.structures.granary.complete = true
  s2.structures.beacon.complete = true
  s2.structures.ark.complete = true
  apply(s2, { t: 'vote', player: 0, go: true })
  apply(s2, { t: 'launch' })
  ok(s2.launched && !s2.endedEarly, 'a real launch is not flagged early')
}

// ── 19. REPLAY IDENTITY with the freedom commands in the log ────────────────
{
  const seed = 77
  const live = newGame(seed)
  const log: Array<{ atTick: number; cmd: Command }> = []
  const cmd = (c: Command) => {
    apply(live, c)
    log.push({ atTick: live.tick, cmd: c })
  }
  cmd({ t: 'joinDistrict', name: 'Ada' })
  cmd({ t: 'deploy', player: 0, id: 'free', name: 'free', source: SRC, scope: 'shared', verified: false }) // FREEDOM: unverified shared, logged
  cmd({ t: 'chronicle', player: 0, text: 'founding note: the wall comes first' })
  cmd({ t: 'spend', player: 0, amount: BETA_RUN_COST, reason: 'beta-run' })
  for (let i = 0; i < 12; i++) {
    if (live.dyads[0].tokens >= SCRIPT_RUN_COST) {
      cmd({ t: 'scriptTick', player: 0, id: 'free', actions: [{ type: 'farm', rate: 2 }, { type: 'contribute', structure: 'wall', amount: 1 }], gasUsed: 9 })
    }
    tick(live)
    if (i === 4) cmd({ t: 'chronicle', player: 0, kind: 'discovery', free: true, text: '[discovery] the surveyor’s bench — first uncovered by Ada' })
  }
  cmd({ t: 'end' })
  const replayed = replay(seed, log, live.tick)
  ok(stateHash(replayed) === stateHash(live), 'REPLAY IDENTITY holds with chronicle/spend/unverified-shared/end in the log')
  ok(snap(replayed) === snap(live), 'byte-identical snapshots (chronicle included in snap)')
  ok(replayed.chronicle.length === 2 && replayed.endedEarly, 'replays carry the chronicle and the early end')
}

// ── 20. GATE POLICY module: normalize + describe (the shared validator) ─────
{
  ok(normalizeGatePolicy(null) === null, 'null policy rejected')
  ok(normalizeGatePolicy('x') === null, 'non-object rejected')
  ok(normalizeGatePolicy({ shared: ['blastoff'] }) === null, 'unknown requirement rejected')
  ok(normalizeGatePolicy({ shared: 'oracle-green' }) === null, 'non-array scope rejected')
  const def = normalizeGatePolicy({})!
  ok(def.district.length === 0 && def.shared.length === 0, 'empty body = the default (none)')
  const p = normalizeGatePolicy({ shared: ['beta-pass', 'oracle-green', 'beta-pass'], district: [] })!
  ok(p.shared.length === 2 && p.shared[0] === 'oracle-green' && p.shared[1] === 'beta-pass', 'dedup + canonical order')
  ok(describeGatePolicy(defaultGatePolicy()).includes('none'), 'default policy speaks plainly')
  ok(describeGatePolicy(p).includes('oracle-green + beta-pass'), 'combo policy speaks plainly')
}

console.log(failCount === 0 ? `SMOKE OK — ${pass} assertions` : `SMOKE FAILED — ${failCount} failures (${pass} passed)`)
process.exit(failCount === 0 ? 0 : 1)
