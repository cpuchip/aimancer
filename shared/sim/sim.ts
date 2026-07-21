// AIMANCER — the deterministic simulation. One fixed tick over workshops,
// scripts, the market, and the gremlin. Pure: no Date.now, no Math.random —
// all randomness is hashNoise(seed, tick, salt). state(t) = f(seed, commands
// up to t). Architecture adapted from kernel-panic shared/sim/sim.ts
// (newGame/apply/tick + RuleError), reshaped for workshops.

import {
  BOOST_BLOWUP_MATTER_LOSS,
  BOOST_BLOWUP_WASTE,
  BOOST_RISK_PER_STEP,
  CORRUPT_THRESHOLD,
  DEAD_SCRIPT_WASTE,
  DRAFT_COST_CHEAP,
  DRAFT_COST_SMART,
  MARKET_BASE,
  MAX_SCRIPTS,
  ORACLE_COST,
  SCORE_PER_UPTIME,
  SCORE_PER_WIDGET,
  SCORE_WASTE_MULT,
  SCRAP_COST,
  SPIKE_BUGGY_EXTRA,
  TOKEN_CAP,
  TOKEN_REGEN,
  TOKEN_START,
} from './balance.ts'
import { flawScript } from './flaws.ts'
import { hashNoise, saltOf, SALT_CORRUPT_FLAW, SALT_CORRUPT_PICK } from './noise.ts'
import { staticCheck } from './oracle.ts'
import { condPasses, pressureAt, runVerb, spikeAt, stepMarket } from './world.ts'
import { mulberry32 } from '../rng.ts'
import { PHASE_NEXT } from './types.ts'
import type {
  Command,
  DraftTier,
  PhaseTicks,
  PlayerRoundStats,
  RevealDelta,
  RoundSummary,
  Script,
  ScriptSlot,
  SimEvent,
  SimState,
  Verdict,
  Workshop,
} from './types.ts'

export class RuleError extends Error {}
function fail(msg: string): never {
  throw new RuleError(msg)
}

/** Every event goes through here so eventSeq (the feed's dedup watermark)
 * can never drift from the array. */
function emit(s: SimState, e: SimEvent): void {
  s.events.push(e)
  s.eventSeq++
}

// ── Game construction ────────────────────────────────────────────────────────

export function newGame(seed = 1, numPlayers = 1, names: string[] = [], phaseTicks?: Partial<PhaseTicks>): SimState {
  const n = Math.max(1, numPlayers)
  return {
    seed,
    tick: 0,
    phase: 'round1',
    phaseTicks: { round1: phaseTicks?.round1 ?? 0, round2: phaseTicks?.round2 ?? 0 },
    market: MARKET_BASE,
    gremlin: 0,
    players: Array.from({ length: n }, (_, i) => newWorkshop(names[i] ?? `Player ${i + 1}`)),
    events: [],
    eventSeq: 0,
    round1Summary: null,
    round2Summary: null,
  }
}

function newWorkshop(name: string): Workshop {
  return {
    name,
    tokens: TOKEN_START,
    matter: 0,
    widgets: 0,
    widgetsSold: 0,
    disasters: 0,
    uptime: 0,
    waste: 0,
    scripts: [],
    pending: [],
  }
}

// ── Phases ───────────────────────────────────────────────────────────────────

/** Do world ticks run right now? False in intermission/reveal (frozen) and
 * when the current round's tick budget is spent (waiting on the host). */
export function ticksRunning(s: SimState): boolean {
  if (s.phase !== 'round1' && s.phase !== 'round2') return false
  const budget = s.phaseTicks[s.phase]
  return budget <= 0 || s.tick < budget
}

/** Countdown for the board. null = unlimited round; 0 = frozen/spent. */
export function ticksRemaining(s: SimState): number | null {
  if (s.phase !== 'round1' && s.phase !== 'round2') return 0
  const budget = s.phaseTicks[s.phase]
  if (budget <= 0) return null
  return Math.max(0, budget - s.tick)
}

function summarize(s: SimState): RoundSummary {
  const players: PlayerRoundStats[] = s.players.map((w) => ({
    name: w.name,
    score: score(w),
    widgetsSold: w.widgetsSold,
    disasters: w.disasters,
    waste: w.waste,
    uptime: w.uptime,
  }))
  const totals = players.reduce(
    (acc, p) => ({
      score: acc.score + p.score,
      widgetsSold: acc.widgetsSold + p.widgetsSold,
      disasters: acc.disasters + p.disasters,
      waste: acc.waste + p.waste,
    }),
    { score: 0, widgetsSold: 0, disasters: 0, waste: 0 },
  )
  return { atTick: s.tick, players, totals }
}

/** Round 2's level playing field: fresh world, SAME seed (schedules are
 * f(seed, tick), and tick resets — so round 2 replays round 1's market and
 * gremlin schedule exactly). Players keep their names, their un-played
 * drafts (the hand they stocked during intermission), AND their in-flight
 * apprentice requests (paid escrow — the drafts land in the round-2 hand);
 * everything else resets. */
function reseedRound2(s: SimState): void {
  s.tick = 0
  s.market = MARKET_BASE
  s.gremlin = 0
  for (const w of s.players) {
    w.tokens = TOKEN_START
    w.matter = 0
    w.widgets = 0
    w.widgetsSold = 0
    w.disasters = 0
    w.uptime = 0
    w.waste = 0
    w.scripts = w.scripts
      .filter((sl) => sl.status === 'drafted')
      .map((sl) => ({ script: sl.script, armed: false, everGreen: false, yolo: false, status: 'drafted' as const, lastVerdict: null }))
    // w.pending carries as-is: the request was paid, the drafts are still owed
  }
}

/** The reveal's headline: round 2 minus round 1, per player and for the room. */
export function computeDelta(s: SimState): RevealDelta | null {
  const r1 = s.round1Summary
  const r2 = s.round2Summary
  if (!r1 || !r2) return null
  const players = r1.players.map((p1, i) => {
    const p2 = r2.players[i]
    return {
      name: p1.name,
      r1: p1,
      r2: p2,
      dScore: p2.score - p1.score,
      dWidgetsSold: p2.widgetsSold - p1.widgetsSold,
      dDisasters: p2.disasters - p1.disasters,
      dWaste: p2.waste - p1.waste,
    }
  })
  return {
    players,
    totals: {
      score: r2.totals.score - r1.totals.score,
      widgetsSold: r2.totals.widgetsSold - r1.totals.widgetsSold,
      disasters: r2.totals.disasters - r1.totals.disasters,
      waste: r2.totals.waste - r1.totals.waste,
      r1Score: r1.totals.score,
      r2Score: r2.totals.score,
    },
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

function findSlot(w: Workshop, id: string): ScriptSlot {
  const slot = w.scripts.find((sl) => sl.script.id === id)
  if (!slot) fail(`no script '${id}' in this workshop`)
  return slot
}

/** Structural validation only — shapes and types. A subtly-WRONG script (bad
 * param name, unknown verb, off-by-10x value) passes here on purpose: drafts
 * are allowed to be hallucinated; the ORACLE is what catches them. */
export function validateShape(script: Script): void {
  if (typeof script !== 'object' || script === null) fail('script must be an object')
  if (typeof script.id !== 'string' || script.id.length < 1 || script.id.length > 32) fail('script.id must be a 1-32 char string')
  if (typeof script.verb !== 'string') fail('script.verb must be a string')
  if (typeof script.params !== 'object' || script.params === null || Array.isArray(script.params)) fail('script.params must be an object')
  for (const [k, v] of Object.entries(script.params)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`param '${k}' must be a finite number`)
  }
  if (script.when !== undefined) {
    const c = script.when
    if (typeof c !== 'object' || c === null) fail('when must be an object')
    if (typeof c.field !== 'string') fail('when.field must be a string')
    if (typeof c.op !== 'string') fail('when.op must be a string')
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) fail('when.value must be a finite number')
  }
}

export function draftCost(tier: DraftTier): number {
  return tier === 'smart' ? DRAFT_COST_SMART : DRAFT_COST_CHEAP
}

export function apply(s: SimState, cmd: Command): void {
  // the reveal is a full stop — the delta board tells the story now
  if (s.phase === 'reveal' && cmd.t !== 'phase') fail('the game is over — the delta board tells the story now')
  const p = 'player' in cmd ? (cmd.player ?? 0) : 0
  const w = s.players[p]
  if (!w) fail('no such player')
  switch (cmd.t) {
    case 'draftRequested': {
      // pay NOW — the apprentice bills up front, drafts arrive when they arrive
      if (typeof cmd.reqId !== 'string' || cmd.reqId.length < 1 || cmd.reqId.length > 40) fail('reqId must be a 1-40 char string')
      if (w.pending.some((pd) => pd.reqId === cmd.reqId)) fail(`duplicate request id '${cmd.reqId}'`)
      if (w.scripts.length >= MAX_SCRIPTS) fail(`workshop is full (${MAX_SCRIPTS} scripts) — scrap something first`)
      const cost = draftCost(cmd.tier)
      if (w.tokens < cost) fail(`not enough tokens (a ${cmd.tier} draft costs ${cost})`)
      w.tokens -= cost
      w.pending.push({ reqId: cmd.reqId, tier: cmd.tier })
      emit(s, { t: 'draftRequested', player: p, tier: cmd.tier })
      return
    }
    case 'draftAccepted': {
      validateShape(cmd.script)
      if (w.scripts.length >= MAX_SCRIPTS) fail(`workshop is full (${MAX_SCRIPTS} scripts)`)
      if (w.scripts.some((sl) => sl.script.id === cmd.script.id)) fail(`duplicate script id '${cmd.script.id}'`)
      if (cmd.reqId !== undefined) {
        // an async delivery — already paid at draftRequested; escrow must exist
        if (!w.pending.some((pd) => pd.reqId === cmd.reqId)) fail(`no pending draft request '${cmd.reqId}'`)
      } else {
        const cost = draftCost(cmd.tier)
        if (w.tokens < cost) fail(`not enough tokens (draft costs ${cost})`)
        w.tokens -= cost // the apprentice spends your tokens even on a hallucination
      }
      w.scripts.push({
        script: cmd.script,
        armed: false,
        everGreen: false,
        yolo: false,
        status: 'drafted',
        lastVerdict: null,
      })
      emit(s, { t: 'drafted', player: p, id: cmd.script.id, tier: cmd.tier })
      return
    }
    case 'draftSettled': {
      // the batch is fully delivered — close the escrow, nothing to refund
      const i = w.pending.findIndex((pd) => pd.reqId === cmd.reqId)
      if (i < 0) fail(`no pending draft request '${cmd.reqId}'`)
      w.pending.splice(i, 1)
      return
    }
    case 'draftFailed': {
      // the apprentice came back empty (timeout, gibberish, full hand) — refund
      const i = w.pending.findIndex((pd) => pd.reqId === cmd.reqId)
      if (i < 0) fail(`no pending draft request '${cmd.reqId}'`)
      const [pd] = w.pending.splice(i, 1)
      const refund = draftCost(pd.tier)
      w.tokens = Math.min(TOKEN_CAP, w.tokens + refund)
      emit(s, { t: 'draftFailed', player: p, tier: pd.tier, refund })
      return
    }
    case 'oracleCheck': {
      // ROUND 1 IS NAIVE: the oracle does not exist yet — a rule, not UI hiding.
      if (s.phase !== 'round2') fail("the oracle hasn't been invented yet — round 2 unlocks it")
      const slot = findSlot(w, cmd.id)
      if (w.tokens < ORACLE_COST) fail(`not enough tokens (oracle costs ${ORACLE_COST})`)
      w.tokens -= ORACLE_COST
      const v = staticCheck(slot.script)
      slot.lastVerdict = v
      if (v.ok) {
        slot.everGreen = true // earned auto-renew
        if (slot.armed) slot.yolo = false // an armed YOLO script, verified after the fact
      } else if (slot.armed) {
        // the oracle is the switch — a red verdict on an armed script disarms it
        slot.armed = false
        slot.status = 'autoDisarmed'
        emit(s, { t: 'autoDisarm', player: p, id: cmd.id, reason: v.reasons[0] ?? 'oracle red' })
      }
      emit(s, { t: 'oracle', player: p, id: cmd.id, ok: v.ok })
      return
    }
    case 'arm': {
      // the world is frozen between rounds; an intermission arm would silently
      // vanish in the round-2 reset — refuse it up front, in plain words
      if (s.phase === 'intermission') fail('the world is frozen for the intermission — arming waits for round 2')
      const slot = findSlot(w, cmd.id)
      if (slot.status === 'dead') fail(`script '${cmd.id}' is dead`)
      if (slot.status === 'blown') fail(`script '${cmd.id}' blew up`)
      if (slot.armed) fail(`script '${cmd.id}' is already armed`)
      slot.armed = true
      slot.status = 'armed'
      slot.yolo = !slot.everGreen // armed without an oracle pass = YOLO
      emit(s, { t: 'armed', player: p, id: cmd.id, yolo: slot.yolo })
      return
    }
    case 'disarm': {
      const slot = findSlot(w, cmd.id)
      if (!slot.armed) fail(`script '${cmd.id}' is not armed`)
      slot.armed = false
      slot.status = 'disarmed'
      emit(s, { t: 'disarmed', player: p, id: cmd.id })
      return
    }
    case 'scrap': {
      const slot = findSlot(w, cmd.id)
      if (slot.armed) fail(`script '${cmd.id}' is armed — disarm it before scrapping`)
      if (w.tokens < SCRAP_COST) fail(`not enough tokens (scrap costs ${SCRAP_COST})`)
      w.tokens -= SCRAP_COST
      w.scripts = w.scripts.filter((sl) => sl !== slot)
      emit(s, { t: 'scrapped', player: p, id: cmd.id })
      return
    }
    case 'phase': {
      const next = PHASE_NEXT[s.phase]
      if (!next) fail('there is nothing after the reveal')
      if (cmd.to !== next) fail(`from ${s.phase} the only advance is ${next}`)
      if (next === 'intermission') s.round1Summary = summarize(s)
      if (next === 'round2') reseedRound2(s)
      if (next === 'reveal') s.round2Summary = summarize(s)
      s.phase = next
      emit(s, { t: 'phase', phase: next })
      return
    }
  }
}

// ── The tick ─────────────────────────────────────────────────────────────────

function misfire(s: SimState, w: Workshop, p: number, slot: ScriptSlot, v: Verdict): void {
  slot.armed = false
  slot.status = 'dead'
  slot.lastVerdict = v
  w.waste += DEAD_SCRIPT_WASTE
  w.disasters++
  emit(s, { t: 'misfire', player: p, id: slot.script.id, reason: v.reasons[0] ?? 'invalid script' })
}

export function tick(s: SimState): void {
  // frozen phases and spent round budgets: the world holds still (no-op, so a
  // replay may tick freely — extra ticks cannot desync it)
  if (!ticksRunning(s)) return
  s.events = []
  s.tick++
  // world schedules
  const nextMarket = stepMarket(s.market, s.seed, s.tick)
  if (nextMarket !== s.market) {
    s.market = nextMarket
    emit(s, { t: 'marketShift', market: s.market })
  }
  s.gremlin = pressureAt(s.tick)

  const patchTotals: number[] = []
  const buggyCounts: number[] = []

  for (let p = 0; p < s.players.length; p++) {
    const w = s.players[p]
    // token regen — the rate limit refills
    w.tokens = Math.min(TOKEN_CAP, w.tokens + TOKEN_REGEN)

    // pass 1: auto-renew — every oracle-green armed script gets a FREE per-tick
    // re-oracle; a red verdict AUTO-DISARMS (the oracle is the switch, literal).
    // ROUND 2 ONLY: in the naive round nothing can be verified, so nothing renews.
    for (const slot of w.scripts) {
      if (s.phase !== 'round2') break
      if (!slot.armed || !slot.everGreen) continue
      const v = staticCheck(slot.script)
      slot.lastVerdict = v
      if (!v.ok) {
        slot.armed = false
        slot.status = 'autoDisarmed'
        emit(s, { t: 'autoDisarm', player: p, id: slot.script.id, reason: v.reasons[0] ?? 'oracle red' })
      }
    }

    // pass 2: YOLO scripts run unwatched — an invalid one MISFIRES publicly.
    for (const slot of w.scripts) {
      if (!slot.armed || slot.everGreen) continue
      const v = staticCheck(slot.script)
      if (!v.ok) misfire(s, w, p, slot, v)
    }

    // pass 3: boost resolution — surviving armed boosts set the multiplier
    // (max, not product), each with a seeded blowup roll that scales with mult.
    let mult = 1
    for (const slot of w.scripts) {
      if (!slot.armed || slot.script.verb !== 'boost') continue
      if (!condPasses(s, w, slot.script.when)) continue
      const m = slot.script.params['mult']
      const roll = hashNoise(s.seed, s.tick, saltOf(`${p}:${slot.script.id}`)) % 65536
      if (roll < (m - 1) * BOOST_RISK_PER_STEP) {
        slot.armed = false
        slot.status = 'blown'
        w.waste += BOOST_BLOWUP_WASTE
        w.disasters++
        w.matter = Math.max(0, w.matter - BOOST_BLOWUP_MATTER_LOSS)
        emit(s, { t: 'blowup', player: p, id: slot.script.id })
        continue
      }
      mult = Math.max(mult, m)
      w.uptime += 1
    }

    // pass 4: the other verbs execute in slot order (deterministic)
    let patchTotal = 0
    let buggy = 0
    for (const slot of w.scripts) {
      if (!slot.armed) continue
      if (slot.yolo) buggy++ // unverified armed scripts are the gremlin's attack surface
      if (slot.script.verb === 'boost') continue // already handled
      if (!condPasses(s, w, slot.script.when)) continue
      patchTotal += runVerb(s, w, slot.script, mult)
      w.uptime += 1
    }
    patchTotals.push(patchTotal)
    buggyCounts.push(buggy)
  }

  // gremlin spike: one shared roll; damage lands per workshop — unpatched and
  // YOLO-heavy workshops suffer hardest, and heavy damage CORRUPTS a script.
  if (spikeAt(s.seed, s.tick, s.gremlin)) {
    const damage: number[] = []
    for (let p = 0; p < s.players.length; p++) {
      const w = s.players[p]
      const dealt = Math.max(0, s.gremlin + SPIKE_BUGGY_EXTRA * buggyCounts[p] - patchTotals[p])
      damage.push(dealt)
      if (dealt > 0) {
        w.waste += dealt
        const fromMatter = Math.min(w.matter, dealt)
        w.matter -= fromMatter
        w.widgets -= Math.min(w.widgets, dealt - fromMatter)
      }
      if (dealt >= CORRUPT_THRESHOLD) {
        const armed = w.scripts.filter((sl) => sl.armed)
        if (armed.length > 0) {
          const pick = armed[hashNoise(s.seed, s.tick, SALT_CORRUPT_PICK + p * 7919) % armed.length]
          const prng = mulberry32(hashNoise(s.seed, s.tick, SALT_CORRUPT_FLAW + p * 7919))
          pick.script = flawScript(pick.script, prng).script // same id, subtly broken
          w.disasters++
          emit(s, { t: 'corrupted', player: p, id: pick.script.id })
          // an oracle-green script auto-disarms on next tick's re-oracle
          // (protected); a YOLO script misfires (suffers publicly).
        }
      }
    }
    emit(s, { t: 'gremlinSpike', pressure: s.gremlin, damage })
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/** widgets SOLD + uptime − waste, weights in balance.ts. */
export function score(w: Workshop): number {
  return w.widgetsSold * SCORE_PER_WIDGET + w.uptime * SCORE_PER_UPTIME - w.waste * SCORE_WASTE_MULT
}

// ── Replay identity helpers ──────────────────────────────────────────────────

/** Canonical serialization of everything replay must reproduce. */
export function snap(s: SimState): string {
  return JSON.stringify({
    seed: s.seed,
    tick: s.tick,
    phase: s.phase,
    phaseTicks: s.phaseTicks,
    market: s.market,
    gremlin: s.gremlin,
    players: s.players,
    round1Summary: s.round1Summary,
    round2Summary: s.round2Summary,
  })
}

/** FNV-1a hash of the snapshot — the replay-identity fingerprint. */
export function stateHash(s: SimState): string {
  const str = snap(s)
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
