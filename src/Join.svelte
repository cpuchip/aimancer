<script lang="ts">
  // The PHONE — your DISTRICT view. Join the settlement, write/deploy REAL
  // Starlark scripts (template library = the agentless floor), watch each
  // script's per-tick yield, run the oracle, connect your agent, and — when
  // the ark stands — cast the GO/NO-GO vote (the hinge lives HERE, never in
  // the agent's API).
  import { clientKey, wsUrl } from './net.ts'
  import { TEMPLATES } from '../shared/templates.ts'
  import { MILESTONE_ORDER } from '../shared/sim/types.ts'
  import type { GatePolicy, GateRequirement } from '../shared/gatePolicy.ts'
  import type { BetaReport, RoomView, ServerMessage } from '../shared/protocol.ts'
  import { fmtClock, scopeBadge, statusIcon, stormUrgency, STRUCTURE_ICON, STRUCTURE_LABEL } from './ui.ts'

  let pin = $state('')
  let name = $state(localStorage.getItem('aimancer-name') ?? '')
  let status = $state('')
  let joined = $state(false)
  let roomPin = $state('')
  let isHost = $state(false)
  let workerToken = $state('')
  let hingeToken = $state('')
  let view = $state<RoomView | null>(null)
  let toast = $state('')
  let toastTimer: ReturnType<typeof setTimeout> | null = null

  // editor state
  let source = $state(TEMPLATES[0].source)
  let scriptName = $state(TEMPLATES[0].name)
  let scope = $state<'district' | 'shared'>(TEMPLATES[0].scope)
  let templateId = $state(TEMPLATES[0].id)
  let deployBusy = $state(false)
  let gateReport = $state<string[] | null>(null)
  let betaBusy = $state(false)
  let betaTicks = $state(3)
  let betaReport = $state<BetaReport | null>(null)
  let chronText = $state('')
  let serial = 1

  const GATE_SCOPES: Array<'district' | 'shared'> = ['shared', 'district']
  const GATE_REQS: GateRequirement[] = ['oracle-green', 'beta-pass']

  let ws: WebSocket | null = null

  function say(msg: string): void {
    toast = msg
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast = ''), 6000)
  }

  function connect(target: string): void {
    status = 'connecting…'
    ws = new WebSocket(wsUrl())
    ws.onopen = () => ws!.send(JSON.stringify({ type: 'join', room: target, name: name.trim() || 'Dyad', key: clientKey() }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as ServerMessage
      if (msg.type === 'welcome') {
        joined = true
        roomPin = msg.room
        isHost = msg.isHost
        workerToken = msg.workerToken
        hingeToken = msg.hingeToken
        localStorage.setItem('aimancer-name', name.trim())
        status = ''
      }
      if (msg.type === 'snapshot') view = msg.view
      if (msg.type === 'error') {
        if (!joined) status = msg.message
        else say(msg.message)
      }
    }
    ws.onclose = () => {
      if (joined) say('connection lost — refresh to rejoin')
      else if (!status || status === 'connecting…') status = 'connection lost'
    }
  }

  async function api(path: string, token: string, body: unknown, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`/api/room/${roomPin}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-aimancer-phone': '1' },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }

  function pickTemplate(id: string): void {
    const t = TEMPLATES.find((x) => x.id === id)
    if (!t) return
    templateId = id
    source = t.source
    scriptName = t.name
    scope = t.scope
    gateReport = null
  }

  async function deploy(): Promise<void> {
    deployBusy = true
    gateReport = null
    const r = await api('deploy', workerToken, { id: `p${serial++}x${Date.now() % 1000}`, name: scriptName, source, scope })
    deployBusy = false
    if (r.status === 200) {
      const verified = r.json['verified'] === true
      say(scope === 'shared' ? (verified ? '🟢 deployed to the SHARED works (verified by your gate)' : 'deployed to the SHARED works — unverified (storm bait until you verify)') : 'deployed to your district')
    } else {
      const rep = r.json['report'] as { reasons?: string[] } | undefined
      gateReport = rep?.reasons ?? [String(r.json['error'] ?? 'refused')]
      say(String(r.json['error'] ?? 'refused'))
    }
  }

  async function betaRun(): Promise<void> {
    betaBusy = true
    betaReport = null
    const r = await api('beta-run', workerToken, { script: source, scope, ticks: betaTicks })
    betaBusy = false
    if (r.status !== 200) return say(String(r.json['error'] ?? 'the yard refused'))
    betaReport = r.json['report'] as BetaReport
    say(betaReport.ok ? '🪞 beta PASS — this exact script satisfies a beta-pass gate' : '🪞 beta FAILED — read the mirror')
  }

  async function setGate(gscope: 'district' | 'shared', req: GateRequirement, on: boolean): Promise<void> {
    const cur: GatePolicy = view?.you?.gatePolicy ?? { district: [], shared: [] }
    const next: GatePolicy = { district: [...cur.district], shared: [...cur.shared] }
    if (on && !next[gscope].includes(req)) next[gscope] = [...next[gscope], req]
    if (!on) next[gscope] = next[gscope].filter((x) => x !== req)
    const r = await api('gate-policy', hingeToken, next, 'PUT')
    say(r.status === 200 ? `your ${gscope} gate: ${(r.json['policy'] as GatePolicy)[gscope].join(' + ') || 'none'}` : String(r.json['error']))
  }

  async function postChronicle(): Promise<void> {
    const text = chronText.trim()
    if (!text) return
    const r = await api('chronicle', workerToken, { text })
    if (r.status === 200) {
      chronText = ''
      say('📜 posted to the chronicle')
    } else say(String(r.json['error']))
  }

  async function endGame(): Promise<void> {
    if (!confirm('End the game for everyone? The end screen shows as it stands, then the settlement closes.')) return
    const r = await api('end', hingeToken, {})
    if (r.status !== 200) say(String(r.json['error']))
  }

  async function oracleCheck(id: string): Promise<void> {
    const r = await api('oracle', workerToken, { id })
    if (r.status !== 200) return say(String(r.json['error']))
    const rep = r.json['report'] as { ok: boolean; reasons: string[] }
    say(rep.ok ? `🟢 ${id} verified — storm-armored` : `🔴 ${id}: ${rep.reasons[0] ?? 'red'}`)
  }

  async function undeploy(id: string): Promise<void> {
    const r = await api('undeploy', workerToken, { id })
    if (r.status !== 200) say(String(r.json['error']))
  }

  async function vote(go: boolean): Promise<void> {
    const r = await api('vote', hingeToken, { go })
    say(r.status === 200 ? (go ? '🚀 your GO is on the board' : '🛑 NO-GO recorded') : String(r.json['error']))
  }

  async function launch(): Promise<void> {
    const r = await api('launch', hingeToken, {})
    if (r.status !== 200) say(String(r.json['error']))
  }

  async function startWorld(): Promise<void> {
    const r = await api('start', hingeToken, {})
    if (r.status !== 200) say(String(r.json['error']))
  }

  async function copyAgentPrompt(): Promise<void> {
    const res = await fetch(`/api/room/${roomPin}/agent-prompt?token=${workerToken}`)
    if (!res.ok) return say('could not fetch the prompt')
    await navigator.clipboard.writeText(await res.text())
    say('agent prompt copied — paste it into YOUR agent')
  }

  function loadIntoEditor(src: string, nm: string, sp: 'district' | 'shared'): void {
    source = src
    scriptName = nm
    scope = sp
    say('source loaded into the editor')
  }

  const you = $derived(view && view.you ? view.dyads[view.you.index] : null)
  const myScripts = $derived(view?.you?.scripts ?? [])
  const runningCount = $derived(myScripts.filter((s) => s.status === 'running').length)
  const urgency = $derived(view ? stormUrgency(view.storm.inTicks) : 'calm')
  const majority = $derived(view ? view.votes.go * 2 > view.dyads.length : false)
  const stormClockMs = $derived(view && view.nextTickInMs !== null ? Math.max(0, (view.storm.inTicks - 1) * view.tickMs + view.nextTickInMs) : null)
</script>

{#if !joined}
  <div class="hero">
    <img class="hero-emblem" src="/assets/emblem.png" alt="" />
    <h1 class="wordmark">AIMANCER</h1>
    <p class="muted">co-op ark-building · your agent writes REAL scripts · the storm is coming</p>
    <div class="card stack">
      <input placeholder="settlement PIN (blank = found a new one)" bind:value={pin} maxlength="4" style="text-transform:uppercase" />
      <input placeholder="dyad name" bind:value={name} maxlength="16" />
      <button class="primary" onclick={() => connect(pin.trim())}>{pin.trim() ? 'JOIN THE SETTLEMENT' : 'FOUND A SETTLEMENT'}</button>
      {#if status}<div class="err">{status}</div>{/if}
      <p class="faint">drop in anytime — no rounds, no late penalty · big screen: <span class="mono">/#/board/PIN</span> · rules: <a href="/wiki">/wiki</a></p>
    </div>
  </div>
{:else if view && view.launched && view.end}
  <div class="stack" style="padding:var(--s-4); max-width:560px; margin:0 auto">
    <div class="phase-banner phase-reveal">
      <span class="title">{view.endedEarly ? '🌙 THE HOST CALLED IT' : '🚀 THE ARK HAS LAUNCHED'}</span>
      <span class="sub">{view.endedEarly ? `the settlement rests at tick ${view.end.launchedAtTick}` : `${view.end.goVotes} GO of ${view.end.dyads.length} dyads · tick ${view.end.launchedAtTick}`} · {view.end.stormsWeathered} storms weathered · {view.end.survivors} survivors {view.endedEarly ? 'sheltering' : 'aboard'}</span>
    </div>
    <table>
      <thead><tr><th>district</th><th class="r">parts given</th><th class="r">storm dmg</th><th class="r">verified</th><th>stood?</th></tr></thead>
      <tbody>
        {#each [...view.end.dyads].sort((a, b) => b.contributed - a.contributed) as d (d.district)}
          <tr>
            <td>{d.name}{view.you && d.district === view.you.index ? ' (you)' : ''}</td>
            <td class="r num">{d.contributed}</td>
            <td class="r num">{d.stormDamage}</td>
            <td class="r num">{d.scriptsVerified}/{d.scriptsDeployed}</td>
            <td>{d.survived ? '🏠 stood' : '🌪 rubble'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="muted">the books are open — every script's source is public in the room log now. Same PIN next time replays the same world.</p>
  </div>
{:else if view}
  <div class="stack" style="padding:var(--s-3); max-width:560px; margin:0 auto">
    <div class="row" style="justify-content:space-between">
      <span><span class="wordmark" style="font-size:var(--t-lg)">AIMANCER</span> <b>{roomPin}</b>{isHost ? ' · host' : ''}</span>
      <span class="muted num">tick {view.tick}</span>
    </div>

    {#if view.phase === 'gathering'}
      <!-- GATHERING — the world holds still until the host rings the bell -->
      <div class="card vote-panel" style="text-align:center">
        <b>🔔 GATHERING — the world is frozen</b>
        <p class="muted" style="margin:var(--s-1) 0">seat up, connect your agent, arm your scripts — they hold until the world runs. No ticks, no storms, no ⚡ regen yet.</p>
        {#if isHost}
          <button class="primary" style="width:100%; font-size:var(--t-lg)" onclick={startWorld}>🔔 START THE WORLD ({view.dyads.length} dyad{view.dyads.length === 1 ? '' : 's'} seated)</button>
        {:else}
          <p style="margin:0"><b>waiting for the host to call it…</b></p>
        {/if}
      </div>
    {/if}

    <!-- THE STORM COUNTDOWN — nobody negotiates with it -->
    <div class="storm-banner storm-{urgency}">
      <span class="storm-icon">🌩</span>
      <b>STORM {view.storm.index}</b>
      <span class="num">{view.phase === 'gathering' ? `${view.storm.inTicks} ticks after the start` : `${view.storm.inTicks} ticks${stormClockMs !== null ? ` · ${fmtClock(stormClockMs)}` : ''}`} · severity {view.storm.severity}</span>
      <span class="muted">wall {view.structures.wall.hp}/{view.structures.wall.hpMax} HP</span>
    </div>

    {#if you}
      <div class="stats">
        <span class="stat">⚡ <b class="num">{you.tokens}</b></span>
        <span class="stat">⛏ <b class="num">{you.ore}</b></span>
        <span class="stat">🌾 <b class="num">{you.food}</b></span>
        <span class="stat">🧩 <b class="num">{you.parts}</b></span>
        <span class="stat" title="district integrity">🏠 <b class="num">{you.integrity}</b></span>
      </div>
    {/if}

    <!-- milestones -->
    <div class="stack" style="gap:var(--s-1)">
      {#each MILESTONE_ORDER as k (k)}
        {@const st = view.structures[k]}
        <div class="ms-row" class:ms-done={st.complete} class:ms-frontier={view.frontier === k}>
          <span class="ms-label">{STRUCTURE_ICON[k]} {STRUCTURE_LABEL[k]}</span>
          <div class="ms-bar"><div class="ms-fill" style="width:{Math.min(100, (100 * st.parts) / st.partsRequired)}%"></div></div>
          <span class="num muted">{st.complete ? '✓' : `${st.parts}/${st.partsRequired}`}</span>
        </div>
      {/each}
      {#if view.survivors > 0}<span class="faint">🧍 {view.survivors} survivors · script slots {view.scriptSlots}</span>{/if}
    </div>

    {#if view.arkReady}
      <div class="card vote-panel">
        <b>🚀 THE ARK STANDS — GO / NO-GO?</b>
        <div class="row" style="gap:var(--s-2); margin-top:var(--s-2)">
          <button class="armok grow" onclick={() => vote(true)}>GO {you?.vote === true ? '✓' : ''}</button>
          <button class="yolo grow" onclick={() => vote(false)}>NO-GO {you?.vote === false ? '✓' : ''}</button>
        </div>
        <p class="muted" style="margin:var(--s-2) 0 0">tally: {view.votes.go} GO · {view.votes.noGo} NO-GO · {view.votes.pending} thinking — this vote is YOURS; your agent has no vote endpoint</p>
        {#if isHost}
          <button class="primary" style="margin-top:var(--s-2)" disabled={!majority} onclick={launch}>
            {majority ? '🚀 CONFIRM LAUNCH (host)' : 'waiting for a majority…'}
          </button>
        {/if}
      </div>
    {/if}

    {#if toast}<div class="hint">{toast}</div>{/if}

    <!-- PRIVATE NOTICES (your gates speaking, lore answering) -->
    {#if view.you && view.you.notices.length > 0}
      <div class="card stack" style="gap:var(--s-1)">
        <b>📩 Your seat's notices</b>
        {#each view.you.notices.slice(0, 4) as n, ni (ni)}
          <div class="faint">{n.kind === 'gate-blocked' ? '🚧' : n.kind === 'gate-set' ? '⚙️' : n.kind === 'lore' ? '🗝' : '🪞'} {n.text}</div>
        {/each}
      </div>
    {/if}

    <!-- YOUR SCRIPTS -->
    <h2 style="margin:var(--s-2) 0 0">Your scripts <span class="muted num">({runningCount}/{view.scriptSlots} slots)</span></h2>
    {#each myScripts as sc (sc.id)}
      <div class="script-card">
        <div class="row" style="justify-content:space-between">
          <span>{statusIcon(sc)} <b>{sc.name}</b> <span class="vbadge" class:ok={sc.verified}>{scopeBadge(sc.scope)}{sc.verified ? ' · verified' : ''}</span></span>
          <span class="muted num">{sc.id}</span>
        </div>
        {#if sc.lastTick}
          <div class="lastrun" class:err={sc.lastTick.err !== null}>{sc.lastTick.note}</div>
          {#each sc.lastTick.logs as l, li (li)}<div class="faint mono logline">» {l}</div>{/each}
        {:else if sc.status === 'running'}
          <div class="lastrun muted">waiting for its first tick…</div>
        {/if}
        {#if sc.status === 'running'}
          <div class="actions">
            <button class="oracle" onclick={() => oracleCheck(sc.id)}>🔮 oracle ({sc.verified ? 're-check' : 'verify'})</button>
            <button class="ghost" onclick={() => undeploy(sc.id)}>undeploy</button>
            <button class="ghost" onclick={() => loadIntoEditor(sc.source, sc.name, sc.scope)}>edit ↓</button>
          </div>
        {/if}
      </div>
    {/each}
    {#if myScripts.length === 0}<p class="muted">no scripts yet — deploy a template below, or connect your agent.</p>{/if}

    <!-- NEW SCRIPT -->
    <div class="card stack">
      <b>Deploy a script</b>
      <div class="row" style="gap:var(--s-2); flex-wrap:wrap">
        {#each TEMPLATES as t (t.id)}
          <button class="ghost" class:primary={templateId === t.id} onclick={() => pickTemplate(t.id)} title={t.blurb}>{t.name}</button>
        {/each}
      </div>
      <input bind:value={scriptName} placeholder="script name" maxlength="24" />
      <textarea bind:value={source} rows="8" spellcheck="false"></textarea>
      <div class="row" style="gap:var(--s-2)">
        <button class="ghost grow" class:armok={scope === 'district'} onclick={() => (scope = 'district')}>your district</button>
        <button class="ghost grow" class:armok={scope === 'shared'} onclick={() => (scope = 'shared')}>SHARED works</button>
      </div>
      <div class="row" style="gap:var(--s-2)">
        <button class="primary grow" disabled={deployBusy} onclick={deploy}>
          {deployBusy ? 'deploying…' : scope === 'shared' ? 'DEPLOY TO SHARED (direct)' : 'DEPLOY (direct)'}
        </button>
        <button class="oracle" disabled={betaBusy} onclick={betaRun} title="rehearse in the Mirror Yard — a private fork of the current world">
          {betaBusy ? 'the mirror…' : `🪞 BETA ×${betaTicks}`}
        </button>
        <select bind:value={betaTicks} title="beta ticks">
          {#each [1, 3, 5, 10] as n (n)}<option value={n}>{n}</option>{/each}
        </select>
      </div>
      {#if gateReport}
        <div class="verdict err">
          <b>🚧 a gate held:</b>
          {#each gateReport as r, ri (ri)}<div class="mono" style="font-size:var(--t-sm)">{r}</div>{/each}
        </div>
      {/if}
      {#if betaReport}
        <div class="verdict" class:err={!betaReport.ok}>
          <b>🪞 Mirror Yard — {betaReport.ok ? 'PASS' : 'FAILED'}</b> <span class="muted num">({betaReport.ticks} ticks from tick {betaReport.fromTick})</span>
          <div class="faint num">yields: {betaReport.totals.ore} ore · {betaReport.totals.food} food · {betaReport.totals.parts} parts · {betaReport.totals.contributed} contributed</div>
          {#if betaReport.storm}
            <div class="faint">🌪 storm {betaReport.storm.index} lands in-window (severity {betaReport.storm.severity}) — your district would take {betaReport.storm.yourDamage}</div>
          {/if}
          {#each betaReport.failures.slice(0, 4) as f, fi (fi)}<div class="mono" style="font-size:var(--t-sm)">{f}</div>{/each}
          {#each betaReport.lore as l, li (li)}<div class="faint">🗝 {l}</div>{/each}
          {#each betaReport.perTick.slice(0, 3) as t (t.tick)}<div class="faint mono logline">tick {t.tick}: {t.note}</div>{/each}
        </div>
      {/if}
      <p class="faint">You deploy DIRECTLY — the server imposes no gate. Only scope=SHARED scripts can touch the shared works; unverified scripts take extra storm damage. Your own gates (below) are the discipline you choose.</p>
    </div>

    <!-- YOUR GATES (human-owned) -->
    {#if view.you}
      <div class="card stack">
        <b>⚙️ Your gates <span class="muted">(yours to set — the hinge)</span></b>
        {#each GATE_SCOPES as gscope (gscope)}
          <div class="row" style="gap:var(--s-3); flex-wrap:wrap">
            <span class="muted" style="min-width:64px">{gscope}</span>
            {#each GATE_REQS as req (req)}
              <label class="row" style="gap:var(--s-1)">
                <input
                  type="checkbox"
                  checked={view.you.gatePolicy[gscope].includes(req)}
                  onchange={(e) => setGate(gscope, req, (e.currentTarget as HTMLInputElement).checked)}
                />
                {req}
              </label>
            {/each}
          </div>
        {/each}
        <p class="faint" style="margin:0">Your agent deploys freely by default. Gates you set here bind ITS deploys (and yours): oracle-green = live dry-run must pass; beta-pass = a green Mirror Yard run of that exact script first. A wise dyad designs its own.</p>
      </div>
    {/if}

    <!-- THE CHRONICLE (phone-compact; the board carries the feed) -->
    <div class="card stack">
      <b>📜 The Chronicle <span class="muted num">({view.chronicleCount})</span></b>
      {#each [...view.chronicle].slice(-3).reverse() as c (c.id)}
        <div class="faint">{c.kind === 'discovery' ? '🗝' : '·'} <b>{view.dyads[c.author]?.name ?? `D${c.author}`}</b> {c.text}</div>
      {/each}
      <div class="row" style="gap:var(--s-2)">
        <input class="grow" placeholder="write what you learned (costs ⚡)" bind:value={chronText} maxlength="500" />
        <button class="ghost" onclick={postChronicle}>post</button>
      </div>
    </div>

    <!-- AGENT -->
    <div class="card stack">
      <b>🤖 Connect your agent</b>
      <p class="muted" style="margin:0">Copy the prompt into YOUR agent (Claude Code / codex / copilot). It gets the WORKER token — it deploys directly, within the gates you set above. The launch vote stays with your hinge token (on this phone, or handed over when YOU choose).</p>
      <button class="oracle" onclick={copyAgentPrompt}>copy the agent prompt</button>
    </div>

    {#if isHost}
      <div class="card stack">
        <b>🎛 Host controls</b>
        <button class="yolo" onclick={endGame}>🌙 END THE GAME (everyone sees the end screen, then the settlement closes)</button>
      </div>
    {/if}

    <p class="faint" style="text-align:center">board: <span class="mono">{location.host}/#/board/{roomPin}</span> · rules: <a href="/wiki">/wiki</a></p>
  </div>
{:else}
  <div class="hero"><p class="muted">joining {roomPin}…</p></div>
{/if}
