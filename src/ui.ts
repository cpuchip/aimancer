// Client-side presentation helpers for the ARK settlement. Deliberately
// HONEST: script names, notes, and errors render as the sim recorded them.

import type { StructureKind } from '../shared/sim/types.ts'

export const STRUCTURE_ICON: Record<StructureKind, string> = {
  wall: '🧱',
  granary: '🌾',
  beacon: '🗼',
  ark: '🚀',
}

export const STRUCTURE_LABEL: Record<StructureKind, string> = {
  wall: 'THE WALL',
  granary: 'GRANARY',
  beacon: 'BEACON',
  ark: 'THE ARK',
}

export function scopeBadge(scope: string): string {
  return scope === 'shared' ? 'SHARED' : 'district'
}

export function statusIcon(sc: { status: string; verified: boolean }): string {
  if (sc.status === 'killed') return '🌪💀'
  if (sc.status === 'stopped') return '⏸'
  return sc.verified ? '🟢' : '🧨'
}

/** mm:ss for wall-clock countdowns. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** District chip position around the settlement ring (percent coords for the
 * map canvas — index spreads dyads evenly around the lower arc). */
export function districtPos(index: number, count: number): { x: number; y: number } {
  const n = Math.max(1, count)
  const angle = Math.PI * (0.15 + (0.7 * (index + 0.5)) / n) // lower arc, left→right
  return {
    x: 50 + 34 * Math.cos(Math.PI - angle),
    y: 58 + 30 * Math.sin(angle) * 0.55,
  }
}

/** Storm danger color class by how close it is. */
export function stormUrgency(inTicks: number): 'calm' | 'near' | 'imminent' {
  if (inTicks <= 3) return 'imminent'
  if (inTicks <= 10) return 'near'
  return 'calm'
}
