// The JUKEBOX — one shared HTMLAudioElement player for the whole client
// (phone panel + board ambient). Plain audio, no libs. OFF by default —
// playback only ever starts from a user gesture (mobile autoplay rules) —
// and volume/mode survive reloads via localStorage. Pure presentation:
// nothing here touches the sim or the wire.

import { TRACKS, trackUrl, type Track } from './music.ts'

const PREFS_KEY = 'aimancer-music'
const FADE_MS = 500

interface Prefs {
  volume: number
  loop: boolean
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    return {
      volume: typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : 0.6,
      loop: raw.loop === true,
    }
  } catch {
    return { volume: 0.6, loop: false }
  }
}

class Jukebox {
  track = $state<Track | null>(null)
  playing = $state(false)
  volume = $state(0.6)
  /** true = loop the current track; false = auto-advance within the pool */
  loop = $state(false)
  /** auto-advance pool (track ids). null = stop at track end (unless loop). */
  pool: string[] | null = null

  private audio: HTMLAudioElement | null = null
  private fadeTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    const p = loadPrefs()
    this.volume = p.volume
    this.loop = p.loop
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: this.volume, loop: this.loop }))
    } catch {
      /* private mode — the music still plays */
    }
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio()
      this.audio.preload = 'none'
      this.audio.onended = () => this.advance()
      this.audio.onpause = () => (this.playing = this.audio ? !this.audio.paused : false)
      this.audio.onplay = () => (this.playing = true)
    }
    return this.audio
  }

  private clearFade(): void {
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer)
      this.fadeTimer = null
    }
  }

  /** Start a track (must originate from a user gesture the first time). */
  play(track: Track): void {
    const a = this.ensureAudio()
    this.clearFade()
    const wasAudible = this.playing && this.track !== null
    this.track = track
    const start = (): void => {
      a.src = trackUrl(track)
      a.loop = false // loop handled in advance() so mode changes apply mid-track
      a.volume = wasAudible ? 0 : this.volume
      void a.play().then(
        () => {
          if (wasAudible) this.fadeTo(this.volume)
        },
        () => (this.playing = false), // autoplay refused — wait for a tap
      )
    }
    if (wasAudible) this.fadeTo(0, start)
    else start()
  }

  /** Simple single-element crossfade: ramp volume, then run `then`. */
  private fadeTo(target: number, then?: () => void): void {
    const a = this.ensureAudio()
    this.clearFade()
    const steps = 10
    const from = a.volume
    let i = 0
    this.fadeTimer = setInterval(() => {
      i++
      a.volume = Math.max(0, Math.min(1, from + ((target - from) * i) / steps))
      if (i >= steps) {
        this.clearFade()
        then?.()
      }
    }, FADE_MS / steps)
  }

  private advance(): void {
    if (!this.track) return
    if (this.loop) {
      this.play(this.track)
      return
    }
    const pool = (this.pool ?? []).filter((id) => TRACKS.some((t) => t.id === id))
    if (pool.length === 0) {
      this.playing = false
      return
    }
    const others = pool.filter((id) => id !== this.track!.id)
    const pickFrom = others.length > 0 ? others : pool
    const next = TRACKS.find((t) => t.id === pickFrom[Math.floor(Math.random() * pickFrom.length)])
    if (next) this.play(next)
  }

  /** Tap on the current track: pause/resume toggle. */
  toggle(track: Track): void {
    if (this.track?.id === track.id && this.audio) {
      if (this.playing) this.audio.pause()
      else void this.audio.play().catch(() => (this.playing = false))
      return
    }
    this.play(track)
  }

  /** Skip to another track from the pool (or any other track). */
  skip(): void {
    const hadPool = this.pool && this.pool.length > 1
    const pool = hadPool ? this.pool! : TRACKS.map((t) => t.id)
    const others = pool.filter((id) => id !== this.track?.id)
    const next = TRACKS.find((t) => t.id === others[Math.floor(Math.random() * others.length)])
    if (next) this.play(next)
  }

  stop(): void {
    this.clearFade()
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
    }
    this.track = null
    this.playing = false
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.audio && !this.fadeTimer) this.audio.volume = this.volume
    this.savePrefs()
  }

  setLoop(loop: boolean): void {
    this.loop = loop
    this.savePrefs()
  }
}

/** The one client-wide player. */
export const jukebox = new Jukebox()
