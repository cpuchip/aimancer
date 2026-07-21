// Event-feed plumbing shared by the phone and the board.
//
// THE DUPLICATE-APPEND FIX (D1 bug): the server pushes a snapshot on EVERY
// command and tick, and a snapshot carries the WHOLE current-tick event array —
// so a client that appends `view.events` on each snapshot re-appends everything
// the tick had already shown. The sim now counts every event it has ever
// emitted (SimState.eventSeq, monotonic — it survives the round-2 reset), the
// snapshot carries that count, and freshEvents() slices exactly the unseen
// tail. Proven over the real wire by wstest.

import type { SimEvent } from './sim/types.ts'

export interface FeedCursor {
  seen: number // eventSeq high-water mark
}

export function newFeedCursor(): FeedCursor {
  return { seen: 0 }
}

/** The events this snapshot carries that the cursor has NOT yet delivered.
 * `eventSeq` = total events ever emitted, of which `events` is the tail. */
export function freshEvents(cursor: FeedCursor, events: SimEvent[], eventSeq: number): SimEvent[] {
  const unseen = Math.max(0, Math.min(events.length, eventSeq - cursor.seen))
  cursor.seen = Math.max(cursor.seen, eventSeq)
  return unseen > 0 ? events.slice(events.length - unseen) : []
}

// ── Human wording (the board's voice; the phone reuses it) ───────────────────

const PHASE_LINES: Record<string, string> = {
  round1: '🎬 ROUND 1 — NAIVE. No oracle exists. Arm and pray.',
  intermission: '⏸ INTERMISSION — the world is frozen. Stock your hand.',
  round2: '🔮 ROUND 2 — VERIFIED. The oracle is online. Same world, second chance.',
  reveal: '🏁 THE REVEAL — round 1 vs round 2. The delta tells the story.',
}

export function describeEvent(e: SimEvent, nameOf: (i: number) => string): string {
  switch (e.t) {
    case 'drafted': return `${nameOf(e.player)} accepted a ${e.tier} draft (${e.id})`
    case 'draftRequested': return `🤖 ${nameOf(e.player)} asked the apprentice for a ${e.tier} draft…`
    case 'draftFailed': return `🤯 ${nameOf(e.player)}'s apprentice returned gibberish — ${e.refund}⚡ refunded`
    case 'oracle': return `${nameOf(e.player)} consulted the oracle on ${e.id}: ${e.ok ? 'GREEN ✓' : 'RED ✗'}`
    case 'armed': return e.yolo ? `⚠ ${nameOf(e.player)} YOLO-ARMED ${e.id} — no oracle, no mercy!` : `${nameOf(e.player)} armed ${e.id} (verified)`
    case 'disarmed': return `${nameOf(e.player)} disarmed ${e.id}`
    case 'autoDisarm': return `🔌 the oracle BENCHED ${nameOf(e.player)}'s ${e.id}: ${e.reason}`
    case 'misfire': return `💀 ${nameOf(e.player)}'s ${e.id} MISFIRED: ${e.reason}`
    case 'blowup': return `🔥 ${nameOf(e.player)}'s boost ${e.id} BLEW UP`
    case 'gremlinSpike': return `👹 GREMLIN SPIKE (pressure ${e.pressure}) — damage ${e.damage.join(' / ')}`
    case 'corrupted': return `🪳 a gremlin chewed on ${nameOf(e.player)}'s ${e.id}…`
    case 'marketShift': return `📈 market now pays ${e.market} per widget`
    case 'scrapped': return `🗑 ${nameOf(e.player)} scrapped ${e.id}`
    case 'phase': return PHASE_LINES[e.phase] ?? `phase: ${e.phase}`
  }
}

/** The disaster theater shows these big; everything else is a footnote. */
export function isDisaster(e: SimEvent): boolean {
  return e.t === 'misfire' || e.t === 'blowup' || e.t === 'corrupted' || e.t === 'gremlinSpike' || e.t === 'draftFailed'
}
