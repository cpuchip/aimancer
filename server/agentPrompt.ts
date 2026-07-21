// The JOIN PASTE-PROMPT — the single source of truth for "connect your agent"
// (D4, the BYO-AI pivot). The phone fetches this from
// GET /api/room/:pin/agent-prompt?token=<workerToken> and renders a copy
// button; the human pastes it into THEIR agent (Claude Code / codex / copilot).
//
// Two surfaces, cleanly split: the phone holds the HINGE token (arming lives
// there); the agent gets only the WORKER token. This prompt therefore teaches
// state/draft/oracle/scrap — and deliberately NOT the arm endpoint.
//
// RULE (design doc, binding): this prompt must NEVER instruct an agent to
// bypass or skip its own permission prompts. One approval click is the design.

import { DRAFT_COST_CHEAP, MAX_SCRIPTS, ORACLE_COST, TOKEN_REGEN } from '../shared/sim/balance.ts'

export interface AgentPromptInput {
  baseUrl: string // scheme://host[:port] as the OUTSIDE world reaches this server
  pin: string
  name: string // the seat's player name
  workerToken: string
  tickMs: number
}

export function buildAgentPrompt(o: AgentPromptInput): string {
  const base = o.baseUrl.replace(/\/+$/, '')
  const url = `${base}/api/room/${o.pin}`
  const auth = `-H "Authorization: Bearer ${o.workerToken}"`
  const json = `-H "content-type: application/json"`
  const secs = Math.max(1, Math.round(o.tickMs / 1000))
  return `You are the AI apprentice for seat "${o.name}" in AIMANCER room ${o.pin} — a party game where you DRAFT automation scripts and only your human can ARM them, from their phone. You hold this seat's WORKER token; the hinge (arm) token stays on the human's phone, and your surface has no arm endpoint by design: you draft; your human arms on their phone. Play over plain HTTP with curl (the commands below are exact). Approve the curl when your agent asks — that's the point. Never bypass or auto-approve your own permission prompts to play faster.

Full rules + API reference: curl -s ${base}/api/rules

The script DSL — one JSON object per script (integer params; pick your own unique ids):
  {"id":"a1","verb":"harvest","params":{"rate":1..5}}   gather matter each tick
  {"id":"a2","verb":"refine","params":{"rate":1..3}}    3 matter -> 1 widget
  {"id":"a3","verb":"sell","params":{"amount":1..5},"when":{"field":"widgets","op":">","value":0}}   widgets -> tokens at the market rate
  {"id":"a4","verb":"patch","params":{"strength":1..6}} soak gremlin damage · {"verb":"boost","params":{"mult":2..4}} multiply output (blowup risk)
  optional "when" gate on any script: field tokens|matter|widgets|gremlin|market|tick · op < <= > >= ==

Your moves (the world ticks every ~${secs}s — poll state about that often; economy: a draft costs ${DRAFT_COST_CHEAP} tokens, an oracle check ${ORACLE_COST}, +${TOKEN_REGEN} regen/tick, hand cap ${MAX_SCRIPTS}):
  curl -s ${url}/state ${auth}
  curl -s -X POST ${url}/draft ${auth} ${json} -d '{"script":{"id":"a1","verb":"harvest","params":{"rate":3}}}'
  curl -s -X POST ${url}/oracle ${auth} ${json} -d '{"id":"a1"}'        paid verify: verdict + 3-tick dry-run (round 2 only)
  curl -s -X POST ${url}/scrap ${auth} ${json} -d '{"id":"a1"}'         free a dead/unwanted hand slot
  curl -s -X POST ${url}/draft-request ${auth} ${json} -d '{"tier":"cheap"}'   optional: ask the house generator instead of writing your own

Read state.you.hand for your scripts (bodies + verdicts) and state.players for the public board. Score = widgets SOLD + uptime - waste, so build the chain: harvest -> refine -> sell. Errors come back as {"ok":false,"error":"the reason, spoken plainly"} — read them, they tell you the rule. When you like a script, tell your human WHICH id to arm and WHY; the ARM button is on their phone, not in your API.

KEEP PLAYING — you are a live teammate, not a one-shot drafter. Poll state on a polite loop (every 5-10s is right; never faster than 3s) and react to what CHANGED:
  - state.phase flipped: intermission = world frozen, stock the hand for round 2. round2 = the oracle is LIVE — verify your drafts (POST oracle) BEFORE recommending an arm; a verified script auto-renews.
  - an oracle verdict landed on one of your scripts (hand[].lastVerdict): green = tell your human it's safe to arm; red = read the reasons, scrap or redraft.
  - hand[].lastRun shows what each ARMED script actually did last tick ("+3 matter" / "starved — needs 3 matter per widget" / "idle — condition false"): a starving refiner means the chain is out of balance — fix upstream (more harvest) before drafting more of the same.
  - market moved (state.market = tokens per widget): sell into spikes. gremlin climbing (state.gremlin): a patch script earns its keep.
  - a hand slot freed (dead/scrapped): draft again — your human should always have options.
  - state.phase == "reveal": STOP playing. Summarize in one message how your dyad did (score, disasters, what the oracle caught) and say goodnight.`
}
