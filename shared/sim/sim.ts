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
import type { Command, DraftTier, Script, ScriptSlot, SimState, Verdict, Workshop } from './types.ts'

export class RuleError extends Error {}
function fail(msg: string): never {
  throw new RuleError(msg)
}

// ── Game construction ────────────────────────────────────────────────────────

export function newGame(seed = 1, numPlayers = 1, names: string[] = []): SimState {
  const n = Math.max(1, numPlayers)
  return {
    seed,
    tick: 0,
    market: MARKET_BASE,
    gremlin: 0,
    players: Array.from({ length: n }, (_, i) => newWorkshop(names[i] ?? `Player ${i + 1}`)),
    events: [],
  }
}

function newWorkshop(name: string): Workshop {
  return {
    name,
    tokens: TOKEN_START,
    matter: 0,
    widgets: 0,
    widgetsShipped: 0,
    uptime: 0,
    waste: 0,
    scripts: [],
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
  const p = cmd.player ?? 0
  const w = s.players[p]
  if (!w) fail('no such player')
  switch (cmd.t) {
    case 'draftAccepted': {
      validateShape(cmd.script)
      const cost = draftCost(cmd.tier)
      if (w.scripts.length >= MAX_SCRIPTS) fail(`workshop is full (${MAX_SCRIPTS} scripts)`)
      if (w.scripts.some((sl) => sl.script.id === cmd.script.id)) fail(`duplicate script id '${cmd.script.id}'`)
      if (w.tokens < cost) fail(`not enough tokens (draft costs ${cost})`)
      w.tokens -= cost // the apprentice spends your tokens even on a hallucination
      w.scripts.push({
        script: cmd.script,
        armed: false,
        everGreen: false,
        yolo: false,
        status: 'drafted',
        lastVerdict: null,
      })
      s.events.push({ t: 'drafted', player: p, id: cmd.script.id, tier: cmd.tier })
      return
    }
    case 'oracleCheck': {
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
        s.events.push({ t: 'autoDisarm', player: p, id: cmd.id, reason: v.reasons[0] ?? 'oracle red' })
      }
      s.events.push({ t: 'oracle', player: p, id: cmd.id, ok: v.ok })
      return
    }
    case 'arm': {
      const slot = findSlot(w, cmd.id)
      if (slot.status === 'dead') fail(`script '${cmd.id}' is dead`)
      if (slot.status === 'blown') fail(`script '${cmd.id}' blew up`)
      if (slot.armed) fail(`script '${cmd.id}' is already armed`)
      slot.armed = true
      slot.status = 'armed'
      slot.yolo = !slot.everGreen // armed without an oracle pass = YOLO
      s.events.push({ t: 'armed', player: p, id: cmd.id, yolo: slot.yolo })
      return
    }
    case 'disarm': {
      const slot = findSlot(w, cmd.id)
      if (!slot.armed) fail(`script '${cmd.id}' is not armed`)
      slot.armed = false
      slot.status = 'disarmed'
      s.events.push({ t: 'disarmed', player: p, id: cmd.id })
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
  s.events.push({ t: 'misfire', player: p, id: slot.script.id, reason: v.reasons[0] ?? 'invalid script' })
}

export function tick(s: SimState): void {
  s.events = []
  s.tick++
  // world schedules
  const nextMarket = stepMarket(s.market, s.seed, s.tick)
  if (nextMarket !== s.market) {
    s.market = nextMarket
    s.events.push({ t: 'marketShift', market: s.market })
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
    for (const slot of w.scripts) {
      if (!slot.armed || !slot.everGreen) continue
      const v = staticCheck(slot.script)
      slot.lastVerdict = v
      if (!v.ok) {
        slot.armed = false
        slot.status = 'autoDisarmed'
        s.events.push({ t: 'autoDisarm', player: p, id: slot.script.id, reason: v.reasons[0] ?? 'oracle red' })
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
        w.matter = Math.max(0, w.matter - BOOST_BLOWUP_MATTER_LOSS)
        s.events.push({ t: 'blowup', player: p, id: slot.script.id })
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
          s.events.push({ t: 'corrupted', player: p, id: pick.script.id })
          // an oracle-green script auto-disarms on next tick's re-oracle
          // (protected); a YOLO script misfires (suffers publicly).
        }
      }
    }
    s.events.push({ t: 'gremlinSpike', pressure: s.gremlin, damage })
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/** widgets shipped + uptime − waste, weights in balance.ts. */
export function score(w: Workshop): number {
  return w.widgetsShipped * SCORE_PER_WIDGET + w.uptime * SCORE_PER_UPTIME - w.waste * SCORE_WASTE_MULT
}

// ── Replay identity helpers ──────────────────────────────────────────────────

/** Canonical serialization of everything replay must reproduce. */
export function snap(s: SimState): string {
  return JSON.stringify({
    seed: s.seed,
    tick: s.tick,
    market: s.market,
    gremlin: s.gremlin,
    players: s.players,
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
