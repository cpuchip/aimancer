// Event-feed plumbing shared by the phone and the board.
//
// THE DUPLICATE-APPEND FIX (D1 bug, kept through the ark pivot): the server
// pushes a snapshot on EVERY command and tick, and a snapshot carries the
// WHOLE current-tick event array — so the sim counts every event it has ever
// emitted (SimState.eventSeq, monotonic), the snapshot carries that count,
// and freshEvents() slices exactly the unseen tail. Proven over the real
// wire by wstest.

import type { SimEvent } from './sim/types.ts'

export interface FeedCursor {
  seen: number // eventSeq high-water mark
}

export function newFeedCursor(): FeedCursor {
  return { seen: 0 }
}

/** The events this snapshot carries that the cursor has NOT yet delivered. */
export function freshEvents(cursor: FeedCursor, events: SimEvent[], eventSeq: number): SimEvent[] {
  const unseen = Math.max(0, Math.min(events.length, eventSeq - cursor.seen))
  cursor.seen = Math.max(cursor.seen, eventSeq)
  return unseen > 0 ? events.slice(events.length - unseen) : []
}

// ── Human wording (the board's voice; the phone reuses it) ───────────────────

export function describeEvent(e: SimEvent, nameOf: (i: number) => string): string {
  switch (e.t) {
    case 'joined': return `🏕 ${e.name} claimed district #${e.district + 1} — welcome to the settlement`
    case 'deployed':
      return e.scope === 'shared'
        ? `🟢 ${nameOf(e.dyad)} deployed ${e.name} to the SHARED works (oracle-green)`
        : `${nameOf(e.dyad)} deployed ${e.name} in their district${e.verified ? ' (verified)' : ' — unverified, their rubble'}`
    case 'undeployed': return `${nameOf(e.dyad)} pulled ${e.id} back to the bench`
    case 'oracle': return `${nameOf(e.dyad)} ran the oracle on ${e.id}: ${e.ok ? 'GREEN ✓' : 'RED ✗'}`
    case 'gateRefused': return `🚧 THE GATE held: ${nameOf(e.dyad)}'s ${e.id} tried to touch shared works unverified`
    case 'scriptError': return `💥 ${nameOf(e.dyad)}'s ${e.id} crashed: ${e.reason}`
    case 'scriptKilled': return `🌪💀 the storm TORE APART ${nameOf(e.dyad)}'s unverified ${e.id}`
    case 'stormWarning': return `🌩 STORM ${e.index} in ${e.inTicks} ticks — severity ${e.severity}. Walls up.`
    case 'stormLanded': return `🌪 STORM ${e.index} hit at ${e.severity} — the wall absorbed ${e.absorbed}${e.damage.some((x) => x > 0) ? `, districts took ${e.damage.join(' / ')}` : ' — NOTHING got through'}`
    case 'contributed': return `🧱 ${nameOf(e.dyad)} landed ${e.amount} part${e.amount === 1 ? '' : 's'} on the ${e.structure}`
    case 'milestone': return `🎉 MILESTONE: the ${e.structure.toUpperCase()} stands — the settlement grows`
    case 'survivorArrived': return `🧍 a survivor reached the beacon — ${e.survivors} sheltering (script capacity ${e.capacity})`
    case 'veinSpawned': return `⛏ a NEW VEIN surfaced — vein #${e.id} (rate ${e.rate}, ${e.reserve} ore)`
    case 'veinExhausted': return `🪨 vein #${e.id} ran DRY — miners there are idling`
    case 'voteCast': return e.go ? `🚀 ${nameOf(e.dyad)} votes GO` : `🛑 ${nameOf(e.dyad)} votes NO-GO`
    case 'started': return `🔔 THE HOST CALLED IT — the world runs, the storm clock is live. Build.`
    case 'launch': return `🚀🚀🚀 LAUNCH — ${e.goVotes} of ${e.dyads} dyads said GO. The ark rises.`
    case 'ended': return `🌙 the host called the game — the settlement rests, the books open`
    case 'chronicle':
      return e.kind === 'discovery'
        ? `🗝 DISCOVERY — ${e.snippet}`
        : `📜 ${nameOf(e.dyad)} wrote in the chronicle: "${e.snippet}"`
  }
}

/** The board shows these big; everything else is a footnote. */
export function isDisaster(e: SimEvent): boolean {
  return e.t === 'stormLanded' || e.t === 'scriptKilled' || e.t === 'scriptError' || e.t === 'gateRefused'
}

/** The board celebrates these. */
export function isTriumph(e: SimEvent): boolean {
  return e.t === 'milestone' || e.t === 'launch' || e.t === 'started' || e.t === 'survivorArrived' || (e.t === 'chronicle' && e.kind === 'discovery')
}
