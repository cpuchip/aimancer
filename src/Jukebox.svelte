<script lang="ts">
  // The phone JUKEBOX panel — the settlement soundtrack, player-controlled.
  // OFF until tapped (no autoplay ambush); volume + loop mode remembered.
  import { jukebox } from './jukebox.svelte.ts'
  import { fmtDuration, moodTracks, TRACKS, type Track } from './music.ts'

  const MOOD_TAG: Record<Track['mood'], string> = {
    gathering: '🔔 gathering',
    work: '⚙️ the work',
    storm: '🌩 storm',
    launch: '🚀 launch',
    lore: '🗝 lore',
    wildcard: '🎲 wildcard',
  }

  function tap(t: Track): void {
    // shuffle-within-mood unless the player pinned loop-one
    jukebox.pool = moodTracks(t.mood).map((x) => x.id)
    jukebox.toggle(t)
  }
</script>

<details class="card jb">
  <summary>
    <b>🎵 Jukebox</b>
    <span class="muted"> — the settlement soundtrack</span>
    {#if jukebox.track}
      <span class="jb-now num">{jukebox.playing ? '♪' : '⏸'} {jukebox.track.title}</span>
    {/if}
  </summary>

  <div class="row jb-controls">
    <label class="row grow" style="gap:var(--s-2)">
      <span class="muted">🔊</span>
      <input
        class="jb-vol grow"
        type="range"
        min="0"
        max="100"
        value={Math.round(jukebox.volume * 100)}
        oninput={(e) => jukebox.setVolume(Number((e.currentTarget as HTMLInputElement).value) / 100)}
        aria-label="music volume"
      />
    </label>
    <label class="row" style="gap:var(--s-1)" title="loop the current track instead of shuffling its mood">
      <input type="checkbox" checked={jukebox.loop} onchange={(e) => jukebox.setLoop((e.currentTarget as HTMLInputElement).checked)} />
      loop track
    </label>
    {#if jukebox.track}
      <button class="ghost jb-stop" onclick={() => jukebox.stop()}>⏹ stop</button>
    {/if}
  </div>

  <div class="stack" style="gap:2px">
    {#each TRACKS as t (t.id)}
      <button class="jb-row" class:jb-current={jukebox.track?.id === t.id} onclick={() => tap(t)} title={t.blurb}>
        <span class="jb-play">{jukebox.track?.id === t.id && jukebox.playing ? '⏸' : '▶'}</span>
        <span class="jb-title">{t.title}{t.vocal ? ' 🎤' : ''}</span>
        <span class="jb-mood">{MOOD_TAG[t.mood]}</span>
        <span class="jb-len num muted">{fmtDuration(t.seconds)}</span>
      </button>
    {/each}
  </div>

  <p class="faint" style="margin:var(--s-2) 0 0">
    12 original tracks, written from this game's lore (ACE-Step 1.5 XL, generated locally) ·
    tap a track = play it, then shuffle its mood ·
    <a href="/assets/music/CREDITS.md" target="_blank" rel="noopener">credits + lyrics</a>
  </p>
</details>
