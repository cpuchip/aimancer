// GATE POLICY — the FREEDOM UPDATE's answer to the old server-imposed deploy
// gate. The server no longer requires verification on ANY deploy; instead each
// SEAT carries a policy the HUMAN configures (hinge token only — the discipline
// is human-owned, the agent deploys within it). The server enforces each
// seat's OWN policy on that seat's deploys, per scope:
//
//   []                        — none (the default): deploy freely
//   ['oracle-green']          — a deploy must pass a live engine dry-run
//   ['beta-pass']             — a deploy needs a PASSING Mirror Yard beta of
//                               this exact source (same scope) first
//   ['oracle-green','beta-pass'] — both
//
// Pure module (shared/ discipline): types + validation only, no I/O.

export type GateRequirement = 'oracle-green' | 'beta-pass'
export const GATE_REQUIREMENTS: readonly GateRequirement[] = ['oracle-green', 'beta-pass'] as const

/** Per-scope requirement lists. district = your branch; shared = the works.
 * Most dyads gate `shared` only — but a careful one may gate everything. */
export interface GatePolicy {
  district: GateRequirement[]
  shared: GateRequirement[]
}

export function defaultGatePolicy(): GatePolicy {
  return { district: [], shared: [] }
}

/** Validate + canonicalize a PUT body. Returns null when the shape is not a
 * policy (unknown requirement names, wrong types). Order is canonicalized and
 * duplicates dropped, so equal policies serialize equally. */
export function normalizeGatePolicy(raw: unknown): GatePolicy | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const scopes = ['district', 'shared'] as const
  const out = defaultGatePolicy()
  for (const scope of scopes) {
    const v = o[scope]
    if (v === undefined) continue // absent scope keeps the default (none)
    if (!Array.isArray(v)) return null
    const reqs: GateRequirement[] = []
    for (const item of v) {
      if (typeof item !== 'string' || !(GATE_REQUIREMENTS as readonly string[]).includes(item)) return null
      if (!reqs.includes(item as GateRequirement)) reqs.push(item as GateRequirement)
    }
    out[scope] = GATE_REQUIREMENTS.filter((r) => reqs.includes(r)) as GateRequirement[]
  }
  return out
}

/** Human words for a policy — the phone and the agent prompt both speak it. */
export function describeGatePolicy(p: GatePolicy): string {
  const one = (reqs: GateRequirement[]): string => (reqs.length === 0 ? 'none (deploy freely)' : reqs.join(' + '))
  return `district: ${one(p.district)} · shared: ${one(p.shared)}`
}
