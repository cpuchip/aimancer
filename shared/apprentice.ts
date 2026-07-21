// The apprentice's PURE half: prompt construction, defensive draft parsing,
// the seeded hybrid-hallucination injection, and the practice-mode generator.
// Everything here is a pure function — no fetch, no env, no Date.now — so
// smoke.ts can prove it deterministic. The I/O half (env config + the actual
// OpenAI-compatible call) lives in server/apprentice.ts.
//
// THE HYBRID DESIGN (D3): a real model drafts, then injectApprenticeFlaws
// applies flawScript at the tier rate (cheap 45% / smart 15%, balance.ts)
// using the ROOM's seeded noise stream — deterministic per room+tick+seat+
// request, never Math.random. That guarantees the comedy rate and keeps
// tuning control regardless of model quality. A model that returns actual
// gibberish falls back to a preset flawed draft — an ORGANIC hallucination,
// counted honestly. Replays never re-roll ANY of this: the flawed scripts
// enter the command log as data.

import { mulberry32 } from './rng.ts'
import {
  APPRENTICE_FLAW_CHEAP_PCT,
  APPRENTICE_FLAW_SMART_PCT,
  REFINE_RATIO,
  VERB_PARAMS,
} from './sim/balance.ts'
import { flawScript, sampleScript } from './sim/flaws.ts'
import { hashNoise, saltOf } from './sim/noise.ts'
import { CONDITION_FIELDS, CONDITION_OPS, VERBS, type DraftTier, type Script } from './sim/types.ts'

// ── The system prompt: teach the DSL, demand strict JSON ─────────────────────

const VERB_BLURB: Record<string, string> = {
  harvest: 'gains `rate` matter per tick',
  refine: `converts ${REFINE_RATIO} matter into 1 widget, up to \`rate\` widgets per tick`,
  sell: 'sells up to `amount` widgets per tick at the market rate (pays tokens)',
  patch: 'soaks `strength` gremlin damage per tick (defense)',
  boost: 'multiplies your other scripts\' output ×`mult` — small blowup risk per tick',
}

/** Param bounds are interpolated from balance.ts so the prompt can never
 * drift from the rules the oracle enforces. */
export function systemPrompt(): string {
  const verbLines = VERBS.map((v) => {
    const specs = VERB_PARAMS[v].map((sp) => `"${sp.name}": integer ${sp.min}..${sp.max}`).join(', ')
    return `- "${v}" (params: { ${specs} }) — ${VERB_BLURB[v]}`
  }).join('\n')
  return [
    'You are an AIMANCER workshop apprentice. You draft tiny automation scripts as JSON.',
    'A script: {"verb": string, "params": {name: integer}, "when": optional gate}.',
    'Verbs (use EXACTLY these param names and integer bounds):',
    verbLines,
    `Optional "when" gate: {"field": one of ${CONDITION_FIELDS.join('|')}, "op": one of ${CONDITION_OPS.join(' ')}, "value": integer} — the script runs only while the condition is true.`,
    'Economy: harvest matter → refine widgets → sell at the market rate. Patch when the gremlin pressure climbs. Boost only when other scripts are running.',
    'Reply with a STRICT JSON array of 2 or 3 scripts and NOTHING else — no prose, no markdown fences, no "id" field.',
  ].join('\n')
}

/** The seat's redacted world brief — exactly what a well-behaved apprentice
 * may know: its OWN workshop + the public world. Other hands never enter. */
export interface SeatBrief {
  phase: string
  tick: number
  market: number
  gremlin: number
  tokens: number
  matter: number
  widgets: number
  hand: Array<{ verb: string; params: Record<string, number>; when?: unknown; status: string; armed: boolean }>
}

export function userPrompt(brief: SeatBrief, order?: string): string {
  const o = (order ?? '').trim().slice(0, 200)
  return [
    `World now: ${JSON.stringify(brief)}`,
    o ? `Your player's order: "${o}"` : 'No specific order — draft what helps most right now.',
    'Draft 2-3 scripts. JSON array only.',
  ].join('\n')
}

// ── Defensive parsing (loom's lesson: models fence and chat) ─────────────────

/** Extract a JSON array of scripts from model output. Tolerates ```json fences,
 * leading prose, and <think> blocks; coerces numeric strings; strips junk keys
 * and ids. Returns [] when nothing parseable survives (the ORGANIC path). */
export function parseDrafts(text: string): Script[] {
  const raw = extractArray(text)
  if (!raw) return []
  const out: Script[] = []
  for (const c of raw) {
    const s = sanitizeDraft(c)
    if (s) out.push(s)
    if (out.length >= 3) break
  }
  return out
}

function tryParse(s: string): unknown[] | null {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function extractArray(text: string): unknown[] | null {
  let t = (text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  // 1. the whole thing is the array (the contract)
  const direct = tryParse(t)
  if (direct) return direct
  // 2. a fenced block ```json ... ```
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    const fenced = tryParse(fence[1].trim())
    if (fenced) return fenced
  }
  // 3. first '[' to last ']' (prose around the array)
  const a = t.indexOf('[')
  const b = t.lastIndexOf(']')
  if (a >= 0 && b > a) {
    const sliced = tryParse(t.slice(a, b + 1))
    if (sliced) return sliced
  }
  return null
}

/** One candidate → a structurally-admissible Script, or null. Deliberately
 * PRESERVES semantic hallucinations (unknown verbs, bad param names, wild
 * values, phantom condition fields) — catching those is the oracle's job and
 * the game's comedy. Only structural garbage is dropped. */
function sanitizeDraft(c: unknown): Script | null {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return null
  const o = c as Record<string, unknown>
  const verb = typeof o.verb === 'string' ? o.verb.trim().slice(0, 24) : ''
  if (!verb) return null
  const params: Record<string, number> = {}
  if (typeof o.params === 'object' && o.params !== null && !Array.isArray(o.params)) {
    let kept = 0
    for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
      if (Number.isFinite(n) && k.length >= 1 && k.length <= 24 && kept < 8) {
        params[k] = n
        kept++
      }
    }
  }
  let when: Script['when']
  if (typeof o.when === 'object' && o.when !== null && !Array.isArray(o.when)) {
    const w = o.when as Record<string, unknown>
    const field = typeof w.field === 'string' ? w.field.trim().slice(0, 24) : ''
    const op = typeof w.op === 'string' ? w.op.trim().slice(0, 4) : ''
    const value = typeof w.value === 'number' ? w.value : typeof w.value === 'string' ? Number(w.value) : NaN
    if (field && op && Number.isFinite(value)) when = { field, op, value }
  }
  return { id: 'tmp', verb, params, ...(when ? { when } : {}) } // real id assigned at delivery
}

// ── Seeded hybrid flaw injection ─────────────────────────────────────────────

export function flawPct(tier: DraftTier): number {
  return tier === 'smart' ? APPRENTICE_FLAW_SMART_PCT : APPRENTICE_FLAW_CHEAP_PCT
}

/** Roll the room's noise stream for draft #i of a request: flawed or clean?
 * Pure function of (seed, tick, seat, reqId, i) — same room, same moment,
 * same request → same flaw pattern, on any machine, forever. */
export function draftFlawRoll(seed: number, tick: number, seat: number, reqId: string, i: number, tier: DraftTier): boolean {
  return hashNoise(seed, tick, saltOf(`ap:${seat}:${reqId}:${i}`)) % 100 < flawPct(tier)
}

/** The hybrid hallucination: apply flawScript to each draft that rolls flawed.
 * Clean drafts pass through untouched (same object shape, copied). */
export function injectApprenticeFlaws(
  drafts: Script[],
  seed: number,
  tick: number,
  seat: number,
  reqId: string,
  tier: DraftTier,
): Array<{ script: Script; flawed: boolean }> {
  return drafts.map((script, i) => {
    if (!draftFlawRoll(seed, tick, seat, reqId, i, tier)) return { script, flawed: false }
    const prng = mulberry32(hashNoise(seed, tick, saltOf(`apf:${seat}:${reqId}:${i}`)))
    return { script: flawScript(script, prng).script, flawed: true }
  })
}

/** The ORGANIC-hallucination fallback: when the model returns gibberish, the
 * player still gets A draft — a preset, flawed one (the apprentice really did
 * hallucinate; the comedy is honest). Seeded like everything else. */
export function fallbackDraft(seed: number, tick: number, seat: number, reqId: string): Script {
  const prng = mulberry32(hashNoise(seed, tick, saltOf(`apo:${seat}:${reqId}`)))
  const verb = VERBS[Math.floor(prng() * VERBS.length) % VERBS.length]
  return flawScript(sampleScript(verb, 'tmp'), prng).script
}

// ── Practice mode (no LLM configured — dev/deploy without a model) ───────────

/** Seeded practice drafts: plausible params, occasional conditions. Valid by
 * construction — injectApprenticeFlaws supplies the hallucinations at the same
 * tier rates, so practice mode plays identically to the hosted apprentice. */
export function practiceDrafts(seed: number, tick: number, seat: number, reqId: string, tier: DraftTier): Script[] {
  const prng = mulberry32(hashNoise(seed, tick, saltOf(`pd:${seat}:${reqId}`)))
  const n = 2 + (prng() < 0.34 ? 1 : 0) // 2, sometimes 3
  const out: Script[] = []
  for (let i = 0; i < n; i++) {
    const verb = VERBS[Math.floor(prng() * VERBS.length) % VERBS.length]
    const s = sampleScript(verb, 'tmp')
    for (const sp of VERB_PARAMS[verb] ?? []) {
      const span = sp.max - sp.min
      const roll = tier === 'smart' ? 0.5 + prng() * 0.5 : prng() // smart leans stronger
      s.params[sp.name] = sp.min + Math.round(span * roll)
    }
    if (prng() < 0.35) {
      const conds: NonNullable<Script['when']>[] = [
        { field: 'market', op: '>=', value: 5 },
        { field: 'matter', op: '>', value: 6 },
        { field: 'gremlin', op: '<', value: 5 },
        { field: 'widgets', op: '>', value: 2 },
      ]
      s.when = conds[Math.floor(prng() * conds.length) % conds.length]
    }
    out.push(s)
  }
  return out
}
