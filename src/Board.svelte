<script lang="ts">
  // The BIG SCREEN — worth projecting: phase banner + countdown, live
  // scoreboard (movement animated), the DISASTER THEATER (celebratory,
  // dedup'd, newest-first), market/gremlin trends, the intermission summary
  // backdrop, and the reveal's delta table. Spectator ws — no hands, no
  // tokens (redacted server-side; wstest proves it).
  import { flip } from 'svelte/animate'
  import { wsUrl } from './net.ts'
  import { describeEvent, freshEvents, isDisaster, newFeedCursor } from '../shared/eventFeed.ts'
  import { PHASE_BANNER } from './ui.ts'
  import type { LobbyPlayer, RoomView, ServerMessage } from '../shared/protocol.ts'

  const { pin }: { pin: string } = $props()

  let view = $state<RoomView | null>(null)
  let status = $state('connecting…')
  let lobbyPlayers = $state<LobbyPlayer[]>([])
  let theater = $state<Array<{ line: string; big: boolean; key: number }>>([])
  let marketTrend = $state<'up' | 'down' | 'flat'>('flat')
  let gremlinTrend = $state<'up' | 'down' | 'flat'>('flat')
  const feedCursor = newFeedCursor()
  let feedKey = 0
  let prevMarket: number | null = null
  let prevGremlin: number | null = null

  const ws = new WebSocket(wsUrl())
  ws.onopen = () => ws.send(JSON.stringify({ type: 'watch', room: pin }))
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage
    if (msg.type === 'lobby') {
      status = msg.started ? 'live' : 'waiting for the host'
      lobbyPlayers = msg.players
    }
    if (msg.type === 'snapshot') {
      const v = msg.view
      if (prevMarket !== null && v.market !== prevMarket) marketTrend = v.market > prevMarket ? 'up' : 'down'
      if (prevGremlin !== null && v.gremlin !== prevGremlin) gremlinTrend = v.gremlin > prevGremlin ? 'up' : 'down'
      prevMarket = v.market
      prevGremlin = v.gremlin
      view = v
      status = 'live'
      const names = (i: number) => v.players[i]?.name ?? `P${i}`
      const fresh = freshEvents(feedCursor, v.events, v.eventSeq)
      if (fresh.length > 0) {
        theater = [
          ...fresh.map((e) => ({ line: describeEvent(e, names), big: isDisaster(e), key: feedKey++ })).reverse(),
          ...theater,
        ].slice(0, 24)
      }
    }
    if (msg.type === 'error') status = msg.message
  }
  ws.onclose = () => (status = 'disconnected')

  const ranked = $derived(view ? [...view.players].sort((a, b) => b.score - a.score) : [])
  const phase = $derived(view?.phase ?? 'lobby')
  const banner = $derived(PHASE_BANNER[phase] ?? PHASE_BANNER.lobby)
  const trendGlyph = (t: 'up' | 'down' | 'flat') => (t === 'up' ? '▲' : t === 'down' ? '▼' : '·')

  function fateIcon(sc: { status: string; armed: boolean; yolo: boolean }): string {
    if (sc.status === 'dead') return '💀'
    if (sc.status === 'blown') return '🔥'
    if (sc.status === 'autoDisarmed') return '🔌'
    if (sc.armed) return sc.yolo ? '🧨' : '🟢'
    return '🃏'
  }
</script>

<div class="board">
  <div class="phase-banner phase-{phase}">
    <span class="title">{banner.title}</span>
    <span class="sub">{banner.sub}</span>
    {#if view && (phase === 'round1' || phase === 'round2') && view.ticksRemaining !== null}
      <span class="count num">{view.ticksRemaining} {view.ticksRemaining === 1 ? 'tick' : 'ticks'} left</span>
    {/if}
  </div>

  <div class="row" style="justify-content:space-between">
    <span class="join-hint muted">join at <b style="letter-spacing:normal">{location.host}</b> · PIN <b>{pin}</b></span>
    {#if view && view.started}
      <span class="row" style="gap:var(--s-4)">
        <span class="trend {marketTrend === 'up' ? 'up' : marketTrend === 'down' ? 'down' : ''}">📈 market {view.market}/widget {trendGlyph(marketTrend)}</span>
        <span class="trend {gremlinTrend === 'up' ? 'down' : ''}">👹 gremlin {view.gremlin}/10 {trendGlyph(gremlinTrend)}</span>
        <span class="muted num">tick {view.tick} · {view.tickMs / 1000}s</span>
      </span>
    {:else}
      <span class="muted">{status}</span>
    {/if}
  </div>

  {#if !view || !view.started}
    <div class="card" style="text-align:center; padding:var(--s-7)">
      <div style="font-size:var(--t-3xl); font-weight:700; letter-spacing:0.3em">{pin}</div>
      <p class="muted" style="font-size:var(--t-lg)">grab your phone · {location.host} · enter the PIN</p>
      {#if lobbyPlayers.length}
        <p style="font-size:var(--t-lg)">
          {#each lobbyPlayers as p (p.index)}
            <span class="chip drafted" style="margin:0 var(--s-1)">{p.name}{p.online ? '' : ' (away)'}</span>
          {/each}
        </p>
      {/if}
    </div>
  {:else if phase === 'reveal' && view.delta}
    <div class="delta-total">
      THE ROOM: {view.delta.totals.r1Score} → {view.delta.totals.r2Score}
      <span class={view.delta.totals.score >= 0 ? 'delta-pos' : 'delta-neg'}>
        {view.delta.totals.score >= 0 ? '+' : ''}{view.delta.totals.score}
      </span>
      <div class="muted" style="font-size:var(--t-md); font-weight:400">
        same world, same seed — the only variable was the oracle (and you)
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>workshop</th>
          <th class="r">round 1</th>
          <th class="r">round 2</th>
          <th class="r">Δ score</th>
          <th class="r">Δ disasters</th>
          <th class="r">Δ sold</th>
          <th class="r">Δ waste</th>
        </tr>
      </thead>
      <tbody>
        {#each [...view.delta.players].sort((a, b) => b.dScore - a.dScore) as p (p.name)}
          <tr>
            <td>{p.name}</td>
            <td class="r num">{p.r1.score}</td>
            <td class="r num">{p.r2.score}</td>
            <td class="r num {p.dScore >= 0 ? 'delta-pos' : 'delta-neg'}">{p.dScore >= 0 ? '+' : ''}{p.dScore}</td>
            <td class="r num {p.dDisasters <= 0 ? 'delta-pos' : 'delta-neg'}">{p.dDisasters > 0 ? '+' : ''}{p.dDisasters}</td>
            <td class="r num">{p.dWidgetsSold >= 0 ? '+' : ''}{p.dWidgetsSold}</td>
            <td class="r num">{p.dWaste > 0 ? '+' : ''}{p.dWaste}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    {#if phase === 'intermission' && view.round1Summary}
      <div class="card">
        <h2 style="margin-top:0">Round 1 — the naive round, on the record</h2>
        <table>
          <thead>
            <tr><th>workshop</th><th class="r">score</th><th class="r">sold</th><th class="r">disasters</th><th class="r">waste</th><th class="r">uptime</th></tr>
          </thead>
          <tbody>
            {#each [...view.round1Summary.players].sort((a, b) => b.score - a.score) as p (p.name)}
              <tr>
                <td>{p.name}</td>
                <td class="r num score-cell">{p.score}</td>
                <td class="r num">{p.widgetsSold}</td>
                <td class="r num">{p.disasters}</td>
                <td class="r num">{p.waste}</td>
                <td class="r num">{p.uptime}</td>
              </tr>
            {/each}
            <tr>
              <td class="muted">the room</td>
              <td class="r num score-cell">{view.round1Summary.totals.score}</td>
              <td class="r num">{view.round1Summary.totals.widgetsSold}</td>
              <td class="r num">{view.round1Summary.totals.disasters}</td>
              <td class="r num">{view.round1Summary.totals.waste}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <p class="muted">world frozen · phones can still stock their hands · round 2 replays this exact world — verified</p>
      </div>
    {/if}

    <div class="grid">
      <div>
        <h2>Scoreboard</h2>
        <table>
          <thead>
            <tr><th>#</th><th>workshop</th><th class="r">score</th><th class="r">⚡</th><th class="r">⚙ sold</th><th class="r">waste</th><th>scripts</th></tr>
          </thead>
          <tbody>
            {#each ranked as p, i (p.index)}
              <tr animate:flip={{ duration: 400 }}>
                <td class="num muted">{i + 1}</td>
                <td>{p.name}{p.online ? '' : ' 💤'}</td>
                <td class="r num score-cell">
                  {#key p.score}<span class="pop">{p.score}</span>{/key}
                </td>
                <td class="r num">{p.tokens}</td>
                <td class="r num">{p.widgetsSold}</td>
                <td class="r num">{p.waste}</td>
                <td>
                  {#each p.scripts as sc (sc.id)}<span title={sc.id}>{fateIcon(sc)}</span>{/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div>
        <h2>Disaster theater</h2>
        <div class="events">
          {#each theater as item (item.key)}
            <div class={item.big ? 'theater-big' : ''}>{item.line}</div>
          {/each}
          {#if theater.length === 0}<div class="muted">quiet… for now</div>{/if}
        </div>
      </div>
    </div>
  {/if}
</div>
