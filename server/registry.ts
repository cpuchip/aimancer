// The HIDDEN-SURFACE REGISTRY — deep lore as data (FREEDOM UPDATE). The API
// holds more than the docs admit: undocumented help topics, room endpoints,
// and act() verbs, each carrying a lore FRAGMENT and an optional CONDITION
// (the surface answers only when the settlement has earned it — an unmet
// condition is indistinguishable from "nothing there").
//
// DATA-DRIVEN by design: the registry loads from `lore/content-map.json`
// (written by the lore pass — this file never hardcodes their content) and
// falls back to a small placeholder set so the mechanics ship and get tested
// before the content lands. Content-map entries land WITHOUT code changes.
//
// Discovery is per-room, first-finder-wins: the server records it, the board
// celebrates it, and a FREE chronicle entry (kind 'discovery') enters the
// command log — so replays carry who found what, when.
//
// content-map.json shape (condition/worldField/worldValue optional):
//   { "hidden": [ { "id", "kind": "help-topic"|"endpoint"|"verb", "key",
//       "title", "fragment", "condition"?: { "structureComplete"?, "minTick"?,
//       "survivorsAtLeast"? }, "worldField"?, "worldValue"? } ],
//     "canonNames": [ "VELD" | { "name": "HUSH", "note": "..." } ],
//     "pools": { "<pool-name>": ["door","window",...] } }
//
// CANON NAMES + the clipped tongue (ruling, 2026-07-22, supersedes the
// I/O-only rule): the PIN alphabet holds NO VOWELS AT ALL (profanity-proof +
// misread-proof — load-bearing, never change it). Consequence, and the lore:
// the Index speaks the CLIPPED TONGUE — no true settlement name can ever be
// DRAWN; ALL the old canon names are structurally retired. A settlement can
// only EARN a name: the Rite of Naming (a future content drop) sets the
// room's displayName beside its PIN. canonNames here is the retired canon —
// data for that rite, not for draw-recognition (which is gone by design).
// TODO(lore pass): adopt the clipped-tongue wording + the Rite of Naming into
// content-map.json; a dyad who notices no PIN ever holds a vowel, and asks
// why, has found real lore.
//
// ★ THE CLUE ENGINE (ruling, 2026-07-22): CANON is static, INSTANCE is
// seeded. A fragment / world-field name / world-value may carry TEMPLATE
// SLOTS — `{{pool:<name>}}` — resolved PER ROOM at creation via
// hashNoise(roomSeed, 0, salt(<name>)) % pool.length. Knowledge transfers as
// METHOD, not ANSWER: a writeup can't spoil another room, and replays stay
// deterministic (every draw is seed-derived). The lore pass widens pools in
// content-map.json with NO code changes. (Surface KEYS stay static — the API
// paths are the map; what they SAY is the instance. Permutation bindings
// compose from one slot per element.)

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashNoise } from '../shared/sim/noise.ts'
import type { SimState, StructureKind } from '../shared/sim/types.ts'

export interface HiddenCondition {
  /** answers only once this structure stands */
  structureComplete?: StructureKind
  /** answers only from this world tick on */
  minTick?: number
  /** answers only once this many survivors shelter */
  survivorsAtLeast?: number
}

export type HiddenKind = 'help-topic' | 'endpoint' | 'verb'

export interface HiddenSurface {
  id: string
  kind: HiddenKind
  /** help topic name · room endpoint path segment · act() verb */
  key: string
  /** the celebrated name ("X uncovered: <title>") */
  title: string
  /** the lore text served to the finder */
  fragment: string
  condition?: HiddenCondition
  /** verb surfaces only: after discovery, this field appears in the FINDER
   * seat's world dict from then on (agent archaeology pays forward). */
  worldField?: string
  worldValue?: unknown
}

/** A RETIRED canon settlement name — the clipped tongue cannot draw it; the
 * Rite of Naming (future content drop) is the only way a settlement earns
 * one. Kept as data so the rite can land without code changes. */
export interface CanonName {
  name: string
  note?: string
}

export interface HiddenRegistry {
  source: 'content-map' | 'placeholder'
  surfaces: HiddenSurface[]
  /** The retired canon — rite material, never draw-recognized. */
  canonNames: CanonName[]
  /** THE CLUE ENGINE's pools: `{{pool:<name>}}` slots draw from these,
   * seeded per room. The lore pass widens them in content-map.json. */
  pools: Record<string, string[]>
}

function validCanonNames(raw: unknown): CanonName[] {
  const out: CanonName[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const name = typeof item === 'string' ? item : typeof (item as { name?: unknown })?.name === 'string' ? (item as { name: string }).name : ''
    const upper = name.trim().toUpperCase()
    if (!upper) continue
    const note = typeof (item as { note?: unknown })?.note === 'string' ? (item as { note: string }).note : undefined
    out.push({ name: upper, ...(note ? { note } : {}) })
  }
  return out
}

function validPools(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9-]{1,40}$/.test(k) || !Array.isArray(v)) continue
    const items = v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80)
    if (items.length > 0) out[k] = items
  }
  return out
}

// ── THE CLUE ENGINE: per-room seeded slot resolution ────────────────────────

/** FNV-1a of a slot name → the hashNoise salt for that slot. One slot name =
 * one draw per room (every use of the same slot agrees, by construction). */
function slotSalt(name: string): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const SLOT_RE = /\{\{pool:([a-z0-9-]{1,40})\}\}/g

function resolveString(s: string, seed: number, pools: Record<string, string[]>): string {
  return s.replace(SLOT_RE, (whole, name: string) => {
    const pool = pools[name]
    if (!pool || pool.length === 0) return whole // unknown pool: left visible (loud in dev)
    return pool[hashNoise(seed, 0, slotSalt(name)) % pool.length]
  })
}

function resolveValue(v: unknown, seed: number, pools: Record<string, string[]>): unknown {
  if (typeof v === 'string') return resolveString(v, seed, pools)
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, seed, pools))
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolveValue(x, seed, pools)]))
  }
  return v
}

/** Bind a registry's INSTANCE draws to one room's seed: every `{{pool:x}}`
 * slot in titles/fragments/world-fields/world-values resolves to a seeded
 * pick. CANON (the mythology, the keys) stays static; the INSTANCE (which
 * word, which binding) is this room's own. Deterministic: same seed ⇒ same
 * resolution, forever — replays and writeups stay honest. */
export function resolveRegistryForRoom(reg: HiddenRegistry, seed: number): HiddenRegistry {
  return {
    ...reg,
    surfaces: reg.surfaces.map((s) => ({
      ...s,
      title: resolveString(s.title, seed, reg.pools),
      fragment: resolveString(s.fragment, seed, reg.pools),
      ...(s.worldField ? { worldField: resolveString(s.worldField, seed, reg.pools) } : {}),
      ...(s.worldValue !== undefined ? { worldValue: resolveValue(s.worldValue, seed, reg.pools) } : {}),
    })),
  }
}

const KINDS: readonly HiddenKind[] = ['help-topic', 'endpoint', 'verb'] as const
const STRUCTURES: readonly StructureKind[] = ['wall', 'granary', 'beacon', 'ark'] as const

/** True when the room has earned this surface. No condition = always. */
export function conditionMet(s: SimState, c: HiddenCondition | undefined): boolean {
  if (!c) return true
  if (c.structureComplete && !s.structures[c.structureComplete]?.complete) return false
  if (typeof c.minTick === 'number' && s.tick < c.minTick) return false
  if (typeof c.survivorsAtLeast === 'number' && s.survivors < c.survivorsAtLeast) return false
  return true
}

function validSurface(raw: unknown): HiddenSurface | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  if (typeof o.kind !== 'string' || !(KINDS as readonly string[]).includes(o.kind)) return null
  if (typeof o.key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(o.key)) return null
  if (typeof o.title !== 'string' || typeof o.fragment !== 'string' || !o.fragment) return null
  let condition: HiddenCondition | undefined
  if (o.condition !== undefined) {
    if (typeof o.condition !== 'object' || o.condition === null) return null
    const c = o.condition as Record<string, unknown>
    condition = {}
    if (c.structureComplete !== undefined) {
      if (typeof c.structureComplete !== 'string' || !(STRUCTURES as readonly string[]).includes(c.structureComplete)) return null
      condition.structureComplete = c.structureComplete as StructureKind
    }
    if (c.minTick !== undefined) {
      if (typeof c.minTick !== 'number') return null
      condition.minTick = c.minTick
    }
    if (c.survivorsAtLeast !== undefined) {
      if (typeof c.survivorsAtLeast !== 'number') return null
      condition.survivorsAtLeast = c.survivorsAtLeast
    }
  }
  return {
    id: o.id,
    kind: o.kind as HiddenKind,
    key: o.key,
    title: o.title,
    fragment: o.fragment,
    ...(condition ? { condition } : {}),
    ...(typeof o.worldField === 'string' && o.worldField ? { worldField: o.worldField, worldValue: o.worldValue } : {}),
  }
}

/** PLACEHOLDERS — real mechanics, stand-in lore. The lore pass replaces these
 * wholesale by shipping lore/content-map.json; nothing here is canon. */
function placeholders(): HiddenSurface[] {
  return [
    {
      id: 'ph-aimancer-word',
      kind: 'help-topic',
      key: 'aimancer',
      title: 'the word "aimancer"',
      fragment:
        'AIMANCER (n.) — one who works through a summoned intelligence. The old surveys ' +
        'used the word for the first dyads: not the mind, not the hand, but the PAIR. ' +
        'The settlements that stood were the ones whose aimancers built their own gates. ' +
        '[placeholder fragment — the lore pass completes this story]',
    },
    {
      id: 'ph-first-storm',
      kind: 'help-topic',
      key: 'the-first-storm',
      title: 'the first storm',
      fragment:
        'The storms are not weather. The survey logs call them "the consequences, arriving ' +
        'on schedule" — every settlement that skipped verification met the same sky. ' +
        'Their cadence is seeded into the world itself; nothing negotiates with it. ' +
        '[placeholder fragment — the lore pass completes this story]',
    },
    {
      id: 'ph-granary-ledger',
      kind: 'help-topic',
      key: 'granary-ledger',
      title: 'the granary ledger',
      fragment:
        'A ledger page, legible only once a granary stands: "We counted what we stored, and ' +
        'the counting kept us honest. The beacon calls no one to an empty table." ' +
        '[placeholder fragment — unlocked by the granary milestone]',
      condition: { structureComplete: 'granary' },
    },
    {
      id: 'ph-survey',
      kind: 'endpoint',
      key: 'survey',
      title: "the surveyor's bench",
      fragment:
        'An old surveyor\'s bench, still warm. The instruments read the vein field the way ' +
        'the founders did — and a margin note: "the map is not the territory, but it is ' +
        'more than the API admits. Mind the {{pool:noop-field}}; it is not connected to ' +
        'anything. Or so the manual says." [placeholder fragment — the lore pass completes ' +
        'this story; the {{pool:noop-field}} draw is THIS room\'s own]',
    },
    {
      id: 'ph-the-index',
      kind: 'help-topic',
      key: 'the-index',
      title: 'the clipped tongue',
      fragment:
        'Every settlement is drawn from the Four-Letter Index — and the Index speaks the ' +
        'CLIPPED TONGUE: no vowel has ever appeared in a PIN, and none ever will. The ' +
        'founders cut them so the Index could never draw a curse — nor, it turned out, a ' +
        'true name. KILN, VELD, HUSH, GRIT, MOTH: all structurally retired. A settlement ' +
        'cannot be GIVEN a name; the old rites say one can still be EARNED. ' +
        '[placeholder fragment — the lore pass completes the Rite of Naming]',
    },
    {
      id: 'ph-salvage',
      kind: 'verb',
      key: 'salvage',
      title: 'the salvage yard',
      fragment:
        'act("salvage") — the verb answers: beneath the settlement lies wreckage of the one ' +
        'before it. Nothing to take yet, but the yard REMEMBERS you now; your scripts see a ' +
        'new field in world. [placeholder fragment — the lore pass completes this story]',
      condition: { minTick: 3 },
      worldField: 'salvage',
      worldValue: { yard: 'remembers', hint: 'the old city sleeps under the vein field' },
    },
  ]
}

/** Placeholder retired canon (rite material — never draw-recognized; the
 * clipped tongue cannot draw ANY of them, which is the point). */
function placeholderCanonNames(): CanonName[] {
  return [
    { name: 'KILN', note: "the Founders' settlement [placeholder — lore pass]" },
    { name: 'VELD', note: 'a canon settlement of the old surveys [placeholder — lore pass]' },
    { name: 'HUSH', note: 'a canon settlement of the old surveys [placeholder — lore pass]' },
    { name: 'GRIT', note: 'a canon settlement of the old surveys [placeholder — lore pass]' },
    { name: 'MOTH', note: 'a canon settlement of the old surveys [placeholder — lore pass]' },
  ]
}

/** Placeholder pools — the clue engine's demo draw. The lore pass widens. */
function placeholderPools(): Record<string, string[]> {
  return { 'noop-field': ['door', 'window', 'hatch', 'socket', 'plug', 'terminal'] }
}

export function loadRegistry(cwd = process.cwd()): HiddenRegistry {
  const path = join(cwd, 'lore', 'content-map.json')
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { hidden?: unknown[]; canonNames?: unknown; pools?: unknown }
      const surfaces = (Array.isArray(raw.hidden) ? raw.hidden : []).map(validSurface).filter((x): x is HiddenSurface => x !== null)
      const canonNames = validCanonNames(raw.canonNames)
      const pools = validPools(raw.pools)
      if (surfaces.length > 0 || canonNames.length > 0) {
        console.log(`[lore] content-map loaded — ${surfaces.length} hidden surfaces, ${canonNames.length} retired canon names, ${Object.keys(pools).length} pools`)
        return { source: 'content-map', surfaces, canonNames, pools }
      }
      console.error('[lore] content-map.json present but held no valid entries — falling back to placeholders')
    } catch (e) {
      console.error(`[lore] content-map.json unreadable (${e instanceof Error ? e.message : e}) — falling back to placeholders`)
    }
  }
  return { source: 'placeholder', surfaces: placeholders(), canonNames: placeholderCanonNames(), pools: placeholderPools() }
}

/** The server's singleton registry (loaded once at boot). */
let registry: HiddenRegistry | null = null
export function hiddenRegistry(): HiddenRegistry {
  if (!registry) registry = loadRegistry()
  return registry
}
