<script lang="ts">
  // BOARD page (D1 placeholder): the public room state + scoreboard,
  // auto-refreshing over ws as a spectator. No hands, no tokens — redacted
  // server-side (wstest proves it).
  import { wsUrl } from './net.ts'
  import type { RoomView, ServerMessage } from '../shared/protocol.ts'

  const { pin }: { pin: string } = $props()

  let view = $state<RoomView | null>(null)
  let status = $state('connecting…')
  let eventLog = $state<string[]>([])

  function describe(e: Record<string, unknown>): string {
    const who = (i: unknown) => view?.players[i as number]?.name ?? `P${i}`
    switch (e.t) {
      case 'drafted': return `${who(e.player)} accepted a ${e.tier} draft (${e.id})`
      case 'oracle': return `${who(e.player)} consulted the oracle on ${e.id}: ${e.ok ? 'GREEN ✓' : 'RED ✗'}`
      case 'armed': return `${who(e.player)} ARMED ${e.id}${e.yolo ? ' — YOLO! ⚠' : ' (verified)'}`
      case 'disarmed': return `${who(e.player)} disarmed ${e.id}`
      case 'autoDisarm': return `🔌 the oracle BENCHED ${who(e.player)}'s ${e.id}: ${e.reason}`
      case 'misfire': return `💥 ${who(e.player)}'s ${e.id} MISFIRED: ${e.reason}`
      case 'blowup': return `🔥 ${who(e.player)}'s boost ${e.id} BLEW UP`
      case 'gremlinSpike': return `👹 gremlin spike (pressure ${e.pressure}) — damage ${(e.damage as number[]).join('/')}`
      case 'corrupted': return `👹 a gremlin chewed on ${who(e.player)}'s ${e.id}…`
      case 'marketShift': return `📈 market now ${e.market} per widget`
      default: return JSON.stringify(e)
    }
  }

  const ws = new WebSocket(wsUrl())
  ws.onopen = () => ws.send(JSON.stringify({ type: 'watch', room: pin }))
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage
    if (msg.type === 'lobby') status = msg.started ? 'live' : 'waiting for the host'
    if (msg.type === 'snapshot') {
      view = msg.view
      status = 'live'
      for (const e of msg.view.events) {
        eventLog = [describe(e as unknown as Record<string, unknown>), ...eventLog].slice(0, 40)
      }
    }
    if (msg.type === 'error') status = msg.message
  }
  ws.onclose = () => (status = 'disconnected')

  const ranked = $derived(view ? [...view.players].sort((a, b) => b.score - a.score) : [])
</script>

<h1>AIMANCER — room {pin}</h1>
<p class="muted">{status} · join at <b>{location.host}</b> with PIN <b>{pin}</b></p>

{#if view}
  <div class="bar">
    <span>tick <b>{view.tick}</b></span>
    <span>📈 market <b>{view.market}</b>/widget</span>
    <span>👹 gremlin <b>{view.gremlin}</b></span>
    <span>tick every {view.tickMs / 1000}s</span>
  </div>

  <h2>Scoreboard</h2>
  <table>
    <thead>
      <tr><th>#</th><th>workshop</th><th>score</th><th>⚡</th><th>⛏</th><th>⚙</th><th>waste</th><th>scripts</th></tr>
    </thead>
    <tbody>
      {#each ranked as p, i (p.index)}
        <tr>
          <td>{i + 1}</td>
          <td>{p.name}{p.online ? '' : ' (away)'}</td>
          <td><b>{p.score}</b></td>
          <td>{p.tokens}</td>
          <td>{p.matter}</td>
          <td>{p.widgets}</td>
          <td>{p.waste}</td>
          <td>
            {#each p.scripts as sc (sc.id)}
              <span title={sc.id}>{sc.status === 'dead' ? '💀' : sc.status === 'blown' ? '🔥' : sc.armed ? (sc.yolo ? '⚠' : '🟢') : '🃏'}</span>
            {/each}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h2>Disaster theater</h2>
  <div class="events">
    {#each eventLog as line, i (i)}<div>{line}</div>{/each}
  </div>
{/if}
