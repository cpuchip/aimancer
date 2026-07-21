// Client-side presentation helpers: auto-generated script names, verb icons,
// plain-words param/condition descriptions, and prediction summaries.
// Deliberately HONEST: a hallucinated verb or param is displayed as written —
// spotting it by reading (or paying the oracle) is the game.

import { saltOf } from '../shared/sim/noise.ts'
import type { Script } from '../shared/sim/types.ts'
import type { OracleReport } from '../shared/sim/oracle.ts'

const VERB_NOUN: Record<string, string> = {
  harvest: 'Harvester',
  refine: 'Refinery',
  sell: 'Vendotron',
  patch: 'Patchbot',
  boost: 'Overclocker',
}

export const VERB_ICON: Record<string, string> = {
  harvest: '⛏️',
  refine: '⚙️',
  sell: '💰',
  patch: '🛡️',
  boost: '🚀',
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

/** "Harvester Mk-II" — deterministic from the script (same id → same name). */
export function scriptName(script: Script): string {
  const noun = VERB_NOUN[script.verb] ?? script.verb.charAt(0).toUpperCase() + script.verb.slice(1)
  return `${noun} Mk-${ROMAN[saltOf(script.id) % ROMAN.length]}`
}

export function verbIcon(verb: string): string {
  return VERB_ICON[verb] ?? '❓'
}

/** Generated art for the five REAL verbs (brass/indigo set, /assets). A
 * hallucinated verb gets null → the emoji fallback renders it as written
 * (display-honesty rule): no icon is itself a tell worth reading. */
export const VERB_ICON_SRC: Record<string, string> = {
  harvest: '/assets/verb_harvest.png',
  refine: '/assets/verb_refine.png',
  sell: '/assets/verb_sell.png',
  patch: '/assets/verb_patch.png',
  boost: '/assets/verb_boost.png',
}

export function verbIconSrc(verb: string): string | null {
  return VERB_ICON_SRC[verb] ?? null
}

/** Params in plain words, one line each. Unknown params render raw — the
 * apprentice wrote them; reading them is your job (or the oracle's). */
export function describeParams(script: Script): string[] {
  const lines: string[] = []
  for (const [k, v] of Object.entries(script.params)) {
    if (script.verb === 'harvest' && k === 'rate') lines.push(`gathers ${v} matter each tick`)
    else if (script.verb === 'refine' && k === 'rate') lines.push(`crafts up to ${v} widget${v === 1 ? '' : 's'} each tick (3 matter each)`)
    else if (script.verb === 'sell' && k === 'amount') lines.push(`sells up to ${v} widget${v === 1 ? '' : 's'} each tick at market price`)
    else if (script.verb === 'patch' && k === 'strength') lines.push(`soaks ${v} gremlin damage each tick`)
    else if (script.verb === 'boost' && k === 'mult') lines.push(`multiplies your other scripts ×${v} — risky`)
    else lines.push(`${k}: ${v}`)
  }
  if (lines.length === 0) lines.push('(no parameters)')
  return lines
}

export function describeCondition(script: Script): string | null {
  const c = script.when
  if (!c) return null
  return `runs only while ${c.field} ${c.op} ${c.value}`
}

/** One-line digest of the oracle's 3-tick dry-run. */
export function predictionSummary(report: OracleReport): string | null {
  const pr = report.prediction
  if (!pr || pr.length === 0) return null
  const ran = pr.filter((p) => p.ran).length
  if (ran === 0) return `next ${pr.length} ticks: idle (condition holds it back)`
  const sum = pr.reduce(
    (a, p) => ({ tokens: a.tokens + p.tokens, matter: a.matter + p.matter, widgets: a.widgets + p.widgets }),
    { tokens: 0, matter: 0, widgets: 0 },
  )
  const parts: string[] = []
  const fmt = (n: number, icon: string) => `${n > 0 ? '+' : ''}${n}${icon}`
  if (sum.matter !== 0) parts.push(fmt(sum.matter, '⛏'))
  if (sum.widgets !== 0) parts.push(fmt(sum.widgets, '⚙'))
  if (sum.tokens !== 0) parts.push(fmt(sum.tokens, '⚡'))
  if (parts.length === 0) parts.push('no yield')
  return `next ${pr.length} ticks: ${parts.join(' ')}`
}

/** Phase banner copy — one job per screen, one line per phase. */
export const PHASE_BANNER: Record<string, { title: string; sub: string }> = {
  lobby: { title: 'LOBBY', sub: 'waiting for the host' },
  round1: { title: 'ROUND 1 — NAIVE', sub: 'no oracle exists · arm and pray' },
  intermission: { title: 'INTERMISSION', sub: 'world frozen · stock your hand' },
  round2: { title: 'ROUND 2 — VERIFIED', sub: 'the oracle is online · same world, second chance' },
  reveal: { title: 'THE REVEAL', sub: 'round 1 vs round 2 — the delta tells the story' },
}
