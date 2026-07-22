// AIMANCER — the deterministic ARK simulation. One shared settlement,
// continuous ticks, drop-in dyads, storms on a seeded schedule, milestones,
// and the launch. Pure: no Date.now, no Math.random — all randomness is
// hashNoise(seed, tick, salt). state(t) = f(seed, commands up to t).
//
// THE ENGINE IS OUTSIDE. Deployed Starlark runs in the Go engine subprocess
// (server-side); its emitted actions enter the log as DATA (`scriptTick`).
// The sim validates and applies actions — it never runs Starlark. Replays
// re-apply actions; engine faults are seat faults, never replay state.

import {
  ACTIONS_PER_TICK_MAX,
  CHRONICLE_COST,
  CHRONICLE_EVIDENCE_LEN_MAX,
  CHRONICLE_EVIDENCE_MAX,
  CHRONICLE_MAX_ENTRIES,
  CHRONICLE_RELATES_MAX,
  CHRONICLE_TEXT_MAX,
  DEPLOY_COST,
  DISTRICT_INTEGRITY_MAX,
  MAX_DYADS,
  ORACLE_COST,
  SCRIPT_KILL_THRESHOLD,
  SCRIPT_RUN_COST,
  SCRIPT_SLOTS_BASE,
  SCRIPT_SLOTS_MAX,
  SOURCE_MAX_BYTES,
  STORM_UNVERIFIED_EXTRA,
  STORM_WARN_TICKS,
  SURVIVOR_FOOD_COST,
  SURVIVOR_PERIOD,
  SURVIVORS_MAX,
  SURVIVORS_PER_SLOT,
  TOKEN_CAP,
  TOKEN_REGEN,
  TOKEN_START,
  VEIN_ID_MAX,
} from './balance.ts'
import { hashNoise, SALT_STORM_KILL } from './noise.ts'
import { newStructures, nextStorm, runAction, spawnVein, stormAt, stormSpec, veinSpec } from './world.ts'
import type { Action, Command, DeployedScript, Dyad, EndStats, ScriptScope, SimEvent, SimState, StructureKind } from './types.ts'

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

// ── Game construction ───────────────────────────────────────────────────────

function initialVeins(seed: number): SimState['veins'] {
  const veins: SimState['veins'] = []
  for (let k = 1; k <= VEIN_ID_MAX; k++) {
    if (veinSpec(seed, k).spawnTick === 0) veins.push(spawnVein(seed, k))
    else break
  }
  return veins
}

/** A settlement starts EMPTY and GATHERING — dyads drop in via the logged
 * joinDistrict command (replays reproduce the exact join order and timing),
 * and the world holds still until the host's logged `start` command. */
export function newGame(seed = 1): SimState {
  return {
    seed,
    tick: 0,
    started: false,
    dyads: [],
    veins: initialVeins(seed),
    structures: newStructures(),
    granaryFood: 0,
    survivors: 0,
    launched: false,
    endedEarly: false,
    end: null,
    chronicle: [],
    events: [],
    eventSeq: 0,
  }
}

function newDyad(name: string, district: number, tick: number): Dyad {
  return {
    name,
    district,
    tokens: TOKEN_START,
    ore: 0,
    food: 0,
    parts: 0,
    contributed: 0,
    integrity: DISTRICT_INTEGRITY_MAX,
    stormDamage: 0,
    scripts: [],
    joinedAtTick: tick,
    vote: null,
  }
}

// ── Capacity + lifecycle helpers ────────────────────────────────────────────

/** Deployed-script slots per dyad — survivors raise it for EVERYONE. */
export function scriptSlots(s: SimState): number {
  return Math.min(SCRIPT_SLOTS_MAX, SCRIPT_SLOTS_BASE + Math.floor(s.survivors / SURVIVORS_PER_SLOT))
}

/** The world runs only after the host's opening bell (`start`), while at
 * least one dyad is seated, and until the ark leaves. Before the bell the
 * settlement GATHERS: frozen world, open doors. */
export function ticksRunning(s: SimState): boolean {
  return s.started && s.dyads.length > 0 && !s.launched
}

export function goVotes(s: SimState): number {
  return s.dyads.filter((d) => d.vote === true).length
}

/** Majority = GO votes strictly exceed half of ALL seated dyads. */
export function launchMajority(s: SimState): boolean {
  return goVotes(s) * 2 > s.dyads.length
}

function findScript(d: Dyad, id: string): DeployedScript {
  const sc = d.scripts.find((x) => x.id === id)
  if (!sc) fail(`no script '${id}' in this district`)
  return sc
}

// ── Commands ────────────────────────────────────────────────────────────────

const VALID_SCOPES: readonly ScriptScope[] = ['district', 'shared']

export function apply(s: SimState, cmd: Command): void {
  if (s.launched && cmd.t !== 'joinDistrict') fail('the ark has launched — the story is told')
  switch (cmd.t) {
    case 'joinDistrict': {
      if (s.launched) fail('the ark has launched — this settlement is history now')
      if (s.dyads.length >= MAX_DYADS) fail(`the settlement is full (${MAX_DYADS} districts)`)
      const name = (cmd.name || '').trim().slice(0, 16) || `Dyad ${s.dyads.length + 1}`
      const district = s.dyads.length
      s.dyads.push(newDyad(name, district, s.tick))
      emit(s, { t: 'joined', dyad: district, name, district })
      return
    }
    case 'start': {
      // THE OPENING BELL — host act (server-enforced host-hinge). Gathering
      // ends; ticks/storms/regen begin. Logged: replays carry the bell.
      if (s.started) fail('the world is already running')
      if (s.dyads.length === 0) fail('no dyads seated — the bell rings for someone')
      s.started = true
      emit(s, { t: 'started' })
      return
    }
    default:
      break
  }

  const p = 'player' in cmd ? (cmd.player ?? 0) : 0
  const d = s.dyads[p]
  if (!d) fail('no such dyad')

  switch (cmd.t) {
    case 'deploy': {
      if (typeof cmd.id !== 'string' || cmd.id.length < 1 || cmd.id.length > 32) fail('script id must be a 1-32 char string')
      if (typeof cmd.source !== 'string' || cmd.source.trim().length === 0) fail('script source must be non-empty Starlark')
      if (cmd.source.length > SOURCE_MAX_BYTES) fail(`script source too large (${cmd.source.length} bytes, max ${SOURCE_MAX_BYTES})`)
      if (!VALID_SCOPES.includes(cmd.scope)) fail(`scope must be 'district' or 'shared'`)
      // FREEDOM UPDATE: no server-imposed verification on ANY scope. An
      // unverified shared deploy is representable and legal — the seat's OWN
      // gate policy (server-side, human-owned) is the only deploy gate, and
      // the storm still prices unverified work. verified arrives as data when
      // a policy (or a paid check) ran the oracle.
      const existing = d.scripts.find((x) => x.id === cmd.id)
      if (existing && existing.status === 'running') fail(`script '${cmd.id}' is already deployed — undeploy it first`)
      const running = d.scripts.filter((x) => x.status === 'running').length
      if (running >= scriptSlots(s)) fail(`no free script slots (${running}/${scriptSlots(s)} — survivors raise capacity)`)
      if (d.tokens < DEPLOY_COST) fail(`not enough ⚡ (deploy costs ${DEPLOY_COST})`)
      d.tokens -= DEPLOY_COST
      const name = (cmd.name || '').trim().slice(0, 24) || cmd.id
      const script: DeployedScript = {
        id: cmd.id,
        name,
        source: cmd.source,
        scope: cmd.scope,
        verified: cmd.verified === true,
        lastVerdict: cmd.verdict ?? null,
        status: 'running',
        deployedAtTick: s.tick,
        lastTick: null,
        errStreak: 0,
      }
      if (existing) d.scripts[d.scripts.indexOf(existing)] = script // redeploy replaces the record
      else d.scripts.push(script)
      // keep the record bounded: prune oldest non-running beyond twice the cap
      while (d.scripts.length > SCRIPT_SLOTS_MAX * 2) {
        const idx = d.scripts.findIndex((x) => x.status !== 'running')
        if (idx < 0) break
        d.scripts.splice(idx, 1)
      }
      emit(s, { t: 'deployed', dyad: p, id: script.id, name, scope: script.scope, verified: script.verified })
      return
    }
    case 'undeploy': {
      const sc = findScript(d, cmd.id)
      if (sc.status !== 'running') fail(`script '${cmd.id}' is not running`)
      sc.status = 'stopped'
      emit(s, { t: 'undeployed', dyad: p, id: cmd.id })
      return
    }
    case 'oracleResult': {
      const sc = findScript(d, cmd.id)
      if (d.tokens < ORACLE_COST) fail(`not enough ⚡ (an oracle check costs ${ORACLE_COST})`)
      d.tokens -= ORACLE_COST
      sc.lastVerdict = { ok: cmd.ok, reasons: cmd.reasons }
      sc.verified = cmd.ok // the oracle is the switch — red closes the gate again
      emit(s, { t: 'oracle', dyad: p, id: cmd.id, ok: cmd.ok })
      return
    }
    case 'scriptTick': {
      const sc = findScript(d, cmd.id)
      if (sc.status !== 'running') fail(`script '${cmd.id}' is not running`)
      // starved (server skipped the engine) or can't afford at apply time —
      // both deterministic from the same state
      if (cmd.starved || d.tokens < SCRIPT_RUN_COST) {
        sc.lastTick = { tick: s.tick, ran: false, note: `starved — needs ${SCRIPT_RUN_COST}⚡`, gasUsed: 0, err: null, logs: [], dTokens: 0, dOre: 0, dFood: 0, dParts: 0, dContributed: 0 }
        return
      }
      const t0 = d.tokens
      d.tokens -= SCRIPT_RUN_COST
      if (cmd.err) {
        // engine error value: the run failed — partial actions are DISCARDED
        sc.errStreak++
        const reason = cmd.err.split('\n')[0].slice(0, 160)
        sc.lastTick = { tick: s.tick, ran: false, note: `error: ${reason}`, gasUsed: cmd.gasUsed, err: cmd.err.slice(0, 2000), logs: (cmd.logs ?? []).slice(0, 10), dTokens: d.tokens - t0, dOre: 0, dFood: 0, dParts: 0, dContributed: 0 }
        emit(s, { t: 'scriptError', dyad: p, id: cmd.id, reason })
        return
      }
      sc.errStreak = 0
      // FREEDOM UPDATE: scope IS the boundary — a shared-scope deployment may
      // touch the shared works whether or not it is verified (verification is
      // storm armor + your own gate's evidence, no longer a runtime lock).
      // District scripts stay in the district: that's what scope MEANS.
      const gated = sc.scope === 'shared'
      const ore0 = d.ore
      const food0 = d.food
      const parts0 = d.parts
      const notes: string[] = []
      let contributedNow = 0
      let gateRefusedOnce = false
      const contributions = new Map<StructureKind, number>()
      const actions = cmd.actions.slice(0, ACTIONS_PER_TICK_MAX)
      if (cmd.actions.length > ACTIONS_PER_TICK_MAX) notes.push(`(+${cmd.actions.length - ACTIONS_PER_TICK_MAX} actions dropped — cap ${ACTIONS_PER_TICK_MAX}/tick)`)
      for (const a of actions as Action[]) {
        const veinBefore = a.type === 'gather' ? s.veins.find((v) => v.id === (typeof a['node'] === 'number' ? a['node'] : -1)) : undefined
        const hadReserve = veinBefore ? veinBefore.reserve > 0 : false
        const out = runAction(s, d, a, gated)
        notes.push(out.note)
        if (!out.applied && out.note.startsWith('GATE:') && !gateRefusedOnce) {
          gateRefusedOnce = true
          emit(s, { t: 'gateRefused', dyad: p, id: cmd.id, reason: out.note })
        }
        if (veinBefore && hadReserve && veinBefore.reserve <= 0) emit(s, { t: 'veinExhausted', id: veinBefore.id })
        if (out.contributed) {
          contributedNow += out.contributed
          const kind = a['structure'] as StructureKind
          contributions.set(kind, (contributions.get(kind) ?? 0) + out.contributed)
        }
        if (out.completed) emit(s, { t: 'milestone', structure: out.completed })
      }
      for (const [kind, amount] of contributions) emit(s, { t: 'contributed', dyad: p, structure: kind, amount })
      sc.lastTick = {
        tick: s.tick,
        ran: true,
        note: notes.slice(0, 4).join(' · ') || 'no actions',
        gasUsed: cmd.gasUsed,
        err: null,
        logs: (cmd.logs ?? []).slice(0, 10),
        dTokens: d.tokens - t0,
        dOre: d.ore - ore0,
        dFood: d.food - food0,
        dParts: d.parts - parts0,
        dContributed: contributedNow,
      }
      return
    }
    case 'vote': {
      if (!s.structures.ark.complete) fail('the ark is not built yet — the vote opens when it is')
      d.vote = cmd.go === true
      emit(s, { t: 'voteCast', dyad: p, go: d.vote })
      return
    }
    case 'spend': {
      // A ⚡ debit for a server-side service (beta runs). The service itself
      // is a query and never enters the log; the economy must replay.
      const amount = typeof cmd.amount === 'number' && Number.isFinite(cmd.amount) ? Math.floor(cmd.amount) : 0
      if (amount < 1) fail('spend amount must be a positive integer')
      if (d.tokens < amount) fail(`not enough ⚡ (${cmd.reason || 'this'} costs ${amount})`)
      d.tokens -= amount
      return
    }
    case 'chronicle': {
      const kind: 'claim' | 'discovery' = cmd.kind === 'discovery' ? 'discovery' : 'claim'
      const text = (cmd.text ?? '').trim().replace(/\s+/g, ' ')
      if (text.length === 0) fail('the chronicle refuses empty entries')
      if (text.length > CHRONICLE_TEXT_MAX) fail(`chronicle entry too long (${text.length} chars, max ${CHRONICLE_TEXT_MAX})`)
      if (s.chronicle.length >= CHRONICLE_MAX_ENTRIES) fail(`the chronicle is full (${CHRONICLE_MAX_ENTRIES} entries) — the book closes`)
      // novelty dedupe: an exact duplicate (case-insensitive, whitespace-
      // collapsed) adds nothing to the collective memory
      const norm = text.toLowerCase()
      if (s.chronicle.some((e) => e.text.toLowerCase() === norm)) fail('the chronicle already holds that exact claim — relate to it, or say something new')
      const evidence = (Array.isArray(cmd.evidence) ? cmd.evidence : [])
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .slice(0, CHRONICLE_EVIDENCE_MAX)
        .map((x) => x.trim().slice(0, CHRONICLE_EVIDENCE_LEN_MAX))
      const relatesTo = (Array.isArray(cmd.relatesTo) ? cmd.relatesTo : [])
        .filter((x): x is number => typeof x === 'number' && Number.isInteger(x))
        .slice(0, CHRONICLE_RELATES_MAX)
      for (const rid of relatesTo) {
        if (rid < 1 || rid > s.chronicle.length) fail(`relates-to #${rid} does not exist in the chronicle`)
      }
      if (!cmd.free) {
        if (d.tokens < CHRONICLE_COST) fail(`not enough ⚡ (a chronicle claim costs ${CHRONICLE_COST})`)
        d.tokens -= CHRONICLE_COST
      }
      const entry = { id: s.chronicle.length + 1, author: p, kind, text, evidence, relatesTo, atTick: s.tick }
      s.chronicle.push(entry)
      emit(s, { t: 'chronicle', dyad: p, id: entry.id, kind, snippet: text.slice(0, 80) })
      return
    }
    case 'launch': {
      if (!s.structures.ark.complete) fail('the ark is not built yet')
      if (!launchMajority(s)) fail(`no majority — ${goVotes(s)} GO of ${s.dyads.length} dyads (need more than half)`)
      s.launched = true
      s.end = computeEndStats(s)
      emit(s, { t: 'launch', goVotes: goVotes(s), dyads: s.dyads.length })
      return
    }
    case 'end': {
      // The host calls the game (anti-immortal-rooms). The world rests, end
      // stats are captured AS THEY STAND, the books open — no launch.
      s.launched = true
      s.endedEarly = true
      s.end = computeEndStats(s)
      emit(s, { t: 'ended' })
      return
    }
  }
}

// ── The tick (world evolution only — actions arrive as commands) ────────────

export function tick(s: SimState): void {
  if (!ticksRunning(s)) return
  s.events = []
  s.tick++

  // token regen — every dyad's rate limit refills
  for (const d of s.dyads) d.tokens = Math.min(TOKEN_CAP, d.tokens + TOKEN_REGEN)

  // vein spawns (ids strictly ordered — next candidate is veins.length + 1)
  for (let k = s.veins.length + 1; k <= VEIN_ID_MAX; k++) {
    const spec = veinSpec(s.seed, k)
    if (spec.spawnTick > s.tick) break
    s.veins.push(spawnVein(s.seed, k))
    emit(s, { t: 'veinSpawned', id: k, rate: spec.rate, reserve: spec.reserveMax })
  }

  // storm warning — the feed's drumbeat (the countdown itself is in the view)
  const coming = nextStorm(s.seed, s.tick)
  if (coming.tick - s.tick === STORM_WARN_TICKS) {
    emit(s, { t: 'stormWarning', index: coming.index, inTicks: STORM_WARN_TICKS, severity: coming.severity })
  }

  // storm landing: the wall absorbs for EVERYONE; overflow hits every
  // district; unverified running scripts are each district's attack surface
  const storm = stormAt(s.seed, s.tick)
  if (storm) {
    const wall = s.structures.wall
    const absorbed = Math.min(wall.hp, storm.severity)
    wall.hp -= absorbed
    const overflow = storm.severity - absorbed
    const damage: number[] = []
    for (let p = 0; p < s.dyads.length; p++) {
      const d = s.dyads[p]
      const unverified = d.scripts.filter((sc) => sc.status === 'running' && !sc.verified)
      const hit = overflow + STORM_UNVERIFIED_EXTRA * unverified.length
      damage.push(hit)
      if (hit > 0) {
        d.integrity = Math.max(0, d.integrity - hit)
        d.stormDamage += hit
        // stock scorch: ore burns first, then food, then parts
        let left = hit
        const takeOre = Math.min(d.ore, left)
        d.ore -= takeOre
        left -= takeOre
        const takeFood = Math.min(d.food, left)
        d.food -= takeFood
        left -= takeFood
        d.parts -= Math.min(d.parts, left)
      }
      if (hit >= SCRIPT_KILL_THRESHOLD && unverified.length > 0) {
        const pick = unverified[hashNoise(s.seed, s.tick, SALT_STORM_KILL + p * 7919) % unverified.length]
        pick.status = 'killed'
        emit(s, { t: 'scriptKilled', dyad: p, id: pick.id })
      }
    }
    emit(s, { t: 'stormLanded', index: storm.index, severity: storm.severity, absorbed, damage })
  }

  // survivors: the beacon calls them in — if the granary can feed them
  if (
    s.structures.beacon.complete &&
    s.survivors < SURVIVORS_MAX &&
    s.tick % SURVIVOR_PERIOD === 0 &&
    s.granaryFood >= SURVIVOR_FOOD_COST
  ) {
    s.granaryFood -= SURVIVOR_FOOD_COST
    s.survivors++
    emit(s, { t: 'survivorArrived', survivors: s.survivors, capacity: scriptSlots(s) })
  }
}

// ── End stats (captured at launch) ──────────────────────────────────────────

function computeEndStats(s: SimState): EndStats {
  return {
    launchedAtTick: s.tick,
    stormsWeathered: countStorms(s.seed, s.tick),
    survivors: s.survivors,
    totalParts: (['wall', 'granary', 'beacon', 'ark'] as const).reduce((acc, k) => acc + s.structures[k].parts, 0),
    goVotes: goVotes(s),
    dyads: s.dyads.map((d) => ({
      name: d.name,
      district: d.district,
      contributed: d.contributed,
      stormDamage: d.stormDamage,
      integrity: d.integrity,
      survived: d.integrity > 0,
      scriptsDeployed: d.scripts.length,
      scriptsVerified: d.scripts.filter((sc) => sc.verified).length,
      scriptsKilled: d.scripts.filter((sc) => sc.status === 'killed').length,
    })),
  }
}

/** Storms landed at or before `tick` — pure. */
export function countStorms(seed: number, tick: number): number {
  let n = 0
  for (let k = 1; ; k++) {
    if (stormSpec(seed, k).tick > tick) return n
    n++
  }
}

// ── Replay (the take-home artifact + the determinism oracle) ────────────────

/** Rebuild the state from seed + log: apply each command at its recorded
 * tick, advancing the world between, then tick to finalTick. Identical to the
 * live room by construction — proven by smoke. */
export function replay(seed: number, entries: Array<{ atTick: number; cmd: Command }>, finalTick: number): SimState {
  const s = newGame(seed)
  for (const e of entries) {
    while (s.tick < e.atTick && ticksRunning(s)) tick(s)
    apply(s, e.cmd)
  }
  while (s.tick < finalTick && ticksRunning(s)) tick(s)
  return s
}

// ── Replay identity helpers ─────────────────────────────────────────────────

/** Canonical serialization of everything replay must reproduce. */
export function snap(s: SimState): string {
  return JSON.stringify({
    seed: s.seed,
    tick: s.tick,
    started: s.started,
    dyads: s.dyads,
    veins: s.veins,
    structures: s.structures,
    granaryFood: s.granaryFood,
    survivors: s.survivors,
    launched: s.launched,
    endedEarly: s.endedEarly,
    end: s.end,
    chronicle: s.chronicle,
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
