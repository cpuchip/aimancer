<script lang="ts">
  // The PHONE — one job per screen (Jackbox discipline):
  //   join → lobby → your workshop (hand of CARDS) → reveal.
  // "Ask for drafts" hits the REAL async apprentice flow (D3): pay now, the
  // model drafts in the background, cards land when ready (or a refund does).
  // Oracle/Arm/YOLO/Scrap act per card; the HINGE token stays here.
  import { clientKey, wsUrl } from './net.ts'
  import {
    DRAFT_COST_CHEAP,
    DRAFT_COST_SMART,
    ORACLE_COST,
    TOKEN_REGEN,
  } from '../shared/sim/balance.ts'
  import { describeEvent, freshEvents, newFeedCursor } from '../shared/eventFeed.ts'
  import { PHASE_BANNER, describeCondition, describeParams, predictionSummary, scriptName, verbIcon } from './ui.ts'
  import type { ClientMessage, RoomView, ServerMessage } from '../shared/protocol.ts'
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
  let customJson = $state('')
  let order = $state('') // optional steer for the apprentice (advanced layer)
  let eventLog = $state<string[]>([])
  const feedCursor = newFeedCursor()

  let ws: WebSocket | null = null

  function send(msg: ClientMessage): void {
    ws?.send(JSON.stringify(msg))
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
        workerToken = msg.workerToken
        hingeToken = msg.hingeToken
      }
      if (msg.type === 'lobby') started = msg.started
      if (msg.type === 'snapshot') {
        view = msg.view
        started = msg.view.started
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
</script>

{#if !joined}
  <h1>AIMANCER</h1>
  <p class="muted">Your AI apprentice drafts the scripts. Only YOU can arm them.</p>
  <div class="card stack">
    <input placeholder="your name" bind:value={name} maxlength="16" autocomplete="off" />
    <input placeholder="room PIN (4 letters)" bind:value={pin} maxlength="4" style="text-transform:uppercase" autocomplete="off" />
    <button class="primary" onclick={() => connect(false)} disabled={!name || pin.length !== 4}>Join room</button>
    <button onclick={() => connect(true)} disabled={!name}>Create a room</button>
    <p class="faint">Big screen: open <span class="mono">#/board/PIN</span> on the projector.</p>
  </div>
{:else}
  <div class="phase-banner phase-{phase}">
    <span class="title">{banner.title}</span>
    <span class="sub">{banner.sub}</span>
    {#if view && (phase === 'round1' || phase === 'round2') && view.ticksRemaining !== null}
      <span class="count num">{view.ticksRemaining}⏱</span>
    {/if}
  </div>

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
        <button class="primary" onclick={() => send({ type: 'start', token: hingeToken, tickMs })}>Start the game</button>
        <p class="faint">Round lengths: 12 + 19 ticks (defaults).</p>
      {/if}
    </div>
  {:else}
    {#if myShop}
      <div class="stats">
        <span class="stat">⚡ <b class="num">{myShop.tokens}</b> +{TOKEN_REGEN}/tick</span>
        <span class="stat">⛏ <b class="num">{myShop.matter}</b></span>
        <span class="stat">⚙ <b class="num">{myShop.widgets}</b></span>
        <span class="stat">★ <b class="num">{myShop.score}</b></span>
      </div>
    {/if}

    {#if lastError}<p class="err">✗ {lastError}</p>{/if}

    {#if isHost && phase !== 'reveal'}
      <button class="ghost" style="width:100%" onclick={advancePhase}>{ADVANCE_LABEL[phase] ?? '▶'}</button>
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

      <h2>Your apprentice {#if view?.apprentice === 'practice'}<span class="faint">(practice mode — no model wired)</span>{/if}</h2>
      <input placeholder="optional: tell it what you want (e.g. 'harvest fast')" bind:value={order} maxlength="200" autocomplete="off" />
      <div class="row">
        <button class="grow" onclick={() => askApprentice('cheap')} disabled={!canAct}>🤖 Ask for drafts — cheap ({DRAFT_COST_CHEAP}⚡)</button>
        <button class="grow" onclick={() => askApprentice('smart')} disabled={!canAct}>🧠 smart ({DRAFT_COST_SMART}⚡)</button>
      </div>

      <h2>Your hand</h2>
      {#if me && me.hand.length === 0 && me.pending.length === 0}
        <div class="card"><p class="muted" style="margin:0">No scripts yet — ask your apprentice for a draft.</p></div>
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
            <span>{verbIcon(card.script.verb)}</span>
            <span class="name">{scriptName(card.script)}</span>
            <span class="chip {chip.cls}">{chip.label}</span>
            {#if card.lastVerdict}
              <span class="chip {card.lastVerdict.ok ? 'green' : 'red'}">{card.lastVerdict.ok ? '🔮 green' : '🔮 RED'}</span>
            {/if}
          </div>
          <div class="desc">
            {#each describeParams(card.script) as line, i (i)}<div>{line}</div>{/each}
            {#if describeCondition(card.script)}<div>⏳ {describeCondition(card.script)}</div>{/if}
            <div class="faint mono">{card.script.verb} · {card.script.id}</div>
          </div>
          {#if card.lastVerdict && !card.lastVerdict.ok}
            <div class="verdict red">{card.lastVerdict.reasons.join(' · ')}</div>
          {:else if report && report.ok}
            <div class="verdict green">
              {predictionSummary(report)}
              {#if report.reasons.length}<div class="faint">{report.reasons.join(' · ')}</div>{/if}
            </div>
          {/if}
          {#if !gone && canAct}
            <div class="actions">
              <button class="oracle" disabled={!oracleAvailable} title={oracleAvailable ? '' : "the oracle hasn't been invented yet"}
                onclick={() => send({ type: 'oracle', token: hingeToken, id: card.script.id })}>
                🔮 Oracle {oracleAvailable ? `${ORACLE_COST}⚡` : '(round 2)'}
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
        <textarea rows="3" placeholder={'{"id":"x1","verb":"harvest","params":{"rate":3}}'} bind:value={customJson}></textarea>
        <button onclick={() => draftCustom()} disabled={!customJson || !canAct}>draft custom ({DRAFT_COST_CHEAP}⚡)</button>
      </details>
    {/if}

    <h2>Workshop feed</h2>
    <div class="events">
      {#each eventLog as line, i (i)}<div>{line}</div>{/each}
    </div>

    <details>
      <summary class="faint">agent tokens (D3/D4: hand these to your apprentice)</summary>
      <pre class="mono faint" style="white-space:pre-wrap;word-break:break-all">worker: {workerToken}
(the hinge token stays on YOUR phone)</pre>
    </details>
  {/if}
{/if}
