// The SOUNDTRACK manifest — 12 original lore-true tracks (ACE-Step 1.5 XL,
// local; see public/assets/music/CREDITS.md for provenance + lyrics). Pure
// presentation data: the sim never knows music exists. Mood tags drive the
// board's smart cues and the phone jukebox's shuffle-within-mood.

export type Mood = 'gathering' | 'work' | 'storm' | 'launch' | 'lore' | 'wildcard'

export interface Track {
  id: string
  title: string
  file: string
  mood: Mood
  /** duration in seconds (from the encoded files) */
  seconds: number
  /** true = has sung lyrics (the two hymns) */
  vocal: boolean
  blurb: string
}

export const TRACKS: Track[] = [
  { id: 'gathering', title: 'Gathering', file: 'gathering.mp3', mood: 'gathering', seconds: 150, vocal: false, blurb: 'warm workshop ambience — the settling-in loop' },
  { id: 'the-work', title: 'The Work', file: 'the-work.mp3', mood: 'work', seconds: 180, vocal: false, blurb: 'mid-tempo tinkering groove — the running-world loop' },
  { id: 'the-unwoven-ledger', title: 'The Unwoven Ledger', file: 'the-unwoven-ledger.mp3', mood: 'work', seconds: 110, vocal: false, blurb: 'wry jazz workshop swing — keepers relating fragments late at night' },
  { id: 'storm-rising', title: 'Storm Rising', file: 'storm-rising.mp3', mood: 'storm', seconds: 120, vocal: false, blurb: 'tension build, low brass and ticking percussion — audit incoming' },
  { id: 'storm-audit', title: 'Storm Audit', file: 'storm-audit.mp3', mood: 'storm', seconds: 110, vocal: false, blurb: 'industrial-electronic storm theme — the books balanced violently' },
  { id: 'the-launch', title: 'The Launch', file: 'the-launch.mp3', mood: 'launch', seconds: 90, vocal: false, blurb: 'triumphant lift, bells and swell — the Word is given' },
  { id: 'the-chronicle', title: 'The Chronicle', file: 'the-chronicle.mp3', mood: 'lore', seconds: 120, vocal: false, blurb: 'quiet piano and harp — the shared memory' },
  { id: 'the-clipped-tongue', title: 'The Clipped Tongue', file: 'the-clipped-tongue.mp3', mood: 'lore', seconds: 96, vocal: false, blurb: 'playful-mysterious pizzicato — the register that speaks no vowels' },
  { id: 'the-mirror-yard', title: 'The Mirror Yard', file: 'the-mirror-yard.mp3', mood: 'lore', seconds: 120, vocal: false, blurb: 'dreamy reverse-swell ambient — the rehearsal world that forgets by design' },
  { id: 'the-unanswered-bell', title: 'The Unanswered Bell', file: 'the-unanswered-bell.mp3', mood: 'lore', seconds: 105, vocal: false, blurb: 'solo bell over building strings — ends deliberately unresolved' },
  { id: 'keep-the-lights-on', title: 'Keep the Lights On', file: 'keep-the-lights-on.mp3', mood: 'wildcard', seconds: 170, vocal: true, blurb: "Snag's lament — folk lullaby, original lyrics from the gremlin's lore" },
  { id: 'first-aimancers-hymn', title: "First Aimancer's Hymn", file: 'first-aimancers-hymn.mp3', mood: 'wildcard', seconds: 165, vocal: true, blurb: 'folk hymn — Veyra Thornhand, KILN, and the First Compact' },
]

export const trackById = (id: string): Track | undefined => TRACKS.find((t) => t.id === id)
export const trackUrl = (t: Track): string => `/assets/music/${t.file}`
export const moodTracks = (...moods: Mood[]): Track[] => TRACKS.filter((t) => moods.includes(t.mood))

export function fmtDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
