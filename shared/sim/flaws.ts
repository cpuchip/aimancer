// Hallucination injection — flawScript produces the subtly-broken variants of
// a valid script (the comedy engine). D3's hosted apprentice uses it to
// hallucinate; the sim uses it for gremlin corruption; smoke.ts uses it to
// prove the oracle CATCHES every flaw class. The contract: a flawed script is
// always structurally valid (it can enter a hand) and always oracle-RED.

import { VERB_PARAMS } from './balance.ts'
import { CONDITION_FIELDS, type Script } from './types.ts'
import type { Rng } from '../rng.ts'

export type FlawClass = 'badParamName' | 'offByTenX' | 'wrongResource' | 'impossibleCondition'
export const FLAW_CLASSES: readonly FlawClass[] = ['badParamName', 'offByTenX', 'wrongResource', 'impossibleCondition'] as const

/** Resources the apprentice confidently reaches for that don't exist. */
const PHANTOM_FIELDS = ['mana', 'credits', 'energy', 'widgits', 'mater', 'gremlins', 'butter']

function pick<T>(arr: readonly T[], prng: Rng): T {
  return arr[Math.floor(prng() * arr.length) % arr.length]
}

/** Mangle a param name the way a confident typo does: 'rate' → 'rte',
 * 'strength' → 'strenght', 'amount' → 'ammount'. Guaranteed ≠ the original. */
function mangle(name: string, prng: Rng): string {
  const variants = [
    name.slice(0, -1), // dropped last letter
    name.length > 2 ? name.slice(0, 1) + name.slice(2) : name + 'x', // dropped 2nd letter
    name + name.slice(-1), // doubled last letter
    name.slice(0, 1) + name.slice(0, 1) + name.slice(1), // doubled first letter
  ].filter((v) => v !== name && v.length > 0)
  return pick(variants, prng)
}

/** Deep-copy a script and break it subtly. Preserves the id (a corrupted
 * script is still "the same script" to the player — that's the horror). */
export function flawScript(script: Script, prng: Rng, cls?: FlawClass): { script: Script; flaw: FlawClass } {
  const flaw = cls ?? pick(FLAW_CLASSES, prng)
  const out: Script = {
    id: script.id,
    verb: script.verb,
    params: { ...script.params },
    when: script.when ? { ...script.when } : undefined,
  }
  const keys = Object.keys(out.params)
  switch (flaw) {
    case 'badParamName': {
      if (keys.length === 0) return flawScript(script, prng, 'impossibleCondition')
      const k = pick(keys, prng)
      const v = out.params[k]
      delete out.params[k]
      out.params[mangle(k, prng)] = v
      break
    }
    case 'offByTenX': {
      if (keys.length === 0) return flawScript(script, prng, 'impossibleCondition')
      const k = pick(keys, prng)
      out.params[k] = out.params[k] * 10 // confident, precise, and 10x wrong
      break
    }
    case 'wrongResource': {
      // the condition reaches for a resource that doesn't exist
      const phantom = pick(PHANTOM_FIELDS, prng)
      out.when = out.when ? { ...out.when, field: phantom } : { field: phantom, op: '>', value: 0 }
      break
    }
    case 'impossibleCondition': {
      const real = pick(CONDITION_FIELDS, prng)
      out.when = prng() < 0.5
        ? { field: real, op: '<', value: 0 } // fields are never negative
        : { field: 'tokens', op: '>', value: 9999 } // tokens cap far below this
      break
    }
  }
  return { script: out, flaw }
}

/** A valid example script per verb — handy for tests and the placeholder UI. */
export function sampleScript(verb: string, id: string): Script {
  const specs = VERB_PARAMS[verb] ?? []
  const params: Record<string, number> = {}
  for (const sp of specs) params[sp.name] = sp.min
  return { id, verb, params }
}
