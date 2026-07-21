<script lang="ts">
  // The PHONE — one job per screen (Jackbox discipline):
  //   join → lobby → your workshop (hand of CARDS) → reveal.
  // "Ask for drafts" hits the REAL async apprentice flow (D3): pay now, the
  // model drafts in the background, cards land when ready (or a refund does).
  // Oracle/Arm/YOLO/Scrap act per card; the HINGE token stays here.
  import { clientKey, wsUrl } from './net.ts'
  import {
    APPRENTICE_FLAW_CHEAP_PCT,
    APPRENTICE_FLAW_SMART_PCT,
    DRAFT_COST_CHEAP,
    DRAFT_COST_SMART,
    ORACLE_COST,
    PROSPECT_COST,
    TOKEN_REGEN,
  } from '../shared/sim/balance.ts'
  import { describeEvent, freshEvents, newFeedCursor } from '../shared/eventFeed.ts'
  import { PHASE_BANNER, describeCondition, describeParams, fmtClock, predictionSummary, scriptName, verbIcon, verbIconSrc } from './ui.ts'
  import type { ClientMessage, LobbyPlayer, RoomView, ServerMessage } from '../shared/protocol.ts'
  import type { OracleReport } from '../shared/sim/oracle.ts'
  import type { DraftTier, ScriptSlot, SimPhase } from '../shared/sim/types.ts'

  let pin = $state('')
  let name = $state('')
  let joined = $state(false)
  let isHost = $state(false)
  let room = $state('')
  let workerToken = $state('')
  let hingeToken = $state('')
  let started = $state(false)
  let view = $state<RoomView | null>(null)
  let lastError = $state('')
  let reports = $state<Record<string, OracleReport>>({})
  let tickMs = $state(25000)
  let autoAdv = $state(true) // room setting: DEFAULT ON — pickup games flow; the talk unchecks it
  let customJson = $state('')
  let order = $state('') // optional steer for the apprentice (advanced layer)
  let eventLog = $state<string[]>([])
  const feedCursor = newFeedCursor()

  // teachability nudges (dismissible, non-blocking)
  let armNudgeDismissed = $state(false)
  let oracleCalloutDismissed = $state(false)

  // wall-clock round countdown: anchored on the snapshot's nextTickInMs,
  // interpolated locally between snapshots (500ms heartbeat)
  let myIndex = $state(-1)
  let lobbyList = $state<LobbyPlayer[]>([])
  let snapAt = $state(0)
  let clockNow = $state(0)
  setInterval(() => (clockNow = performance.now()), 500)

  let ws: WebSocket | null = null

  function send(msg: ClientMessage): void {
    ws?.send(JSON.stringify(msg))
  }

  // ── Connect your agent (D4, BYO-AI): the phone holds the HINGE; the agent
  // gets a paste-prompt carrying the WORKER token. The server's agent-prompt
  // route is the single source of truth for the text — fetched eagerly on
  // welcome so the copy button can write the clipboard inside the tap gesture.
  let agentPrompt = $state('')
  let copied = $state(false)
  let promptOpen = $state(false)
  async function loadAgentPrompt(): Promise<void> {
    try {
      const r = await fetch(`/api/room/${room}/agent-prompt?token=${encodeURIComponent(workerToken)}`)
      if (r.ok) agentPrompt = await r.text()
    } catch {
      /* offline blip — the panel just shows the button disabled */
    }
  }
  function copyAgentPrompt(): void {
    navigator.clipboard?.writeText(agentPrompt).then(
      () => {
        copied = true
        setTimeout(() => (copied = false), 2500)
      },
      () => {
        promptOpen = true // no clipboard (http dev) — open the preview to long-press copy
      },
    )
  }

  function connect(create: boolean): void {
    lastError = ''
    ws = new WebSocket(wsUrl())
    ws.onopen = () => send({ type: 'join', room: create ? '' : pin, name, key: clientKey() })
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMessage
      if (msg.type === 'welcome') {
        joined = true
        isHost = msg.isHost
        room = msg.room
        myIndex = msg.index
        workerToken = msg.workerToken
        hingeToken = msg.hingeToken
        void loadAgentPrompt() // eager, so the copy button works in one tap
      }
      if (msg.type === 'lobby') {
        started = msg.started
        lobbyList = msg.players
        snapAt = performance.now()
      }
      if (msg.type === 'snapshot') {
        view = msg.view
        started = msg.view.started
        snapAt = performance.now()
        const names = (i: number) => msg.view.players[i]?.name ?? `P${i}`
        for (const e of freshEvents(feedCursor, msg.view.events, msg.view.eventSeq)) {
          eventLog = [describeEvent(e, names), ...eventLog].slice(0, 30)
        }
      }
      if (msg.type === 'error') lastError = msg.message
      if (msg.type === 'oracleReport') {
        reports = { ...reports, [msg.id]: msg.report }
      }
    }
    ws.onclose = () => {
      joined = false
      view = null
    }
  }

  /** Ask the REAL apprentice (D3): tokens debited now, the server calls the
   * model in the background, drafts land in the hand when ready (a pending
   * "drafting…" slot shows meanwhile; a timeout refunds). With no model wired
   * the server's seeded practice generator answers instead. */
  function askApprentice(tier: DraftTier): void {
    send({ type: 'draftRequest', token: workerToken, tier, order: order.trim() || undefined })
  }

  function draftCustom(): void {
    try {
      send({ type: 'draft', token: workerToken, script: JSON.parse(customJson), tier: 'cheap' })
    } catch {
      lastError = 'custom draft is not valid JSON'
    }
  }

  function advancePhase(): void {
    const next: Record<string, SimPhase | null> = { round1: 'intermission', intermission: 'round2', round2: 'reveal', reveal: null }
    const to = next[view?.phase ?? '']
    if (to) send({ type: 'phase', token: hingeToken, to })
  }

  const ADVANCE_LABEL: Record<string, string> = {
    round1: '▶ Call intermission',
    intermission: '▶ Begin ROUND 2',
    round2: '▶ The reveal',
  }

  function statusChip(card: ScriptSlot): { cls: string; label: string } {
    if (card.status === 'dead') return { cls: 'dead', label: '💀 dead' }
    if (card.status === 'blown') return { cls: 'blown', label: '🔥 blown' }
    if (card.status === 'autoDisarmed') return { cls: 'benched', label: '🔌 benched' }
    if (card.armed) return card.yolo ? { cls: 'yolo', label: '🧨 YOLO — live' } : { cls: 'armed', label: '✓ armed' }
    if (card.status === 'disarmed') return { cls: 'drafted', label: '⏸ disarmed' }
    return { cls: 'drafted', label: 'draft' }
  }

  const me = $derived(view?.you ?? null)
  const myShop = $derived(view && me ? view.players[me.index] : null)
  const phase = $derived(view?.phase ?? 'lobby')
  const banner = $derived(PHASE_BANNER[phase] ?? PHASE_BANNER.lobby)
  const oracleAvailable = $derived(phase === 'round2')
  const canAct = $derived(phase !== 'reveal')
  const myDelta = $derived(view?.delta && me ? view.delta.players[me.index] : null)

  // ── round-end + auto-advance surfacing (the "silent freeze" hotfix) ────────
  const roundComplete = $derived(view !== null && (phase === 'round1' || phase === 'round2') && view.ticksRemaining === 0)
  const autoIn = $derived(view?.autoAdvanceIn ?? null)
  const bannerTitle = $derived(roundComplete ? `${phase === 'round1' ? 'ROUND 1' : 'ROUND 2'} COMPLETE` : banner.title)
  const bannerSub = $derived(
    roundComplete
      ? autoIn !== null
        ? `advancing in ${autoIn}…`
        : view?.autoHeld
          ? 'held — the host calls it'
          : isHost
            ? 'you call it — tap the button below'
            : 'waiting for the host to call it'
      : phase === 'intermission' && autoIn !== null
        ? `round 2 in ${autoIn}s — ${isHost ? 'tap hold to keep talking' : 'the host can hold'}`
        : banner.sub,
  )
  /** Wall-clock ms left in the running round, interpolated between snapshots. */
  const roundClockMs = $derived.by(() => {
    if (!view || (phase !== 'round1' && phase !== 'round2')) return null
    const tr = view.ticksRemaining
    if (tr === null || tr <= 0 || view.nextTickInMs === null) return null
    const base = (tr - 1) * view.tickMs + view.nextTickInMs
    return Math.max(0, base - (clockNow - snapAt))
  })
  /** "agent connected" liveness — in-game from the snapshot, lobby from the lobby list. */
  const agentAgoMs = $derived.by(() => {
    const raw = view?.players[myIndex]?.agentSeenAgoMs ?? lobbyList.find((p) => p.index === myIndex)?.agentSeenAgoMs ?? null
    if (raw === null) return null
    return raw + Math.max(0, clockNow - snapAt)
  })
  // drafts in the hand but nothing armed while the round runs — the classic miss
  const armNudge = $derived(
    !armNudgeDismissed &&
      !roundComplete &&
      (phase === 'round1' || phase === 'round2') &&
      (me?.hand.some((sl) => sl.status === 'drafted') ?? false) &&
      !(me?.hand.some((sl) => sl.armed) ?? false),
  )
</script>

{#snippet howToPlay()}
  <details class="howto">
    <summary>📖 How to play (30 seconds)</summary>
    <ol>
      <li><b>You + your AI are ONE player.</b> It drafts scripts — only YOU can arm them.</li>
      <li><b>Get scripts</b> (connect your agent / ask the apprentice / write your own), then <b>ARM</b> them: harvest a map vein → refine → craft charms → SELL = score.</li>
      <li><b>Veins run DRY</b> — watch the map, re-target harvesters, prospect the next vein early.</li>
      <li><b>YOU see what your AI can't:</b> market RUSH windows (2-3×!) show on the board only — relay them, and claim contracts here (round 2).</li>
      <li><b>Round 1: no oracle exists.</b> Arm and pray. <b>Round 2:</b> pay to VERIFY — green scripts auto-renew; YOLO'd ones draw gremlin damage.</li>
      <li><b>Watch your ⚡</b> (regen each tick) and the gremlin — patch when pressure climbs.</li>
    </ol>
    <p class="faint">The bet: cheap drafts are fast, often wrong (~{APPRENTICE_FLAW_CHEAP_PCT}%); smart is pricier, usually right (~{APPRENTICE_FLAW_SMART_PCT}% flawed). Cheap+verify vs smart+trust — that's the round-2 lesson.</p>
    <p class="faint" style="margin-top:var(--s-2)"><a href="/wiki">📖 full wiki →</a></p>
  </details>
{/snippet}

{#snippet connectAgent()}
  <!-- Two surfaces, cleanly split: this phone = the HINGE (arming lives here);
       the pasted prompt = the WORKER surface for the player's OWN agent. -->
  <div class="card stack">
    <h2 style="margin-top:0">🤖 Connect your agent</h2>
    {#if agentAgoMs !== null}
      <p class="ok" style="margin:0">🤖 agent connected · {Math.max(0, Math.round(agentAgoMs / 1000))}s ago</p>
    {:else}
      <p class="faint" style="margin:0">no agent yet — copy the prompt below</p>
    {/if}
    <p class="muted">
      Your apprentice is YOUR agent — Claude Code, codex, copilot… Copy this
      prompt and paste it in: your agent drafts over HTTP, and the ARM buttons
      stay here on your phone.
    </p>
    <button class="primary" onclick={copyAgentPrompt} disabled={!agentPrompt}>
      {copied ? '✓ copied — paste it into your agent' : '📋 Copy the agent prompt'}
    </button>
    <p class="faint">
      Your agent will ask before each curl — approve it; that's the point.
      No agent? The card buttons + "ask for drafts" play the same game.
    </p>
    <details bind:open={promptOpen}>
      <summary class="faint">preview the prompt</summary>
      <pre class="mono faint" style="white-space:pre-wrap;word-break:break-all">{agentPrompt}</pre>
    </details>
  </div>
{/snippet}

{#if !joined}
  <div class="hero">
    <img class="hero-emblem" src="/assets/emblem.png" alt="" />
    <h1 class="wordmark">AIMANCER</h1>
    <p class="muted">You + your AI are <b style="color:var(--ink)">one player</b>. It drafts the scripts — only you can arm them.</p>
  </div>
  <div class="card stack">
    <input placeholder="your name" bind:value={name} maxlength="16" autocomplete="off" />
    <input placeholder="room PIN (4 letters)" bind:value={pin} maxlength="4" style="text-transform:uppercase" autocomplete="off" />
    <button class="primary" onclick={() => connect(false)} disabled={!name || pin.length !== 4}>Join room</button>
    <button onclick={() => connect(true)} disabled={!name}>Create a room</button>
  </div>
  <div class="teach">
    <ol class="teach-steps">
      <li><b>Join</b> with the room PIN above.</li>
      <li><b>Copy the agent prompt</b> into your AI — or play solo with the practice apprentice.</li>
      <li><b>Arm scripts, sell widgets</b> — and outlast the gremlin.</li>
    </ol>
    <p class="faint" style="margin:var(--s-2) 0 0">Goal: most points — widgets <b>sold</b> + uptime − waste, over two rounds: naive, then verified.</p>
    <div class="row" style="justify-content:space-between; margin-top:var(--s-2)">
      <a class="wiki-link" href="/wiki">📖 Full rules</a>
      <span class="faint">Big screen: <span class="mono">#/board/PIN</span></span>
    </div>
  </div>
  {@render howToPlay()}
{:else}
  <div class="phase-banner phase-{phase}{roundComplete ? ' complete' : ''}">
    <span class="title">{bannerTitle}</span>
    <span class="sub">{bannerSub}</span>
    {#if roundClockMs !== null}
      <span class="count num">{fmtClock(roundClockMs)} · {view?.ticksRemaining}⏱</span>
    {:else if autoIn !== null}
      <span class="count num">▶ {autoIn}s</span>
    {/if}
  </div>
  {@render howToPlay()}

  {#if !started}
    <div class="card stack">
      <div class="row"><span class="muted">room</span> <b class="mono" style="font-size:var(--t-xl); letter-spacing:0.2em">{room}</b></div>
      <p class="muted">Waiting for the host to start. Board: <a href={'#/board/' + room} target="_blank">open ↗</a></p>
      {#if isHost}
        <select bind:value={tickMs}>
          <option value={25000}>show tick — 25s</option>
          <option value={5000}>quick tick — 5s</option>
          <option value={2000}>dev tick — 2s</option>
        </select>
        <label class="row" style="gap:var(--s-2); cursor:pointer">
          <input type="checkbox" bind:checked={autoAdv} style="width:auto; min-height:0; margin:0" />
          <span class="muted">auto-advance rounds when time runs out</span>
        </label>
        <button class="primary" onclick={() => send({ type: 'start', token: hingeToken, tickMs, autoAdvance: autoAdv })}>Start the game</button>
        <p class="faint">Start when everyone's seated — players join at <b>{location.host}</b> · PIN <b class="mono">{room}</b></p>
        <p class="faint">Round lengths: 12 + 19 ticks (defaults).</p>
      {/if}
    </div>
    {@render connectAgent()}
  {:else}
    {#if myShop}
      <div class="stats">
        <span class="stat"><img class="ricon" src="/assets/res_tokens.png" alt="tokens" /> <b class="num">{myShop.tokens}</b> +{TOKEN_REGEN}/tick</span>
        <span class="stat"><img class="ricon" src="/assets/res_matter.png" alt="matter" /> <b class="num">{myShop.matter}</b></span>
        <span class="stat"><img class="ricon" src="/assets/res_widgets.png" alt="widgets" /> <b class="num">{myShop.widgets}</b></span>
        <span class="stat">🧿 <b class="num">{myShop.charms}</b></span>
        <span class="stat">★ <b class="num">{myShop.score}</b></span>
      </div>
    {/if}

    {#if view?.rush}
      <!-- the HUMAN sees the rush; the agent's API doesn't — RELAY IT -->
      <div class="rush-banner phone rush-{view.rush.good}">
        <span>{view.rush.good === 'charms' ? '🧿' : '⚙️'}</span>
        <b>{view.rush.good.toUpperCase()} RUSH ×{view.rush.mult}</b>
        <span>{view.rush.ticksLeft}t left — tell your agent!</span>
      </div>
    {/if}

    {#if lastError}<p class="err">✗ {lastError}</p>{/if}

    {#if isHost && phase !== 'reveal'}
      {#if roundComplete || (phase === 'intermission' && autoIn !== null)}
        <!-- the loud state: the round is over (or intermission is closing) — the
             advance button is now THE thing on this phone -->
        <div class="row">
          <button class="primary advance-hot grow" onclick={advancePhase}>
            {ADVANCE_LABEL[phase] ?? '▶'}{autoIn !== null ? ` — auto in ${autoIn}s` : ''}
          </button>
          {#if autoIn !== null}
            <button class="ghost" onclick={() => send({ type: 'hold', token: hingeToken })}>⏸ Hold</button>
          {/if}
        </div>
      {:else}
        <button class="ghost" style="width:100%" onclick={advancePhase}>{ADVANCE_LABEL[phase] ?? '▶'}</button>
      {/if}
    {/if}
    {#if !isHost && roundComplete}
      <p class="muted" style="text-align:center">
        ⏸ {autoIn !== null ? `next phase in ${autoIn}s — the host can hold` : view?.autoHeld ? 'held — the host will call it' : "round over — waiting for the host to call it"}
      </p>
    {/if}

    {#if phase === 'reveal'}
      {#if myDelta}
        <div class="card stack">
          <h2 style="margin-top:0">Your delta</h2>
          <div class="row" style="font-size:var(--t-xl)">
            <span class="num">{myDelta.r1.score}</span>
            <span class="muted">→</span>
            <span class="num">{myDelta.r2.score}</span>
            <span class={myDelta.dScore >= 0 ? 'delta-pos' : 'delta-neg'}>{myDelta.dScore >= 0 ? '+' : ''}{myDelta.dScore}</span>
          </div>
          <p class="muted">
            disasters {myDelta.r1.disasters} → {myDelta.r2.disasters} ·
            sold {myDelta.r1.widgetsSold} → {myDelta.r2.widgetsSold} ·
            waste {myDelta.r1.waste} → {myDelta.r2.waste}
          </p>
          <p class="faint">The room's full story is on the big screen.</p>
        </div>
      {/if}
    {:else}
      {#if phase === 'intermission' && view?.round1Summary}
        <div class="card">
          <h2 style="margin-top:0">Round 1 — how it went</h2>
          <p class="muted">score {view.round1Summary.players[me?.index ?? 0]?.score ?? 0} · disasters {view.round1Summary.players[me?.index ?? 0]?.disasters ?? 0}. The world is frozen — draft now, arm in round 2.</p>
        </div>
      {/if}

      {#if view && view.veins.length > 0}
        <h2>The map <span class="faint" style="text-transform:none; letter-spacing:normal">(⚙ {view.market}⚡ · 🧿 {view.marketCharms}⚡)</span></h2>
        <div class="card stack" style="gap:var(--s-2)">
          {#each view.veins as v (v.id)}
            <div class="vein-row" class:dry={v.reserve <= 0}>
              <span class="num" style="min-width:64px">vein #{v.id} · r{v.rate}</span>
              <div class="vein-bar"><div class="vein-bar-fill" style="width:{Math.round((100 * v.reserve) / Math.max(1, v.reserveMax))}%"></div></div>
              <span class="num" style="min-width:52px; text-align:right">{v.reserve <= 0 ? 'DRY' : `${v.reserve}/${v.reserveMax}`}</span>
            </div>
          {/each}
          {#each me?.prospects ?? [] as pr (pr.id)}
            <div class="vein-row" style="color:var(--accent)">
              <span>🔭 vein #{pr.id} — rate {pr.rate}, {pr.reserveMax} matter, surfaces in ~{pr.spawnsInTicks}t (only you know)</span>
            </div>
          {/each}
          <button class="ghost" disabled={!canAct || phase === 'intermission'} onclick={() => send({ type: 'prospect', token: hingeToken })}>
            🔭 Prospect the next vein ({PROSPECT_COST}⚡)
          </button>
        </div>
      {/if}

      {#if view && view.contracts.length > 0}
        <h2>Contracts <span class="faint" style="text-transform:none; letter-spacing:normal">(you claim — sells auto-deliver)</span></h2>
        <div class="card stack" style="gap:var(--s-2)">
          {#each view.contracts.filter((c) => c.status === 'open') as c (c.id)}
            <div class="row" style="justify-content:space-between">
              <span>📜 deliver <b>{c.qty} {c.good}</b> in {c.windowTicks}t → <b>+{c.bonus}</b></span>
              <button class="primary" style="min-height:36px" onclick={() => send({ type: 'claimContract', token: hingeToken, id: c.id })}>Claim</button>
            </div>
          {/each}
          {#each view.contracts.filter((c) => c.status === 'claimed' && c.player === me?.index) as c (c.id)}
            <div class="row" style="justify-content:space-between">
              <span>📜 #{c.id}: <b>{c.progress}/{c.qty} {c.good}</b> · deliver by t{c.deadline}</span>
              <span class="chip drafted">yours</span>
            </div>
          {/each}
          {#each view.contracts.filter((c) => c.status === 'claimed' && c.player !== me?.index) as c (c.id)}
            <div class="faint">📜 #{c.id} claimed by {view.players[c.player ?? 0]?.name} — {c.progress}/{c.qty} {c.good}</div>
          {/each}
        </div>
      {/if}

      <h2>Your apprentice {#if view?.apprentice === 'practice'}<span class="faint">(practice mode — no model wired)</span>{/if}</h2>
      <p class="faint" style="margin:var(--s-1) 0">Your apprentice drafts scripts into your hand — or connect your own agent below and it can write scripts directly.</p>
      <input placeholder="optional: tell it what you want (e.g. 'harvest fast')" bind:value={order} maxlength="200" autocomplete="off" />
      <div class="row" style="align-items:stretch">
        <div class="grow stack" style="gap:2px">
          <button onclick={() => askApprentice('cheap')} disabled={!canAct}>🤖 Ask for drafts — cheap ({DRAFT_COST_CHEAP}⚡)</button>
          <span class="faint" style="text-align:center">fast, often wrong (~{APPRENTICE_FLAW_CHEAP_PCT}%)</span>
        </div>
        <div class="grow stack" style="gap:2px">
          <button onclick={() => askApprentice('smart')} disabled={!canAct}>🧠 smart ({DRAFT_COST_SMART}⚡)</button>
          <span class="faint" style="text-align:center">pricier, usually right (~{APPRENTICE_FLAW_SMART_PCT}% flawed)</span>
        </div>
      </div>

      <h2>Your hand</h2>
      <p class="faint" style="margin:var(--s-1) 0">
        {oracleAvailable
          ? `🔮 Oracle: ${ORACLE_COST}⚡ — checks for flaws + predicts 3 ticks of yield; green scripts auto-renew (and auto-disarm if corrupted)`
          : '🔮 Oracle locked this round — no oracle exists yet. Arm and pray.'}
      </p>
      {#if oracleAvailable && !oracleCalloutDismissed}
        <div class="hint">
          <span>🔮 <b>The oracle is live.</b> Verify before you arm — verified scripts auto-renew.</span>
          <button class="x" onclick={() => (oracleCalloutDismissed = true)}>✕</button>
        </div>
      {/if}
      {#if armNudge}
        <div class="hint">
          <span>💡 Drafts do nothing until <b>ARMED</b> — tap ✅ ARM (or 🧨 YOLO) on a card.</span>
          <button class="x" onclick={() => (armNudgeDismissed = true)}>✕</button>
        </div>
      {/if}
      {#if me && me.hand.length === 0 && me.pending.length === 0}
        <div class="card"><p class="muted" style="margin:0">No scripts yet — ask your apprentice above, connect your agent, or write one below.</p></div>
      {/if}
      {#each me?.pending ?? [] as pd (pd.reqId)}
        <div class="script-card pending-card">
          <div class="row">
            <span>🤖</span>
            <span class="name">drafting<span class="dots">…</span></span>
            <span class="chip drafted">{pd.tier} · paid</span>
          </div>
          <div class="desc"><div class="faint">the apprentice is thinking — keep playing, cards land when ready</div></div>
        </div>
      {/each}
      {#each me?.hand ?? [] as card (card.script.id)}
        {@const chip = statusChip(card)}
        {@const report = reports[card.script.id]}
        {@const gone = card.status === 'dead' || card.status === 'blown'}
        <div class="script-card {gone ? 'gone' : card.armed ? (card.yolo ? 'armed-yolo' : 'armed-ok') : ''}">
          <div class="row">
            {#if verbIconSrc(card.script.verb)}
              <img class="vicon" src={verbIconSrc(card.script.verb)} alt={card.script.verb} />
            {:else}
              <span class="vicon-fallback">{verbIcon(card.script.verb)}</span>
            {/if}
            <span class="name">{scriptName(card.script)}</span>
            <span class="chip {chip.cls}">{chip.label}</span>
            {#if card.lastVerdict}
              <span class="chip {card.lastVerdict.ok ? 'green' : 'red'}">{card.lastVerdict.ok ? '🔮 green' : '🔮 RED'}</span>
            {/if}
          </div>
          <div class="desc">
            {#each describeParams(card.script) as line, i (i)}<div>{line}</div>{/each}
            {#if describeCondition(card.script)}<div>⏳ {describeCondition(card.script)}</div>{/if}
            {#if card.armed && card.lastRun}
              <div class="lastrun {card.lastRun.ran && card.lastRun.note.length && !card.lastRun.note.includes('starved') && !card.lastRun.note.includes('nothing') ? 'live' : 'idle'}">
                ▸ last tick: {card.lastRun.note}
              </div>
            {/if}
            <div class="faint mono">{card.script.verb} · {card.script.id}</div>
          </div>
          {#if card.lastVerdict && !card.lastVerdict.ok}
            <div class="verdict red"><img class="vbadge" src="/assets/oracle_eye.png" alt="oracle verdict" /> {card.lastVerdict.reasons.join(' · ')}</div>
          {:else if report && report.ok}
            <div class="verdict green">
              <img class="vbadge" src="/assets/oracle_eye.png" alt="oracle verdict" />
              {predictionSummary(report)}
              {#if report.reasons.length}<div class="faint">{report.reasons.join(' · ')}</div>{/if}
            </div>
          {/if}
          {#if !gone && canAct}
            <div class="actions">
              <button class="oracle" disabled={!oracleAvailable} title={oracleAvailable ? '' : "the oracle hasn't been invented yet"}
                onclick={() => send({ type: 'oracle', token: hingeToken, id: card.script.id })}>
                <img class="bicon" src="/assets/oracle_eye.png" alt="" /> Oracle {oracleAvailable ? `${ORACLE_COST}⚡` : '(round 2)'}
              </button>
              {#if card.armed}
                <button onclick={() => send({ type: 'disarm', token: hingeToken, id: card.script.id })}>⏸ Disarm</button>
              {:else if card.everGreen}
                <button class="armok" onclick={() => send({ type: 'arm', token: hingeToken, id: card.script.id })}>✅ ARM</button>
              {:else}
                <button class="yolo" onclick={() => send({ type: 'arm', token: hingeToken, id: card.script.id })}>🧨 YOLO-ARM</button>
              {/if}
              {#if !card.armed}
                <button class="ghost" onclick={() => send({ type: 'scrap', token: hingeToken, id: card.script.id })}>🗑 Scrap</button>
              {/if}
            </div>
          {:else if gone}
            <div class="actions">
              <button class="ghost" onclick={() => send({ type: 'scrap', token: hingeToken, id: card.script.id })}>🗑 Scrap the wreck</button>
            </div>
          {/if}
        </div>
      {/each}

      <details>
        <summary class="muted">advanced: hand-write a script</summary>
        <textarea rows="3" placeholder={'{"id":"x1","verb":"harvest","params":{"rate":3,"node":1}}'} bind:value={customJson}></textarea>
        <button onclick={() => draftCustom()} disabled={!customJson || !canAct}>draft custom ({DRAFT_COST_CHEAP}⚡)</button>
      </details>
    {/if}

    <h2>Workshop feed</h2>
    <div class="events">
      {#each eventLog as line, i (i)}<div>{line}</div>{/each}
    </div>

    {@render connectAgent()}
  {/if}
{/if}
