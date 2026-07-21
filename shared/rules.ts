// The RULES — one source of truth for humans AND agents. Every number here is
// imported from balance.ts / mpConfig.ts (never hardcoded), so the reference
// can never drift from the sim. Three consumers, one truth:
//   - GET /api/rules        → rulesMarkdown() as text/plain (agents curl it)
//   - /wiki                 → rulesSections() rendered per-section with anchors
//   - smoke.ts              → asserts the constants really made it into the text
// Pure module (shared/ discipline): no I/O, no Date, no Math.random.

import {
  APPRENTICE_FLAW_CHEAP_PCT,
  APPRENTICE_FLAW_SMART_PCT,
  BOOST_BLOWUP_MATTER_LOSS,
  BOOST_BLOWUP_WASTE,
  BOOST_RISK_PER_STEP,
  CORRUPT_THRESHOLD,
  DEAD_SCRIPT_WASTE,
  DRAFT_COST_CHEAP,
  DRAFT_COST_SMART,
  GREMLIN_MAX,
  GREMLIN_RAMP_TICKS,
  MARKET_BASE,
  MARKET_MAX,
  MARKET_MIN,
  MARKET_SHIFT_TICKS,
  MAX_SCRIPTS,
  ORACLE_COST,
  REFINE_RATIO,
  SCORE_PER_UPTIME,
  SCORE_PER_WIDGET,
  SCORE_WASTE_MULT,
  SCRAP_COST,
  SPIKE_BUGGY_EXTRA,
  SPIKE_CHANCE_PER_PRESSURE,
  TOKEN_CAP,
  TOKEN_REGEN,
  TOKEN_START,
  VERB_PARAMS,
} from './sim/balance.ts'
import { MAX_PLAYERS, ROUND1_TICKS_DEFAULT, ROUND2_TICKS_DEFAULT, TICK_MS_DEFAULT } from './mpConfig.ts'
import { CONDITION_FIELDS, CONDITION_OPS, VERBS } from './sim/types.ts'

export interface RuleSection {
  id: string // anchor slug (stable — links depend on it)
  title: string
  body: string // markdown, NO heading (the renderer owns the heading level)
}

/** `rate 1..5` — the exact bounds string, straight from VERB_PARAMS. */
function boundsOf(verb: string): string {
  return (VERB_PARAMS[verb] ?? []).map((sp) => `\`${sp.name}\` ${sp.min}..${sp.max}`).join(', ') || '—'
}

/** Boost blowup % per tick for a given mult — the same integer math the sim rolls. */
function boostRiskPct(mult: number): number {
  return Math.round(((mult - 1) * BOOST_RISK_PER_STEP * 100) / 65536)
}

/** Spike chance per tick per pressure point, as a rounded %. */
const SPIKE_PCT_PER_PRESSURE = Math.round((SPIKE_CHANCE_PER_PRESSURE * 1000) / 65536) / 10

const TICK_SECS_DEFAULT = Math.round(TICK_MS_DEFAULT / 1000)

const [BOOST_MIN, BOOST_MAX] = [VERB_PARAMS.boost[0].min, VERB_PARAMS.boost[0].max]
const boostRiskLine = Array.from({ length: BOOST_MAX - BOOST_MIN + 1 }, (_, i) => {
  const m = BOOST_MIN + i
  return `×${m} ≈ ${boostRiskPct(m)}%`
}).join(' · ')

const VERB_DOES: Record<string, string> = {
  harvest: `gathers \`rate\` matter each tick (× the active boost multiplier).`,
  refine: `converts matter → widgets: ${REFINE_RATIO} matter per widget, up to \`rate\` widgets per tick. **Saturation:** with less than ${REFINE_RATIO} matter on hand it runs but yields nothing — \`lastRun\` says \`starved\`. Fix upstream (more harvest) before duplicating refiners.`,
  sell: `sells up to \`amount\` widgets each tick at the current market rate (tokens per widget). **Saturation:** with no widgets in inventory it runs but sells nothing (\`nothing to sell\`). Tokens gained cap at ${TOKEN_CAP} — overflow is wasted.`,
  patch: `soaks \`strength\` gremlin damage each tick — your only defense when a spike lands.`,
  boost: `multiplies your OTHER scripts' output ×\`mult\` while armed (multiple boosts take the max, not the product). Each tick it risks a blowup: ${boostRiskLine} chance per tick. A blowup kills the script, scores ${BOOST_BLOWUP_WASTE} waste, and scorches ${BOOST_BLOWUP_MATTER_LOSS} matter.`,
}

export function rulesSections(): RuleSection[] {
  return [
    {
      id: 'dyad',
      title: 'The dyad — you + your AI are one player',
      body: `Each seat is a HUMAN + AI pair playing as one workshop. The covenant line on the board says it all: **your apprentice drafts · only a human arms**.

Every seat holds two tokens:

- **worker token** — the AI surface: read state, draft scripts, request drafts, run the oracle, scrap. This is the token in the agent paste-prompt.
- **hinge token** — the human surface, on the phone: **ARM** (and disarm) scripts, and for the host, start/advance the game. There is no AI-reachable arm path, by design.

A drafted script does NOTHING until a human arms it. Arming an unverified script is a **YOLO-arm** — free, fast, and publicly risky. Your agent should recommend which id to arm and why; the button stays on the phone. No agent? The phone's practice apprentice and the hand-write box play the same game.`,
    },
    {
      id: 'goal',
      title: 'The goal + scoring',
      body: `Highest score wins. The formula (weights from the sim's balance file):

\`\`\`
score = widgets SOLD × ${SCORE_PER_WIDGET}  +  uptime × ${SCORE_PER_UPTIME}  −  waste × ${SCORE_WASTE_MULT}
\`\`\`

- **widgets SOLD** — shipping IS selling: a warehouse of unsold widgets scores nothing.
- **uptime** — +1 per armed, valid script per tick (idle-by-condition still counts; dead doesn't).
- **waste** — dead scripts (${DEAD_SCRIPT_WASTE} each), boost blowups (${BOOST_BLOWUP_WASTE} each), and every point of gremlin damage that lands.

Build the chain: **harvest → refine → sell**. The game is two rounds of the SAME world — the reveal shows each dyad's round-2-minus-round-1 delta, and the only variable is the oracle (and you).`,
    },
    {
      id: 'resources',
      title: 'Resources + the token economy',
      body: `- **tokens ⚡** — the currency. Start ${TOKEN_START}, regen +${TOKEN_REGEN} per tick, cap ${TOKEN_CAP} (regen AND sale income both stop at the cap — overflow is wasted, like an over-full rate limit).
- **matter ⛏** — harvested raw input; refine eats it (${REFINE_RATIO} per widget). Gremlin damage eats matter first.
- **widgets ⚙** — refined inventory; only SELLING them scores.
- **market 📈** — the sell rate in tokens per widget. Starts at ${MARKET_BASE}, steps −1/0/+1 every ${MARKET_SHIFT_TICKS} ticks on a seeded schedule, clamped to ${MARKET_MIN}..${MARKET_MAX}. Sell into spikes.

What tokens buy: cheap draft ${DRAFT_COST_CHEAP}⚡ · smart draft ${DRAFT_COST_SMART}⚡ · oracle check ${ORACLE_COST}⚡ · scrap ${SCRAP_COST === 0 ? 'FREE' : `${SCRAP_COST}⚡`}.`,
    },
    {
      id: 'verbs',
      title: 'The five verbs',
      body: `One JSON object per script — integer params only, ids of your choosing (1-32 chars, unique in your hand):

\`\`\`json
{"id":"a1","verb":"harvest","params":{"rate":3},"when":{"field":"matter","op":"<","value":30}}
\`\`\`

| verb | params (bounds) | what it does |
|---|---|---|
${VERBS.map((v) => `| \`${v}\` | ${boundsOf(v)} | ${VERB_DOES[v]} |`).join('\n')}

Params outside the bounds, misspelled param names, or unknown verbs pass the structural check (a hallucinated draft can always enter your hand) — but they are ORACLE-RED, and armed anyway they misfire. Armed scripts execute in hand order each tick, so two refiners on thin matter starve the second — \`lastRun\` on each armed script tells you what it actually did.`,
    },
    {
      id: 'conditions',
      title: 'Conditions — the `when` gate',
      body: `Any script may carry one optional gate; it runs only while the condition is true (otherwise it idles that tick — still armed, still uptime):

\`\`\`json
"when": {"field":"widgets","op":">","value":0}
\`\`\`

- **field** — one of: ${CONDITION_FIELDS.map((f) => `\`${f}\``).join(' · ')} (tokens/matter/widgets are YOUR workshop; gremlin/market/tick are the world).
- **op** — one of: ${CONDITION_OPS.map((o) => `\`${o}\``).join(' ')}.
- **value** — a finite number.

A phantom field (\`mana\`, \`credits\`…) or an impossible test (\`tokens > 9999\` when tokens cap at ${TOKEN_CAP}) is exactly the kind of confident hallucination the oracle exists to catch.`,
    },
    {
      id: 'phases',
      title: 'The phases — a two-round weave',
      body: `The world ticks every ~${TICK_SECS_DEFAULT}s (a room setting; up to ${MAX_PLAYERS} seats). Rounds auto-advance by default after a visible countdown — the host can hold or turn it off.

| phase | ticks (default) | what's true |
|---|---|---|
| **ROUND 1 — naive** | ${ROUND1_TICKS_DEFAULT} | The oracle DOES NOT EXIST yet (checks are refused, not hidden). Every arm is a YOLO-arm. Arm and pray. |
| **INTERMISSION** | frozen | The world holds still. Draft and stock your hand for round 2 — arming is refused (it would vanish in the reset). |
| **ROUND 2 — verified** | ${ROUND2_TICKS_DEFAULT} | Fresh resources, SAME seed — the market and gremlin replay round 1's exact schedule. The oracle is live: verify, then arm. Verified scripts auto-renew. |
| **THE REVEAL** | — | Game over, full stop. The delta board tells the story: round 2 minus round 1, per dyad. |

What carries into round 2: script names, your **un-played drafts** (status \`drafted\`), and any paid in-flight draft requests. Armed/dead/blown/disarmed scripts do not; tokens/matter/widgets reset.`,
    },
    {
      id: 'oracle',
      title: 'The oracle',
      body: `A paid, deterministic verifier — ${ORACLE_COST}⚡ per check, **round 2 only**. Two layers:

1. **Static checks** — unknown verb, missing/unknown/misspelled param, non-integer or out-of-bounds value (with an "off by 10x?" nudge), phantom condition field, unknown operator, impossible condition.
2. **Dry-run** — predicts the next 3 ticks of THIS script alone against the real market schedule (yields, or why it would sit idle/starved).

A green verdict earns **auto-renew**: while that script stays armed, it gets a FREE re-check every tick — and a red result (say, gremlin corruption) **auto-disarms it**. The oracle is the switch, literally. Verifying an already-armed YOLO script after the fact clears its YOLO flag; a red verdict on an armed script disarms it on the spot.`,
    },
    {
      id: 'gremlin',
      title: 'The gremlin',
      body: `One shared threat track for the whole room.

- **Pressure** ramps +1 every ${GREMLIN_RAMP_TICKS} ticks, capped at ${GREMLIN_MAX}.
- Each tick the track may **spike**: chance ≈ ${SPIKE_PCT_PER_PRESSURE}% per pressure point (seeded — round 2 replays the same spikes).
- When a spike lands, each workshop takes \`pressure + ${SPIKE_BUGGY_EXTRA} × (YOLO-armed scripts) − (patch strength)\` damage. **Unverified armed scripts are attack surface.**
- Damage scores as waste and eats matter first, then widgets.
- Damage ≥ ${CORRUPT_THRESHOLD} **corrupts** one random armed script: same id, subtly broken — the horror is it looks identical. An oracle-green script auto-disarms on the next free re-check (protected); a YOLO script misfires publicly (${DEAD_SCRIPT_WASTE} waste, +1 disaster).

A \`patch\` script is the counter — it earns its keep as pressure climbs.`,
    },
    {
      id: 'drafts',
      title: 'Drafts, tiers + your hand',
      body: `Your hand holds at most **${MAX_SCRIPTS} scripts** total (drafted + armed + dead). Scrap is ${SCRAP_COST === 0 ? 'free' : `${SCRAP_COST}⚡`} (disarm first) — the dead script already cost you.

Asking an apprentice (\`draft-request\`) debits NOW and delivers async — drafts land in your hand a moment later; a timeout or empty batch refunds through the log:

| tier | cost | hallucination rate |
|---|---|---|
| \`cheap\` | ${DRAFT_COST_CHEAP}⚡ | ~${APPRENTICE_FLAW_CHEAP_PCT}% of drafts are subtly flawed |
| \`smart\` | ${DRAFT_COST_SMART}⚡ | ~${APPRENTICE_FLAW_SMART_PCT}% flawed |

The bet of the whole game: cheap+verify vs smart+trust. Flawed drafts are structurally valid and always oracle-red — the classes: a mangled param name (\`rte\`, \`ammount\`), a value off by 10×, a condition on a phantom resource, an impossible condition. Writing your own script (\`draft\`) costs the tier price and skips the hallucination roll entirely — your agent's drafts are exactly what it wrote.`,
    },
    {
      id: 'api',
      title: 'HTTP API quick reference',
      body: `Everything a seat can do works over plain HTTP against the game server (same origin as this page). Auth: \`Authorization: Bearer <token>\` or \`?token=\`. **worker** = the AI surface · **hinge** = the human surface · **host hinge** = the host's hinge token.

| route | method | token | does |
|---|---|---|---|
| \`/api/rules\` | GET | none | this document, as markdown |
| \`/api/room\` | POST | none | create a room (creator = host, seat 0); body \`{name?, tickMs?, round1Ticks?, round2Ticks?, autoAdvance?}\` |
| \`/api/room/:pin/join\` | POST | none | \`{name?, key?}\` — same \`key\` reconnects to the SAME seat + tokens |
| \`/api/room/:pin/agent-prompt\` | GET | worker | the ready-to-paste agent prompt (never carries the hinge) |
| \`/api/room/:pin/start\` | POST | host hinge | \`{tickMs?, round1Ticks?, round2Ticks?, autoAdvance?}\` |
| \`/api/room/:pin/phase\` | POST | host hinge | \`{to}\` — advance round1 → intermission → round2 → reveal |
| \`/api/room/:pin/hold\` | POST | host hinge | suspend a pending auto-advance |
| \`/api/room/:pin/state\` | GET | any / none | redacted room view (a seat token adds \`you.hand\` + \`you.pending\` + per-script \`lastRun\`) |
| \`/api/room/:pin/log\` | GET | any / none | command log + seed (other seats' draft bodies stripped) |
| \`/api/room/:pin/draft\` | POST | worker | \`{script, tier?}\` — submit a script you wrote |
| \`/api/room/:pin/draft-request\` | POST | either | \`{tier, order?}\` — ask the apprentice; debits now, drafts arrive async |
| \`/api/room/:pin/oracle\` | POST | either | \`{id}\` — paid verify + 3-tick dry-run (round 2 only) |
| \`/api/room/:pin/arm\` | POST | **hinge ONLY** | \`{id}\` — the human act; worker tokens get 403 |
| \`/api/room/:pin/disarm\` | POST | hinge | \`{id}\` — lifecycle control lives with arm |
| \`/api/room/:pin/scrap\` | POST | either | \`{id}\` — free an unarmed hand slot |

Errors are always \`{"ok":false,"error":"the reason, spoken plainly"}\` — 401 no/unknown token · 403 wrong surface · 404 no room · 405 wrong method · 409 the sim refused (read the reason — it teaches the rule) · 400 malformed body. Poll \`state\` politely (every 5-10s; never faster than 3s) and react to what changed.`,
    },
  ]
}

/** The full headed document — what GET /api/rules serves. */
export function rulesMarkdown(): string {
  const head = `# AIMANCER — the complete rules

A Jackbox-style party game where your AI apprentice drafts automation scripts
and only YOU can arm them. This reference is generated from the live game
constants — it cannot drift from the sim.
`
  const toc = rulesSections()
    .map((s) => `- [${s.title}](#${s.id})`)
    .join('\n')
  const body = rulesSections()
    .map((s) => `## ${s.title} {#${s.id}}\n\n${s.body}`)
    .join('\n\n')
  return `${head}\n${toc}\n\n${body}\n`
}
