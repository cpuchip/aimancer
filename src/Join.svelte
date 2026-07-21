<script lang="ts">
  // JOIN page (D1 placeholder): PIN + name → seat; your hand as JSON cards
  // with Oracle/Arm buttons wired through the HINGE token; drafts go through
  // the WORKER token (today the human plays apprentice — D3 adds the AI).
  import { clientKey, wsUrl } from './net.ts'
  import { mulberry32 } from '../shared/rng.ts'
  import { flawScript, sampleScript } from '../shared/sim/flaws.ts'
  import { VERB_PARAMS } from '../shared/sim/balance.ts'
  import type { ClientMessage, RoomView, ServerMessage } from '../shared/protocol.ts'
  import type { DraftTier, Script } from '../shared/sim/types.ts'

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
  let reports = $state<Record<string, string>>({})
  let tickMs = $state(25000)
  let tier = $state<DraftTier>('cheap')
  let customJson = $state('')
  let draftSerial = 1
  let eventLog = $state<string[]>([])

  let ws: WebSocket | null = null
  const flawPrng = mulberry32(Date.now() >>> 0) // client-side comedy only — the sim never sees this PRNG

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
        for (const e of msg.view.events) {
          eventLog = [JSON.stringify(e), ...eventLog].slice(0, 30)
        }
      }
      if (msg.type === 'error') lastError = msg.message
      if (msg.type === 'oracleReport') {
        reports = { ...reports, [msg.id]: JSON.stringify(msg.report, null, 1) }
      }
    }
    ws.onclose = () => {
      joined = false
      view = null
    }
  }

  function nextId(): string {
    return `${name.toLowerCase().slice(0, 6) || 'me'}-${draftSerial++}-${Math.floor(Math.random() * 1000)}`
  }

  function draft(script: Script): void {
    send({ type: 'draft', token: workerToken, script, tier })
  }
  function draftVerb(verb: string): void {
    const s = sampleScript(verb, nextId())
    // mid-range params read better than minimums for a demo
    for (const sp of VERB_PARAMS[verb] ?? []) s.params[sp.name] = Math.floor((sp.min + sp.max) / 2)
    draft(s)
  }
  function draftFlawed(): void {
    const verbs = Object.keys(VERB_PARAMS)
    const base = sampleScript(verbs[Math.floor(Math.random() * verbs.length)], nextId())
    draft(flawScript(base, flawPrng).script) // the hallucination — will the oracle catch it, or will you YOLO?
  }
  function draftCustom(): void {
    try {
      draft(JSON.parse(customJson))
    } catch {
      lastError = 'custom draft is not valid JSON'
    }
  }

  const me = $derived(view?.you ?? null)
  const myShop = $derived(view && me ? view.players[me.index] : null)
</script>

<h1>AIMANCER</h1>

{#if !joined}
  <div class="card">
    <input placeholder="your name" bind:value={name} maxlength="16" />
    <input placeholder="room PIN (4 letters)" bind:value={pin} maxlength="4" style="text-transform:uppercase" />
    <button onclick={() => connect(false)} disabled={!name || pin.length !== 4}>Join room</button>
    <button onclick={() => connect(true)} disabled={!name}>Create room</button>
    <p class="muted">Big screen: open <code>#/board/PIN</code> on the room's PIN.</p>
  </div>
{:else}
  <div class="bar">
    <span>room <b>{room}</b></span>
    <span><a href={'#/board/' + room} target="_blank">board ↗</a></span>
    {#if view}
      <span>tick {view.tick}</span>
      <span>market {view.market}</span>
      <span>gremlin {view.gremlin}</span>
    {/if}
  </div>

  {#if !started}
    <div class="card">
      <p>Waiting to start…</p>
      {#if isHost}
        <select bind:value={tickMs}>
          <option value={25000}>show tick — 25s</option>
          <option value={5000}>quick tick — 5s</option>
          <option value={2000}>dev tick — 2s</option>
        </select>
        <button class="arm" onclick={() => send({ type: 'start', token: hingeToken, tickMs })}>Start game (hinge)</button>
      {/if}
    </div>
  {/if}

  {#if myShop}
    <div class="bar">
      <span>⚡ tokens <b>{myShop.tokens}</b></span>
      <span>⛏ matter <b>{myShop.matter}</b></span>
      <span>⚙ widgets <b>{myShop.widgets}</b></span>
      <span>score <b>{myShop.score}</b></span>
      <span>waste {myShop.waste}</span>
    </div>
  {/if}

  {#if lastError}<p class="err">✗ {lastError}</p>{/if}

  {#if started}
    <h2>Draft (worker surface — you are the apprentice today)</h2>
    <div class="card">
      <select bind:value={tier}>
        <option value="cheap">cheap model draft (3⚡)</option>
        <option value="smart">smart model draft (8⚡)</option>
      </select>
      {#each Object.keys(VERB_PARAMS) as verb (verb)}
        <button onclick={() => draftVerb(verb)}>{verb}</button>
      {/each}
      <button onclick={() => draftFlawed()}>hallucinate 🎲</button>
      <textarea rows="3" placeholder={'custom script JSON, e.g. {"id":"x1","verb":"harvest","params":{"rate":3}}'} bind:value={customJson}></textarea>
      <button onclick={() => draftCustom()} disabled={!customJson}>draft custom</button>
    </div>

    <h2>Your hand</h2>
    {#if me && me.hand.length === 0}<p class="muted">No scripts yet — draft something.</p>{/if}
    {#each me?.hand ?? [] as card (card.script.id)}
      <div class="card {card.armed ? 'armed' : ''} {card.status === 'dead' || card.status === 'blown' ? 'dead' : ''}">
        <div class="bar">
          <span><b>{card.script.id}</b></span>
          <span>{card.status}</span>
          {#if card.armed}<span>{card.yolo ? '⚠ YOLO' : '✓ verified'}</span>{/if}
          {#if card.lastVerdict}<span class={card.lastVerdict.ok ? 'ok' : 'err'}>{card.lastVerdict.ok ? 'oracle: green' : 'oracle: RED'}</span>{/if}
        </div>
        <pre>{JSON.stringify(card.script, null, 1)}</pre>
        {#if card.lastVerdict && !card.lastVerdict.ok}
          <p class="err">{card.lastVerdict.reasons.join(' · ')}</p>
        {/if}
        {#if reports[card.script.id]}
          <pre>{reports[card.script.id]}</pre>
        {/if}
        <button class="oracle" onclick={() => send({ type: 'oracle', token: hingeToken, id: card.script.id })}>Oracle (4⚡)</button>
        {#if card.armed}
          <button onclick={() => send({ type: 'disarm', token: hingeToken, id: card.script.id })}>Disarm</button>
        {:else if card.status !== 'dead' && card.status !== 'blown'}
          <button class="arm" onclick={() => send({ type: 'arm', token: hingeToken, id: card.script.id })}>ARM {card.everGreen ? '' : '(YOLO)'}</button>
        {/if}
      </div>
    {/each}

    <h2>Events</h2>
    <div class="events">
      {#each eventLog as line, i (i)}<div class="muted">{line}</div>{/each}
    </div>

    <details>
      <summary class="muted">agent tokens (D3/D4: hand these to your apprentice)</summary>
      <pre>worker: {workerToken}
(the hinge token stays on YOUR phone)</pre>
    </details>
  {/if}
{/if}
