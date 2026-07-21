<script lang="ts">
  // The BIG SCREEN — worth projecting: phase banner + countdown, live
  // scoreboard (movement animated), the DISASTER THEATER (celebratory,
  // dedup'd, newest-first), market/gremlin trends, the intermission summary
  // backdrop, and the reveal's delta table. Spectator ws — no hands, no
  // tokens (redacted server-side; wstest proves it).
  import { flip } from 'svelte/animate'
  import { wsUrl } from './net.ts'
  import { describeEvent, freshEvents, isDisaster, newFeedCursor } from '../shared/eventFeed.ts'
  import { PHASE_BANNER, fmtClock } from './ui.ts'
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

  // wall-clock round countdown, interpolated between snapshots
  let snapAt = $state(0)
  let clockNow = $state(0)
  setInterval(() => (clockNow = performance.now()), 500)

  // RTS map presentation state — purely visual, all derived from snapshots
  let nestFlare = $state(0) // increments on a fresh gremlinSpike → one-shot flash

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
      snapAt = performance.now()
      if (prevMarket !== null && v.market !== prevMarket) marketTrend = v.market > prevMarket ? 'up' : 'down'
      if (prevGremlin !== null && v.gremlin !== prevGremlin) gremlinTrend = v.gremlin > prevGremlin ? 'up' : 'down'
      prevMarket = v.market
      prevGremlin = v.gremlin
      view = v
      status = 'live'
      const names = (i: number) => v.players[i]?.name ?? `P${i}`
      const fresh = freshEvents(feedCursor, v.events, v.eventSeq)
      if (fresh.length > 0) {
        if (fresh.some((e) => e.t === 'gremlinSpike')) nestFlare++
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

  // ── the workshop map (RICH surface — the rush banner lives HERE, never in
  // the agent's API view; CORE IDENTITY #2 made visible) ─────────────────────
  const rush = $derived(view?.rush ?? null)
  const veins = $derived(view?.veins ?? [])
  const contracts = $derived(view?.contracts ?? [])
  const openContracts = $derived(contracts.filter((c) => c.status === 'open'))
  const claimedContracts = $derived(contracts.filter((c) => c.status === 'claimed'))
  const playerHue = (i: number) => `hsl(${(i * 67) % 360} 72% 62%)`
  /** Armed harvesters bound to a vein — each renders as a shuttling worker. */
  const workersOn = (veinId: number) =>
    view
      ? view.players.flatMap((p) =>
          p.scripts
            .filter((sc) => sc.armed && sc.verb === 'harvest' && sc.node === veinId)
            .map((sc) => ({ key: `${p.index}:${sc.id}`, player: p.index })),
        )
      : []
  /** Workshop chip x-position (%) along the bottom strip. */
  const chipX = (i: number) => 12 + i * (76 / Math.max(1, (view?.players.length ?? 1)))
  const chipHasVerb = (i: number, verb: string) => view?.players[i]?.scripts.some((sc) => sc.armed && sc.verb === verb) ?? false

  // ── round-end + auto-advance surfacing (the "silent freeze" hotfix) ────────
  const roundComplete = $derived(view !== null && (phase === 'round1' || phase === 'round2') && view.ticksRemaining === 0)
  const autoIn = $derived(view?.autoAdvanceIn ?? null)
  const bannerTitle = $derived(roundComplete ? `${phase === 'round1' ? 'ROUND 1' : 'ROUND 2'} COMPLETE` : banner.title)
  const bannerSub = $derived(
    roundComplete
      ? autoIn !== null
        ? `advancing in ${autoIn}… — the host can hold or call it now`
        : view?.autoHeld
          ? 'held — the host calls it from their phone'
          : "waiting for the host to call it (host: it's the big button on your phone)"
      : phase === 'intermission' && autoIn !== null
        ? `round 2 in ${autoIn}s — the host can hold`
        : banner.sub,
  )
  const roundClockMs = $derived.by(() => {
    if (!view || (phase !== 'round1' && phase !== 'round2')) return null
    const tr = view.ticksRemaining
    if (tr === null || tr <= 0 || view.nextTickInMs === null) return null
    return Math.max(0, (tr - 1) * view.tickMs + view.nextTickInMs - (clockNow - snapAt))
  })
  /** A seat's agent is "live" if it spoke on the worker surface within 60s. */
  const agentLive = (agoMs: number | null) => agoMs !== null && agoMs + (clockNow - snapAt) < 60_000

  function fateIcon(sc: { status: string; armed: boolean; yolo: boolean }): string {
    if (sc.status === 'dead') return '💀'
    if (sc.status === 'blown') return '🔥'
    if (sc.status === 'autoDisarmed') return '🔌'
    if (sc.armed) return sc.yolo ? '🧨' : '🟢'
    return '🃏'
  }
</script>

<div class="board">
  <div class="board-head">
    <img class="board-emblem" src="/assets/emblem.png" alt="" />
    <span class="wordmark">AIMANCER</span>
    <span class="muted board-tag">your apprentice drafts · only a human arms</span>
  </div>
  <div class="phase-banner phase-{phase}{roundComplete ? ' complete' : ''}">
    <span class="title">{bannerTitle}</span>
    <span class="sub">{bannerSub}</span>
    {#if roundClockMs !== null && view}
      <span class="count num">{fmtClock(roundClockMs)} <span class="muted" style="font-size:var(--t-md)">· {view.ticksRemaining} {view.ticksRemaining === 1 ? 'tick' : 'ticks'}</span></span>
    {:else if autoIn !== null}
      <span class="count num">▶ {autoIn}s</span>
    {/if}
  </div>

  <div class="row" style="justify-content:space-between">
    <span class="join-hint muted">join at <b style="letter-spacing:normal">{location.host}</b> · PIN <b>{pin}</b></span>
    {#if view && view.started}
      <span class="row" style="gap:var(--s-4)">
        <span class="trend {marketTrend === 'up' ? 'up' : marketTrend === 'down' ? 'down' : ''}">📈 widgets {view.market}⚡ {trendGlyph(marketTrend)}</span>
        <span class="trend">🧿 charms {view.marketCharms}⚡</span>
        <span class="trend {gremlinTrend === 'up' ? 'down' : ''}"><img class="ticon" src="/assets/gremlin_a.png" alt="gremlin" /> gremlin {view.gremlin}/10 {trendGlyph(gremlinTrend)}</span>
        <span class="muted num">tick {view.tick} · {view.tickMs / 1000}s</span>
      </span>
    {:else}
      <span class="muted">{status}</span>
    {/if}
  </div>

  {#if rush && view && view.started && phase !== 'reveal'}
    <!-- THE BOARD-ONLY ANNOUNCEMENT: the agent API never carries this. -->
    <div class="rush-banner rush-{rush.good}">
      <span class="rush-icon">{rush.good === 'charms' ? '🧿' : '⚙️'}</span>
      <b>{rush.good.toUpperCase()} RUSH ×{rush.mult}</b>
      <span>{rush.ticksLeft} {rush.ticksLeft === 1 ? 'tick' : 'ticks'} left — tell your agent!</span>
    </div>
  {/if}

  {#if !view || !view.started}
    <div class="card lobby-hero" style="text-align:center; padding:var(--s-7)">
      <img class="lobby-emblem" src="/assets/emblem.png" alt="" />
      <p class="muted" style="font-size:var(--t-xl); margin:0">join at <b style="color:var(--ink)">{location.host}</b> · PIN</p>
      <div style="font-size:var(--t-3xl); font-weight:700; letter-spacing:0.3em">{pin}</div>
      <div class="lobby-steps">
        <span><b>1</b> join on your phone</span>
        <span><b>2</b> connect your agent (copy the prompt)</span>
        <span><b>3</b> host starts the game</span>
      </div>
      <p class="muted" style="font-size:var(--t-lg)">sell widgets · verified scripts survive · YOLO and pray</p>
      {#if lobbyPlayers.length}
        <p style="font-size:var(--t-lg)">
          {#each lobbyPlayers as p (p.index)}
            <span class="chip drafted" style="margin:0 var(--s-1)">{agentLive(p.agentSeenAgoMs) ? '🤖 ' : ''}{p.name}{p.online ? '' : ' (away)'}</span>
          {/each}
        </p>
      {/if}
      <p class="faint">📖 full rules — <a href="/wiki" style="color:var(--accent)">{location.host}/wiki</a></p>
    </div>
  {:else if phase === 'reveal' && view.delta}
    <div class="delta-total">
      <img class="reveal-eye" src="/assets/oracle_eye.png" alt="" />
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

    <!-- ── THE WORKSHOP MAP — the room-watchable centerpiece ─────────────── -->
    <div class="map" class:map-rush={rush !== null}>
      <div class="zone zone-fields"><span class="zone-label">crystal fields</span></div>
      <div class="zone zone-market"><span class="zone-label">market quarter</span></div>
      <div class="zone zone-wastes"><span class="zone-label">gremlin wastes</span></div>

      {#each veins as v (v.id)}
        <div
          class="vein"
          class:dry={v.reserve <= 0}
          class:fresh={v.spawnedAt > 0 && view.tick - v.spawnedAt <= 1}
          style="left:{v.x}%; top:{v.y + 6}%"
        >
          <span class="vein-ping"></span>
          <img class="vein-img" src="/assets/res_matter.png" alt="vein" />
          <div class="vein-fill"><div class="vein-fill-bar" style="height:{Math.round((100 * v.reserve) / Math.max(1, v.reserveMax))}%"></div></div>
          <span class="vein-tag num">#{v.id} · r{v.rate}{v.reserve <= 0 ? ' · DRY' : ''}</span>
          {#each workersOn(v.id) as wk, wi (wk.key)}
            <span
              class="worker"
              style="background:{playerHue(wk.player)}; --dx:{chipX(wk.player) - v.x}cqw; --dy:{92 - (v.y + 6)}cqh; animation-delay:{wi * 0.7}s"
            ></span>
          {/each}
        </div>
      {/each}

      <div class="stall" class:stall-rush={rush?.good === 'widgets'} style="left:86%; top:18%">
        <img class="stall-img" src="/assets/res_widgets.png" alt="widget stall" />
        <span class="stall-price num"><b>{view.market}</b>⚡</span>
        {#if rush?.good === 'widgets'}<span class="stall-mult">×{rush.mult} · {rush.ticksLeft}t</span>{/if}
      </div>
      <div class="stall" class:stall-rush={rush?.good === 'charms'} style="left:86%; top:52%">
        <span class="stall-emoji">🧿</span>
        <span class="stall-price num"><b>{view.marketCharms}</b>⚡</span>
        {#if rush?.good === 'charms'}<span class="stall-mult">×{rush.mult} · {rush.ticksLeft}t</span>{/if}
      </div>
      {#if !rush && view.nextRushInTicks !== undefined}
        <span class="rush-forecast muted num" style="left:86%; top:80%">rush in ~{view.nextRushInTicks}t</span>
      {/if}

      <div class="nest" style="left:10%; top:80%">
        {#key nestFlare}<span class="nest-flare" class:go={nestFlare > 0}></span>{/key}
        <img class="nest-img" src="/assets/gremlin_a.png" alt="gremlin nest" />
        <span class="vein-tag num">nest · {view.gremlin}/10</span>
      </div>

      <!-- workshop strip: each dyad's chip; armed craft/sell pulse it -->
      {#each view.players as p (p.index)}
        <div
          class="shop-chip"
          class:busy={chipHasVerb(p.index, 'craft') || chipHasVerb(p.index, 'sell')}
          style="left:{chipX(p.index)}%; top:92%; border-color:{playerHue(p.index)}"
          title={p.name}
        >
          <span class="shop-dot" style="background:{playerHue(p.index)}"></span>{p.name.slice(0, 8)}
        </div>
      {/each}
    </div>

    {#if contracts.length > 0}
      <div class="contract-strip">
        {#each openContracts as c (c.id)}
          <span class="contract-chip open">📜 #{c.id}: {c.qty} {c.good} → +{c.bonus} <span class="muted">(claim on your phone)</span></span>
        {/each}
        {#each claimedContracts as c (c.id)}
          <span class="contract-chip claimed" style="border-color:{playerHue(c.player ?? 0)}">
            📜 #{c.id} {view.players[c.player ?? 0]?.name}: {c.progress}/{c.qty} {c.good} · by t{c.deadline}
          </span>
        {/each}
      </div>
    {/if}

    <div class="grid">
      <div>
        <h2>Scoreboard</h2>
        <table>
          <thead>
            <tr><th>#</th><th>workshop</th><th class="r">score</th><th class="r">⚡</th><th class="r">⚙ sold</th><th class="r">🧿 sold</th><th class="r">waste</th><th>scripts</th></tr>
          </thead>
          <tbody>
            {#each ranked as p, i (p.index)}
              <tr animate:flip={{ duration: 400 }}>
                <td class="num muted">{i + 1}</td>
                <td>
                  {p.name}{p.online ? '' : ' 💤'}
                  <span class="agent-dot {agentLive(p.agentSeenAgoMs) ? 'live' : ''}" title={agentLive(p.agentSeenAgoMs) ? 'agent connected' : 'no agent'}>🤖</span>
                </td>
                <td class="r num score-cell">
                  {#key p.score}<span class="pop">{p.score}</span>{/key}
                </td>
                <td class="r num">{p.tokens}</td>
                <td class="r num">{p.widgetsSold}</td>
                <td class="r num">{p.charmsSold}</td>
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
            <div class={item.big ? 'theater-big' : ''}>
              {#if item.big}<img class="ticon" src="/assets/gremlin_b.png" alt="" />{/if}
              {item.line}
            </div>
          {/each}
          {#if theater.length === 0}<div class="muted">quiet… for now</div>{/if}
        </div>
      </div>
    </div>
  {/if}
</div>
