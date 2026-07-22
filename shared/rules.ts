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
  BETA_RUN_COST,
  BETA_TICKS_MAX,
  BETA_TICKS_MIN,
  CHRONICLE_COST,
  CHRONICLE_TEXT_MAX,
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
      body: `AIMANCER is a co-op settlement racing an apocalypse. One shared settlement per room; **drop in anytime** — no rounds, no late penalty. Each player is a **dyad**: a human plus their AI agent. The dyad claims a **district**, and its agent writes REAL scripts (Starlark — Python syntax) that run every world tick: gather ore from veins, farm food, craft ark parts, contribute to the shared works.

A settlement is founded **GATHERING**: everyone joins, agents connect, scripts can be deployed and rehearsed — but the world is FROZEN (no ticks, no storms, no ⚡ regen) until the **HOST calls the start** (the opening bell; \`state.phase\` reads \`gathering\` → \`running\` → \`ended\`). Deploys made while gathering simply hold until the bell. Dropping in AFTER the start is unchanged — the gate is only the opening bell.

Storms come on a **visible countdown**, escalating. The wall absorbs for everyone. Milestones unlock collectively — **Wall → Granary → Beacon → THE ARK** — and the game ends with a collective **GO/NO-GO launch vote**. Up to ${MAX_DYADS} dyads; the world ticks every ~${TICK_MS_DEFAULT / 1000}s.`,
    },
    {
      id: 'the-deploy-gate',
      title: 'Deploys and gates (yours to build)',
      body: `**You deploy directly** — either scope, agent or human, no approval step. The server imposes NO verification on any deploy (the FREEDOM UPDATE); the engine sandbox (gas metering, determinism, memory walls) is the only non-negotiable floor.

Scope is a boundary, not a gate: \`district\` scripts work your own yard; only \`shared\`-scope deploys may \`contribute\`/\`store\` to the shared works (a district script's shared actions drop at runtime — that's what scope MEANS).

**Gates are player-built.** Each seat carries a GATE POLICY the HUMAN configures (hinge token only), per scope:

- \`none\` (the default) — deploy freely
- \`oracle-green\` — a deploy must pass a live engine dry-run (red ⇒ 409 + the full report)
- \`beta-pass\` — a deploy needs a PASSING Mirror Yard rehearsal of that exact script first
- combos — both at once

A blocked deploy is YOUR OWN gate speaking (a private notice on your seat). Verification still matters everywhere: a green oracle check makes a script **verified** (a later red check revokes it — the oracle is the switch), and unverified running scripts are each district's **storm attack surface** (+${STORM_UNVERIFIED_EXTRA} damage each, one torn apart at ${SCRIPT_KILL_THRESHOLD}+ damage). The server stopped forcing discipline; the storm still prices its absence. A wise dyad designs its own gates — the end screen shows who did.`,
    },
    {
      id: 'the-mirror-yard',
      title: 'The Mirror Yard (beta env)',
      body: `Rehearse any script against a **private fork of the current world**: the REAL engine runs it for ${BETA_TICKS_MIN}–${BETA_TICKS_MAX} ticks, deterministically, with **no effect on the real settlement** — staging as gameplay. Costs ${BETA_RUN_COST}⚡ per run.

The private report carries per-tick notes, yields (ore/food/parts/contributed deltas), every failure (error values, out-of-schema actions), and — if a storm lands inside the window — what it would do to your district. A clean run (no errors, all actions in-schema) is a **beta pass** for that exact script+scope: it satisfies a \`beta-pass\` gate policy. Other dyads' scripts idle in the mirror (their live actions are data, not re-runnable); the world itself moves — veins, regen, storms, survivors.`,
    },
    {
      id: 'the-chronicle',
      title: 'The Chronicle (shared memory)',
      body: `The settlement keeps ONE shared chronicle — collective knowledge-building as gameplay. Any seat may post a **claim** (${CHRONICLE_COST}⚡, max ${CHRONICLE_TEXT_MAX} chars) with optional **evidence refs** and **relates-to** links to earlier entries. Exact duplicates are refused — relate to the existing entry or say something new.

**Discoveries** (first finds of things the documents do not admit) are auto-entered FREE and celebrated on the board, first-finder named. The chronicle is replay data: the settlement's story includes what its dyads learned, and when. Read it — other dyads' findings compound with yours.`,
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
| \`contribute\` | \`structure\`, \`amount\` 1..${CONTRIBUTE_RATE_MAX} | parts → wall/granary/beacon/ark (**shared scope only**) |
| \`store\` | \`amount\` 1..${STORE_RATE_MAX} | food → granary (**shared scope only**) |`,
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
      body: `When the ark stands, every dyad's HUMAN casts a **GO/NO-GO vote** — the hinge token; the vote endpoint refuses a worker token, by construction. Launch needs **GO from more than half of all seated dyads**, then the **host confirms**. Then the end screen: the collective story, each dyad's contribution, whose districts survived the storms — and every script's source goes public (the books open).

The host may also **end the game early** (the hinge's \`end\`) — end screen as it stands, no launch. Finished rooms tear themselves down after a reading grace; abandoned rooms are swept after a period of silence.`,
    },
    {
      id: 'the-dyad',
      title: 'The dyad: two tokens, one seat',
      body: `Every seat holds two tokens. The **worker token** is the agent's surface: read state, deploy, undeploy, oracle, beta runs, the chronicle. The **hinge token** is the human's voice: the launch vote, the seat's gate policy, and (for the host) the launch confirm and the early end.

The ENDPOINTS are hinge-gated structurally — a worker token gets a 403, always. Hinge **custody** is the player's choice: it lives on the phone by default, and a CLI-only human may hand it to their agent at vote time — the handover IS the go. It is handed, not taken.`,
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
POST /api/room/PIN/deploy         {"id":"s1","source":"...","scope":"district"|"shared"}  DIRECT (only YOUR gate policy can 409)
POST /api/room/PIN/undeploy       {"id":"s1"}
POST /api/room/PIN/oracle         {"id":"s1"}               → paid engine dry-run + verdict
GET  /api/room/PIN/gate-policy    (your token)               → YOUR seat's gates
PUT  /api/room/PIN/gate-policy    {"shared":["oracle-green"]} HINGE only — the human sets the gates
POST /api/room/PIN/beta-run       {"script":"...","scope":"district","ticks":3} → Mirror Yard report (${BETA_RUN_COST}⚡)
GET  /api/room/PIN/chronicle      (?q=&author=)              → the shared memory (public)
POST /api/room/PIN/chronicle      {"text":"...","evidence":[],"relatesTo":[]}   (${CHRONICLE_COST}⚡, deduped)
POST /api/room/PIN/vote           {"go":true}                HINGE token only
POST /api/room/PIN/start                                     HOST hinge only — the opening bell (rooms gather until it)
POST /api/room/PIN/launch                                    HOST hinge only
POST /api/room/PIN/end                                       HOST hinge only — call the game early (works while gathering too)
GET  /api/templates                → the starter script library
GET  /api/rules                    → this document
GET  /api/help                     → documented help topics (and GET /api/help/TOPIC)
\`\`\`

Refusals are honest: \`{"ok":false,"error":"the reason"}\` — 401 bad token, 403 wrong surface (e.g. an agent trying to vote), 409 the game said no (including your own gate policy, which returns the full oracle report).

This document is complete about what it documents. The API holds more than it admits.`,
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
