<script lang="ts">
  // The BIG SCREEN — the LIVING SETTLEMENT. Storm countdown big, the wall
  // visibly absorbing, districts ringing the ark, milestone progress, the
  // launch-vote tally, and the end screen. Spectator ws — no sources, no
  // tokens (redacted server-side; wstest proves it).
  import { flip } from 'svelte/animate'
  import { wsUrl } from './net.ts'
  import { describeEvent, freshEvents, isDisaster, isTriumph, newFeedCursor } from '../shared/eventFeed.ts'
  import { MILESTONE_ORDER } from '../shared/sim/types.ts'
  import { districtPos, fmtClock, statusIcon, stormUrgency, STRUCTURE_ICON, STRUCTURE_LABEL } from './ui.ts'
  import type { RoomView, ServerMessage } from '../shared/protocol.ts'

  const { pin }: { pin: string } = $props()

  let view = $state<RoomView | null>(null)
  let status = $state('connecting…')
  let theater = $state<Array<{ line: string; big: boolean; good: boolean; key: number }>>([])
  const feedCursor = newFeedCursor()
  let feedKey = 0
  let stormFlare = $state(0)

  // wall-clock interpolation between snapshots
  let snapAt = $state(0)
  let clockNow = $state(0)
  setInterval(() => (clockNow = performance.now()), 500)

  const ws = new WebSocket(wsUrl())
  ws.onopen = () => ws.send(JSON.stringify({ type: 'watch', room: pin }))
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage
    if (msg.type === 'snapshot') {
      snapAt = performance.now()
      const v = msg.view
      view = v
      status = 'live'
      const names = (i: number) => v.dyads[i]?.name ?? `D${i}`
      const fresh = freshEvents(feedCursor, v.events, v.eventSeq)
      if (fresh.length > 0) {
        if (fresh.some((e) => e.t === 'stormLanded')) stormFlare++
        theater = [
          ...fresh.map((e) => ({ line: describeEvent(e, names), big: isDisaster(e), good: isTriumph(e), key: feedKey++ })).reverse(),
          ...theater,
        ].slice(0, 26)
      }
    }
    if (msg.type === 'error') status = msg.message
  }
  ws.onclose = () => (status = 'disconnected')

  const urgency = $derived(view ? stormUrgency(view.storm.inTicks) : 'calm')
  const wallPct = $derived(view ? Math.min(100, Math.round((100 * view.structures.wall.hp) / Math.max(1, view.structures.wall.hpMax))) : 0)
  const arkPct = $derived(view ? Math.min(100, Math.round((100 * view.structures.ark.parts) / view.structures.ark.partsRequired)) : 0)
  const ranked = $derived(view ? [...view.dyads].sort((a, b) => b.contributed - a.contributed) : [])
  // LIVE ACTIVITY: a shuttle dot per actively-gathering script (parsed from
  // the public lastNote — "+4 ore from vein #2"), vein → district. The
  // projector shows the swarm working.
  const shuttles = $derived(
    view
      ? view.dyads.flatMap((d) => {
          const pos = districtPos(d.index, view!.dyads.length)
          return d.scripts
            .map((sc) => {
              if (sc.status !== 'running' || !sc.lastNote) return null
              const m = sc.lastNote.match(/ore from vein #(\d+)/)
              if (!m) return null
              const vein = view!.veins.find((v) => v.id === Number(m[1]))
              if (!vein) return null
              return { key: `${d.index}:${sc.id}`, x: vein.x, y: vein.y, dx: pos.x - vein.x, dy: pos.y - vein.y, verified: sc.verified }
            })
            .filter((w): w is NonNullable<typeof w> => w !== null)
        })
      : [],
  )
  const chronicleFeed = $derived(view ? [...view.chronicle].reverse().slice(0, 8) : [])
  const stormClockMs = $derived(view && view.nextTickInMs !== null ? Math.max(0, (view.storm.inTicks - 1) * view.tickMs + view.nextTickInMs - (clockNow - snapAt)) : null)
  const agentLive = (agoMs: number | null) => agoMs !== null && agoMs + (clockNow - snapAt) < 60_000
</script>

<div class="board">
  <div class="board-head">
    <img class="board-emblem" src="/assets/emblem.png" alt="" />
    <span class="wordmark">AIMANCER</span>
    <span class="muted board-tag">one settlement · real scripts · the storm is coming</span>
  </div>

  {#if view && view.launched && view.end}
    <div class="phase-banner phase-reveal">
      <span class="title">{view.endedEarly ? '🌙 THE HOST CALLED IT' : '🚀 THE ARK HAS LAUNCHED'}</span>
      <span class="sub">{view.endedEarly ? 'the settlement rests' : `${view.end.goVotes} GO of ${view.end.dyads.length} dyads`} · {view.end.stormsWeathered} storms weathered · {view.end.survivors} survivors {view.endedEarly ? 'sheltering' : 'aboard'} · {view.end.totalParts} parts built</span>
    </div>
    <div class="delta-total">
      THE SETTLEMENT HELD FOR <span class="delta-pos">{view.end.launchedAtTick}</span> TICKS
      <div class="muted" style="font-size:var(--t-md); font-weight:400">verification was armor — read the storm-damage column</div>
    </div>
    <table>
      <thead><tr><th>district</th><th class="r">parts given</th><th class="r">storm damage</th><th class="r">scripts verified</th><th class="r">killed</th><th>stood?</th></tr></thead>
      <tbody>
        {#each [...view.end.dyads].sort((a, b) => b.contributed - a.contributed) as d (d.district)}
          <tr>
            <td>{d.name}</td>
            <td class="r num score-cell">{d.contributed}</td>
            <td class="r num">{d.stormDamage}</td>
            <td class="r num">{d.scriptsVerified}/{d.scriptsDeployed}</td>
            <td class="r num">{d.scriptsKilled}</td>
            <td>{d.survived ? '🏠 stood' : '🌪 rubble'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="muted" style="text-align:center">the books are open — every script source is public in the room log · same PIN = same world, run it back</p>
  {:else if view && view.phase === 'gathering'}
    <!-- GATHERING — the join-teaching screen: the room reads THIS while seats fill -->
    <div class="card lobby-hero" style="text-align:center; padding:var(--s-7)">
      <img class="lobby-emblem" src="/assets/emblem.png" alt="" />
      <p class="muted" style="font-size:var(--t-xl); margin:0">join at <b style="color:var(--ink)">{location.host}</b> · PIN</p>
      <div style="font-size:var(--t-3xl); font-weight:700; letter-spacing:0.3em">{pin}</div>
      <div class="stack" style="gap:var(--s-2); max-width:560px; margin:var(--s-4) auto 0; text-align:left">
        <div>1️⃣ open <b>{location.host}</b> on your phone and JOIN with the PIN — you and your AI are one <b>dyad</b>, one district</div>
        <div>2️⃣ tap <b>connect your agent</b> and paste the prompt into YOUR agent (Claude Code / codex / copilot) — or play from the templates, no agent needed</div>
        <div>3️⃣ write and deploy scripts NOW — they arm quietly and hold; read the rules at <b>/wiki</b></div>
      </div>
      <p style="font-size:var(--t-lg); margin-top:var(--s-4)"><b>🔔 the world begins when the host calls it</b></p>
      {#if view.dyads.length > 0}
        <p class="muted">seated: {view.dyads.map((d) => d.name).join(' · ')}</p>
      {:else}
        <p class="muted">nobody home yet — the first phone in founds the settlement</p>
      {/if}
    </div>
  {:else}
    <!-- THE STORM BANNER — the whole room watches this number -->
    <div class="storm-banner storm-{urgency}" style="font-size:var(--t-xl)">
      <span class="storm-icon">🌩</span>
      <b>STORM {view?.storm.index ?? '…'}</b>
      {#if view}
        <span class="count num">{view.storm.inTicks} ticks{stormClockMs !== null ? ` · ${fmtClock(stormClockMs)}` : ''}</span>
        <span>severity <b class="num">{view.storm.severity}</b></span>
        <span class="grow"></span>
        <span>🧱 wall <b class="num">{view.structures.wall.hp}</b>/{view.structures.wall.hpMax}</span>
        <div class="ms-bar" style="width:120px"><div class="ms-fill" class:ms-low={wallPct < 30} style="width:{wallPct}%"></div></div>
      {:else}
        <span class="muted">{status}</span>
      {/if}
    </div>

    <div class="row" style="justify-content:space-between">
      <span class="join-hint muted">join at <b style="letter-spacing:normal">{location.host}</b> · PIN <b>{pin}</b> · drop in anytime</span>
      {#if view}
        <span class="row" style="gap:var(--s-4)">
          {#if view.arkReady}
            <span class="trend up">🚀 VOTE OPEN: {view.votes.go} GO · {view.votes.noGo} NO-GO · {view.votes.pending} thinking</span>
          {/if}
          {#if view.survivors > 0}<span class="trend">🧍 {view.survivors} survivors · slots {view.scriptSlots}</span>{/if}
          <span class="muted num">tick {view.tick} · {view.tickMs / 1000}s</span>
        </span>
      {/if}
    </div>

    {#if view}
      <!-- ── THE SETTLEMENT MAP ──────────────────────────────────────────── -->
      <div class="map" class:map-rush={urgency === 'imminent'}>
        {#key stormFlare}<span class="nest-flare" class:go={stormFlare > 0} style="left:50%; top:40%"></span>{/key}
        <div class="zone zone-fields"><span class="zone-label">ore fields</span></div>
        <div class="zone zone-wastes"><span class="zone-label">the storm horizon</span></div>

        <!-- the wall: a ring whose glow is its HP -->
        <div class="wallring" class:done={view.structures.wall.complete} style="opacity:{0.25 + 0.75 * (wallPct / 100)}"></div>

        <!-- the ark rises in the center -->
        <div class="ark-center">
          <div class="ark-body" style="filter:saturate({0.3 + 0.7 * (arkPct / 100)})">🚀</div>
          <div class="ms-bar" style="width:90px"><div class="ms-fill" style="width:{arkPct}%"></div></div>
          <span class="vein-tag num">ARK {view.structures.ark.parts}/{view.structures.ark.partsRequired}</span>
        </div>

        <!-- shared works flank the ark -->
        <div class="works-chip" class:built={view.structures.granary.complete} style="left:38%; top:34%">🌾<span class="vein-tag num">{view.structures.granary.complete ? `${view.granaryFood} food` : `${view.structures.granary.parts}/${view.structures.granary.partsRequired}`}</span></div>
        <div class="works-chip" class:built={view.structures.beacon.complete} style="left:60%; top:34%">🗼<span class="vein-tag num">{view.structures.beacon.complete ? `${view.survivors} in` : `${view.structures.beacon.parts}/${view.structures.beacon.partsRequired}`}</span></div>

        {#each view.veins as v (v.id)}
          <div class="vein" class:dry={v.reserve <= 0} class:fresh={v.spawnedAt > 0 && view.tick - v.spawnedAt <= 2} style="left:{v.x}%; top:{v.y}%">
            <span class="vein-ping"></span>
            <img class="vein-img" src="/assets/res_matter.png" alt="vein" />
            <div class="vein-fill"><div class="vein-fill-bar" style="height:{Math.round((100 * v.reserve) / Math.max(1, v.reserveMax))}%"></div></div>
            <span class="vein-tag num">#{v.id} · r{v.rate}{v.reserve <= 0 ? ' · DRY' : ''}</span>
          </div>
        {/each}

        <!-- the swarm at work: one shuttle per actively-gathering script -->
        {#each shuttles as w (w.key)}
          <span
            class="worker"
            style="left:{w.x}%; top:{w.y}%; background:{w.verified ? 'var(--ok-strong, #2e8b57)' : '#b8860b'}; --dx:{w.dx}cqw; --dy:{w.dy}cqh"
          ></span>
        {/each}

        <!-- districts ring the settlement -->
        {#each view.dyads as d (d.index)}
          {@const pos = districtPos(d.index, view.dyads.length)}
          <div class="district-chip" class:hurt={d.integrity < 50} class:rubble={d.integrity <= 0} style="left:{pos.x}%; top:{pos.y}%">
            <span class="dname">{d.name.slice(0, 10)}{agentLive(d.agentSeenAgoMs) ? ' 🤖' : ''}</span>
            <div class="ms-bar" style="width:64px"><div class="ms-fill" class:ms-low={d.integrity < 40} style="width:{d.integrity}%"></div></div>
            <span class="dscripts">{#each d.scripts.filter((s) => s.status !== 'stopped') as sc (sc.id)}<span title="{sc.name}: {sc.lastNote ?? sc.status}">{statusIcon(sc)}</span>{/each}</span>
          </div>
        {/each}
      </div>

      <!-- milestones row -->
      <div class="row" style="gap:var(--s-4); flex-wrap:wrap">
        {#each MILESTONE_ORDER as k (k)}
          {@const st = view.structures[k]}
          <div class="ms-row grow" class:ms-done={st.complete} class:ms-frontier={view.frontier === k} style="min-width:180px">
            <span class="ms-label">{STRUCTURE_ICON[k]} {STRUCTURE_LABEL[k]}</span>
            <div class="ms-bar grow"><div class="ms-fill" style="width:{Math.min(100, (100 * st.parts) / st.partsRequired)}%"></div></div>
            <span class="num muted">{st.complete ? '✓' : `${st.parts}/${st.partsRequired}`}</span>
          </div>
        {/each}
      </div>

      <div class="grid">
        <div>
          <h2>The dyads</h2>
          <table>
            <thead><tr><th>district</th><th class="r">⚡</th><th class="r">⛏ ore</th><th class="r">🌾</th><th class="r">🧩 parts</th><th class="r">given</th><th class="r">🏠</th><th>scripts</th><th>vote</th></tr></thead>
            <tbody>
              {#each ranked as d (d.index)}
                <tr animate:flip={{ duration: 400 }}>
                  <td>{d.name}{d.online ? '' : ' 💤'}<span class="agent-dot {agentLive(d.agentSeenAgoMs) ? 'live' : ''}" title={agentLive(d.agentSeenAgoMs) ? 'agent connected' : 'no agent'}>🤖</span></td>
                  <td class="r num">{d.tokens}</td>
                  <td class="r num">{d.ore}</td>
                  <td class="r num">{d.food}</td>
                  <td class="r num">{d.parts}</td>
                  <td class="r num score-cell">{#key d.contributed}<span class="pop">{d.contributed}</span>{/key}</td>
                  <td class="r num">{d.integrity}</td>
                  <td>{#each d.scripts.filter((s) => s.status !== 'stopped') as sc (sc.id)}<span title="{sc.name} ({sc.scope}{sc.verified ? ', verified' : ''}): {sc.lastNote ?? sc.status}">{statusIcon(sc)}</span>{/each}</td>
                  <td>{d.vote === true ? '🚀' : d.vote === false ? '🛑' : ''}</td>
                </tr>
              {/each}
              {#if ranked.length === 0}
                <tr><td colspan="9" class="muted">nobody home yet — join at {location.host} · PIN {pin}</td></tr>
              {/if}
            </tbody>
          </table>
          <p class="faint">🟢 verified · 🧨 unverified (storm bait) · 🌪💀 storm casualty — the wall absorbs for EVERYONE; contribute through the gate</p>
        </div>
        <div>
          <h2>The record</h2>
          <div class="events">
            {#each theater as item (item.key)}
              <div class={item.big ? 'theater-big' : item.good ? 'theater-good' : ''}>{item.line}</div>
            {/each}
            {#if theater.length === 0}<div class="muted">quiet… build while it lasts</div>{/if}
          </div>
          <h2>📜 The Chronicle <span class="muted num" style="font-size:var(--t-sm)">({view.chronicleCount})</span></h2>
          <div class="events">
            {#each chronicleFeed as c (c.id)}
              <div class={c.kind === 'discovery' ? 'theater-good' : ''}>
                {c.kind === 'discovery' ? '🗝' : '·'} <b>{view.dyads[c.author]?.name ?? `D${c.author}`}</b> {c.text}
                {#if c.relatesTo.length > 0}<span class="faint num"> ↩ #{c.relatesTo.join(' #')}</span>{/if}
              </div>
            {/each}
            {#if chronicleFeed.length === 0}<div class="muted">nothing written yet — the first discovery starts the book</div>{/if}
          </div>
        </div>
      </div>
    {:else}
      <div class="card lobby-hero" style="text-align:center; padding:var(--s-7)">
        <img class="lobby-emblem" src="/assets/emblem.png" alt="" />
        <p class="muted" style="font-size:var(--t-xl); margin:0">join at <b style="color:var(--ink)">{location.host}</b> · PIN</p>
        <div style="font-size:var(--t-3xl); font-weight:700; letter-spacing:0.3em">{pin}</div>
        <p class="muted">{status}</p>
      </div>
    {/if}
  {/if}
</div>
