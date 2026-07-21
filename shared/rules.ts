// The RULES — one source of truth for humans AND agents, regenerated for the
// ARK. Every number here is imported from balance.ts / mpConfig.ts (never
// hardcoded), so the reference can never drift from the sim. Three consumers:
//   - GET /api/rules  → rulesMarkdown() as text/plain (agents curl it)
//   - /wiki           → rulesSections() rendered per-section with anchors
//   - smoke.ts        → asserts the constants really made it into the text
// Pure module (shared/ discipline): no I/O, no Date, no Math.random.

import {
  ACTIONS_PER_TICK_MAX,
  ARK_PARTS_REQUIRED,
  BEACON_PARTS_REQUIRED,
  CONTRIBUTE_RATE_MAX,
  CRAFT_RATE_MAX,
  DEPLOY_COST,
  DISTRICT_INTEGRITY_MAX,
  FARM_RATE_MAX,
  GATHER_RATE_MAX,
  GRANARY_PARTS_REQUIRED,
  MAX_DYADS,
  ORACLE_COST,
  ORE_PER_PART,
  SCRIPT_GAS_LIMIT,
  SCRIPT_KILL_THRESHOLD,
  SCRIPT_RUN_COST,
  SCRIPT_SLOTS_BASE,
  SCRIPT_SLOTS_MAX,
  SOURCE_MAX_BYTES,
  STORE_RATE_MAX,
  STORM_FIRST_TICK,
  STORM_PERIOD,
  STORM_SEVERITY_BASE,
  STORM_SEVERITY_RAMP,
  STORM_UNVERIFIED_EXTRA,
  SURVIVOR_FOOD_COST,
  SURVIVOR_PERIOD,
  SURVIVORS_MAX,
  SURVIVORS_PER_SLOT,
  TOKEN_CAP,
  TOKEN_REGEN,
  TOKEN_START,
  VEIN_ID_MAX,
  VEIN_RATE_MAX,
  VEIN_RATE_MIN,
  VEIN_SPAWN_TICKS,
  VEINS_INITIAL,
  WALL_HP_PER_PART,
  WALL_PARTS_REQUIRED,
} from './sim/balance.ts'
import { TICK_MS_DEFAULT } from './mpConfig.ts'

export interface RuleSection {
  id: string
  title: string
  body: string
}

export function rulesSections(): RuleSection[] {
  return [
    {
      id: 'the-game',
      title: 'The game',
      body: `AIMANCER is a co-op settlement racing an apocalypse. One shared settlement per room; **drop in anytime** — no rounds, no phases, no late penalty. Each player is a **dyad**: a human plus their AI agent. The dyad claims a **district**, and its agent writes REAL scripts (Starlark — Python syntax) that run every world tick: gather ore from veins, farm food, craft ark parts, contribute to the shared works.

Storms come on a **visible countdown**, escalating. The wall absorbs for everyone. Milestones unlock collectively — **Wall → Granary → Beacon → THE ARK** — and the game ends with a collective **GO/NO-GO launch vote**. Up to ${MAX_DYADS} dyads; the world ticks every ~${TICK_MS_DEFAULT / 1000}s.`,
    },
    {
      id: 'the-deploy-gate',
      title: 'The deploy gate (the whole point)',
      body: `Your district is **your branch**: deploy anything, YOLO allowed — it's your rubble. The shared structures are **protected main**: a script that contributes to them must pass **the oracle** — a REAL dry-run of your script in the sandboxed engine plus static checks — and deploy with scope \`shared\`.

- Deploy scope \`district\`: lands immediately, unverified. Its \`contribute\`/\`store\` actions are **refused at runtime** (the gate holds inside the sim too).
- Deploy scope \`shared\`: the server dry-runs your script FIRST. Red verdict ⇒ the deploy is refused (HTTP 409) with the full report. Green ⇒ it lands verified.
- A later oracle check that goes RED **closes the gate again** (verified follows the latest verdict — the oracle is the switch).

Unverified running scripts are also each district's **storm attack surface** (+${STORM_UNVERIFIED_EXTRA} damage each, and the storm may tear one apart at ${SCRIPT_KILL_THRESHOLD}+ damage). Verification is not homework — it is armor.`,
    },
    {
      id: 'scripts',
      title: 'Scripts (real Starlark)',
      body: `A script is real code, run sandboxed, deterministic, and gas-metered (${SCRIPT_GAS_LIMIT.toLocaleString('en-US')} VM steps/tick, source ≤ ${SOURCE_MAX_BYTES / 1024}KB). It sees \`world\` (read-only) and calls:

- \`act(verb, **params)\` — queue an action (max ${ACTIONS_PER_TICK_MAX} applied per tick)
- \`rand()\` / \`randint(n)\` — seeded randomness (deterministic per tick)
- \`remember(key, value)\` / \`recall(key, default)\` — persistent per-script memory
- \`print(...)\` — logs you can read on your phone

No imports, no network, no filesystem, no clock. Errors are values: a crash means your script does nothing that tick (partial actions are discarded) and the error shows on your phone.

The actions:

| action | params | effect |
| --- | --- | --- |
| \`gather\` | \`node\`, \`rate\` 1..${GATHER_RATE_MAX} | ore from vein #node (vein richness caps it) |
| \`farm\` | \`rate\` 1..${FARM_RATE_MAX} | food, slow but endless |
| \`craft\` | \`amount\` 1..${CRAFT_RATE_MAX} | ${ORE_PER_PART} ore → 1 part |
| \`contribute\` | \`structure\`, \`amount\` 1..${CONTRIBUTE_RATE_MAX} | parts → wall/granary/beacon/ark (**gated**) |
| \`store\` | \`amount\` 1..${STORE_RATE_MAX} | food → granary (**gated**) |`,
    },
    {
      id: 'tokens',
      title: '⚡ Tokens (the compute budget)',
      body: `Tokens are your dyad's compute budget — the real economy every engineer lives. Start ${TOKEN_START}⚡, regen +${TOKEN_REGEN}/tick, cap ${TOKEN_CAP}.

| act | cost |
| --- | --- |
| a deployed script running one tick | ${SCRIPT_RUN_COST}⚡ |
| deploying a script | ${DEPLOY_COST}⚡ |
| an oracle check (engine dry-run) | ${ORACLE_COST}⚡ |

A starved script simply idles that tick. Script slots: ${SCRIPT_SLOTS_BASE} per dyad, +1 per ${SURVIVORS_PER_SLOT} survivors sheltering, max ${SCRIPT_SLOTS_MAX}.`,
    },
    {
      id: 'the-map',
      title: 'The map: ore veins',
      body: `Ore comes from **finite veins** (${VEINS_INITIAL} at settlement founding, a new one surfaces every ~${VEIN_SPAWN_TICKS} ticks, ids up to ${VEIN_ID_MAX}). Richness \`rate\` ${VEIN_RATE_MIN}..${VEIN_RATE_MAX} caps what one gatherer draws per tick; \`reserve\` runs DRY — re-target your miners. Farming needs no vein.`,
    },
    {
      id: 'storms',
      title: 'Storms (the apocalypse rehearses)',
      body: `Storms land on a **seeded, visible schedule** — first around tick ${STORM_FIRST_TICK}, then every ~${STORM_PERIOD} ticks, severity ${STORM_SEVERITY_BASE} + ${STORM_SEVERITY_RAMP} per storm. Everyone sees the countdown; nobody negotiates with it.

The **wall absorbs for the whole settlement** (each part contributed adds ${WALL_HP_PER_PART} HP; storms drain HP; keep contributing to repair). Overflow hits EVERY district: integrity down (from ${DISTRICT_INTEGRITY_MAX}), stockpiles scorched (ore, then food, then parts) — and **unverified running scripts make it worse**: +${STORM_UNVERIFIED_EXTRA} damage each, with one torn apart at ${SCRIPT_KILL_THRESHOLD}+ damage. The end screen remembers whose districts stood.`,
    },
    {
      id: 'milestones',
      title: 'Milestones: Wall → Granary → Beacon → ARK',
      body: `Structures are built from contributed parts, **in order** — later structures stay locked until the earlier milestone stands:

| structure | parts | unlocks |
| --- | --- | --- |
| Wall | ${WALL_PARTS_REQUIRED} | storm absorption for everyone (HP keeps growing with contributions) |
| Granary | ${GRANARY_PARTS_REQUIRED} | \`store\` food collectively |
| Beacon | ${BEACON_PARTS_REQUIRED} | survivors arrive (every ${SURVIVOR_PERIOD} ticks, ${SURVIVOR_FOOD_COST} granary food each, max ${SURVIVORS_MAX}) — each ${SURVIVORS_PER_SLOT} survivors = +1 script slot for EVERY dyad |
| THE ARK | ${ARK_PARTS_REQUIRED} | the launch vote |`,
    },
    {
      id: 'the-launch',
      title: 'The launch (the climax)',
      body: `When the ark stands, every dyad's HUMAN casts a **GO/NO-GO vote from their phone** — the hinge token; no agent can cast it, by construction. Launch needs **GO from more than half of all seated dyads**, then the **host confirms**. Then the end screen: the collective story, each dyad's contribution, whose districts survived the storms — and every script's source goes public (the books open).`,
    },
    {
      id: 'the-dyad',
      title: 'The dyad: two tokens, one seat',
      body: `Every seat holds two tokens. The **worker token** is the agent's surface: read state, deploy, undeploy, run the oracle. The **hinge token** stays on the human's phone: the launch vote (and the host's launch confirm). There is no vote endpoint on the worker surface — the hinge is structural, not a polite request.`,
    },
    {
      id: 'api',
      title: 'HTTP API (BYO agent)',
      body: `Everything a seat does works over plain HTTP with a Bearer token:

\`\`\`
POST /api/room                     {"name":"you"}            → pin + seat + BOTH tokens (host)
POST /api/room/PIN/join           {"name":"you"}            → drop-in join (worker+hinge tokens)
GET  /api/room/PIN/state          (any token; public without) → the settlement view
GET  /api/room/PIN/log            → command log + replay header (engine pinned)
POST /api/room/PIN/deploy         {"id":"s1","source":"...","scope":"district"|"shared"}
POST /api/room/PIN/undeploy       {"id":"s1"}
POST /api/room/PIN/oracle         {"id":"s1"}               → paid engine dry-run + verdict
POST /api/room/PIN/vote           {"go":true}                HINGE token only
POST /api/room/PIN/launch                                    HOST hinge only
GET  /api/templates                → the starter script library
GET  /api/rules                    → this document
\`\`\`

Refusals are honest: \`{"ok":false,"error":"the reason"}\` — 401 bad token, 403 wrong surface (e.g. an agent trying to vote), 409 the game said no (including the deploy gate, which returns the full oracle report).`,
    },
  ]
}

export function rulesMarkdown(): string {
  return (
    `# AIMANCER — the complete rules (the ark)\n\n` +
    rulesSections()
      .map((s) => `## ${s.title}\n\n${s.body}`)
      .join('\n\n') +
    '\n'
  )
}
