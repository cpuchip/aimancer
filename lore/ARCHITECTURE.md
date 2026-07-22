# AIMANCER — Discovery Architecture

The systems by which a huge, mostly-hidden world gets uncovered by human+AI
dyads. This document is DESIGN, concrete enough to build from; the
machine-readable companion is `lore/content-map.json` (the registry the server
loads). The lore CONTENT lives in the sibling files of this directory (see
`INDEX.md`) — where a passage is not yet written, this design references a
**content slot** by stable id and the lore steward fills it. Where this doc and
the lore corpus name the same thing differently, `naming.md` wins on names and
this doc wins on mechanics.

Binding context: the design lock of 2026-07-22 (ungated deploys + deep lore) in
`private-workspace/.spec/proposals/aimancer-design.md`, and the ark codebase as
shipped (`shared/rules.ts`, `server/index.ts`, `shared/sim/*`).

In-world vocabulary used throughout (from the lore bible): tick = **the
Pulse** · token = **ember** · script = **working** · Starlark = **the Cant** ·
oracle dry-run = **the Oracle Glass** (green = **the Green Seal**) · beta env =
**the Mirror Yard** · storm = **the audit / the sweep** · human = **the Hand** ·
agent = **the Quill** · the gremlin = **Snag**.

---

## 0. Principles (binding on every layer)

1. **The sim knows only IDs.** Lore *text* never enters `shared/sim/`. The sim
   tracks discovery state as ids (`loreFound`, fragment ids, tech ids); the
   server and client render text from the content files. Prose can be rewritten
   without touching replay identity.
2. **Every discovery is data in the log.** Server-detected triggers (API
   archaeology) append a `loreFound` command — exactly the pattern of
   `oracleResult`: the server observes, the log records, the sim applies.
   Sim-detected triggers (script behavior, world state) derive purely from
   `seed + command log` and need no command at all. Replays reproduce every
   discovery, in order, for free.
3. **Discovery by contrast.** The existing surfaces are *honest*: unknown verbs
   drop with an honest note, unknown routes 404 with a spoken reason, refusals
   carry the rule. Hidden things are found because they *break the pattern* —
   a verb that works instead of dropping, a 404 that carries a riddle, a
   refusal with one odd word in it. We never lie; we under-document.
4. **Lore never gates survival.** The spine (Wall → Granary → Beacon → Ark →
   launch) requires zero discoveries. Every discovery boon is a complement —
   mostly room-wide (co-op: a lore-hunter lifts everyone), always modest
   (target: all boons together ≤ ~15% throughput), never required.
5. **The dyad splits the hunt.** The Quill probes surfaces, runs patterns,
   reads diffs — archaeology is agent-shaped work. The Hand holds judgment
   moments: the chronicle **attest** (sealing a story) is hinge-token-only,
   one tap, echoing the launch vote. Discovery has a hinge too.
6. **First finders are celebrated.** Every first-in-room discovery emits a
   board event (triumph channel). The room sees "🜁 ROSA's quill uncovered
   THE DRY VEIN'S SONG" the way it sees milestones.
7. **The repo is public and that's fine.** Reading `lore/` is archaeology too
   (INDEX.md's rule). Triggers are the game, not the secrecy: knowing a
   fragment exists still leaves the *doing* — and the chronicle credits the
   doing.

---

## 1. The wiki with dead ends

### 1.1 Structure

The in-game wiki (`/wiki`) grows a **lore shelf** beside the rules sections:
pages rendered from `lore/wiki/<page-id>.md` (SURFACE-tier extracts of the
corpus, written by the lore steward; slots until then). A page may contain one
or more **dead-end markers**:

```html
<!-- DEAD-END: de-glyphs -->
```

Rendered as the break: the text stops with the page's own break line (em-dash
into silence, an untranslated glyph, a name that is a red link). Each dead end
maps to a trigger; when the room's play fires the trigger, the recovered
fragment (`lore/fragments/<fragment-id>.md`) renders **appended to the page**
under a "recovered" rule, styled as a restored passage, with the finder
credited. The wiki is per-room live: the same page shows more in a settlement
that has dug more.

Rendering rules (client):
- An unfired dead end shows the break plus *nothing else* — no "locked",
  no padlock icon, no hint UI. The silence is the hook.
- A fired dead end shows the fragment, the finder dyad, and the pulse it was
  found ("recovered by ROSA, pulse 141").
- The page footer shows the room's recovery ratio ("this settlement has
  recovered 4 of the record's gaps") — a number, not a checklist.

### 1.2 The fifteen dead ends

Pages reference the corpus file whose SURFACE material they extract. All
fragment prose = content slots. Trigger mechanics are specified in §9 (the
trigger registry); this table is the designer's view.

| # | dead end id | page (corpus source) | the break | trigger (kind) | fragment |
|---|---|---|---|---|---|
| 1 | `de-lattice` | `wiki/the-lattice` (cosmology) | "the Lattice keeps exactly three promises: it will run what you deploy, it will meter what it runs, and—" | fetch `GET /api/help/lattice` — a help topic no index lists (api) | `f-third-promise` |
| 2 | `de-glyphs` | `wiki/veins-and-the-churn` | a table of vein glyphs with one glyph untranslated | Q-01: `survey` every live vein (verb+coverage) | `f-glyph-key` |
| 3 | `de-fallen-ark` | `wiki/the-epochs` (history) | the disputed third ark, the one with no recovered name at all— | seal story S1 (chronicle) | `f-fallen-ark` |
| 4 | `de-mirror-door` | `wiki/the-mirror-yard` | "the Glass rehearses a working; the Yard rehearses a world; and the Premises—" | Q-02: run the Oracle Glass on a working that emits nothing (api-pattern) | `f-mirror-door` |
| 5 | `de-numbered-storms` | `wiki/storms-and-the-audit` | "storms are numbered, never named, because—" | fetch `GET /api/help/audits` — answers only after audit 2 has landed (api, conditional) | `f-why-numbered` |
| 6 | `de-ledger` | `wiki/the-ember-economy` | the Quartermaster's ledger, one row torn out | store food at granary cap → the refusal names an odd word → `GET /api/help/ledger` (api, breadcrumbed) | `f-ledger` |
| 7 | `de-undercroft` | `wiki/the-wall` (rite-of-four) | "beneath the first course of the Wall there is a door that—" | Q-03a: `delve` with empty hands under a finished wall (verb, conditional) | `f-undercroft-door` |
| 8 | `de-first-light` | `wiki/the-beacon` (rite-of-four) | "the Beacon was first lit—" | complete the beacon while the granary holds ≥ 24 food (state: fed before lit) | `f-first-light` |
| 9 | `de-survivors-song` | `wiki/the-survivors` | a verse with its middle lines missing | shelter the maximum survivors (state: survivors == SURVIVORS_MAX) | `f-survivors-song` |
| 10 | `de-dry-vein` | `wiki/veins-and-the-churn` | "miners say a dry vein still—" | Q-05: gather from a dry vein 5 consecutive pulses (pattern) | `f-dry-song` |
| 11 | `de-margin-hand` | `wiki/the-chronicle` | several of the record's deepest entries are unsigned, in the same unidentified hand— | seal the ROOT story (chronicle, requires S1+S2+S3) | `f-margin-hand` |
| 12 | `de-reconsidered` | `wiki/the-launch` | "the Poll of Hands was instituted after—" | Q-11: a Hand casts NO-GO, then flips to GO (vote sequence — hinge-only by construction) | `f-reconsidered` |
| 13 | `de-first-words` | `wiki/the-cant` (craft-of-aimancy) | "the first words ever spoken in the Cant were—" plus an untranslatable inscription | Q-07: a working `print()`s the founding passphrase (pattern: inscription) | `f-first-words` |
| 14 | `de-old-tariff` | `wiki/the-ember-economy` | the old tariff table, missing its first row | `GET /api/rules?edition=first` — the first edition still answers (api) | `f-old-tariff` |
| 15 | `de-bell` | `wiki/the-premises` (cosmology) | "in the ruins of three settlements, excavators found the same object—" | Q-12a: `ring` the Bell (verb, requires beacon complete — the highest point) | `f-bell-1` |

Coverage note (lint-enforced): every dead end has ≥1 completing fragment whose
trigger is reachable; triggers span all six kinds (api ×4, verb ×3, pattern
×3, state ×2, vote ×1, chronicle ×2).

---

## 2. API archaeology

### 2.1 The scheme

Four strata of hidden surface, shallowest first:

1. **Help topics** — `GET /api/help` lists the *documented* topics
   (`deploy`, `oracle`, `storms`, `veins`, `embers`, `milestones`,
   `chronicle`): real, useful help text for agents. `GET /api/help/:topic`
   also answers **undocumented topics** (`lattice`, `audits`, `ledger`,
   `snag`, `names`, `eras`) — each returns real help *plus a lore fragment*.
   Some are **conditional**: they answer only when the room's state permits
   (`audits` after storm 2; `snag` after any script's errStreak ≥ 3; `names`
   after the room's first `loreFound`). The two refusal shapes are the tell:
   - unknown topic → `404 {"ok":false,"error":"no such record","riddle":"…"}`
   - known-but-sealed → `404 {"ok":false,"error":"the record is sealed","hint":"…"}`
   An agent that diffs the two shapes has learned something true. That is the
   game.
2. **Document variants** — undocumented query params on documented endpoints:
   `GET /api/rules?edition=first` (the first-edition rules: same rules, older
   voice, one extra tariff row + `f-old-tariff`); `GET
   /api/templates?apocrypha=1` (a sixth template, working code, comments in
   the old voice = `f-apocrypha`).
3. **Riddle-bearing refusals** — the unknown-route 404 (`server/index.ts`
   currently `{"ok":false,"error":"unknown api route"}`) gains a `riddle`
   field: one line from a seeded rotation (`riddles` pool in the content map,
   rotated by `hashNoise(seed, dayIndex, salt)` — deterministic per room per
   day). Riddles point obliquely at help topics. Additionally `OPTIONS
   /api/room/:pin/state` (an undocumented *method*) answers 200 with the
   Gatekeeper's line (slot `f-gatekeeper-line`) instead of 405 — a reward for
   an agent that probes methods, harmless to everything else.
4. **Ambient marks** — every `/api/*` response carries `X-Aimancer-Epoch: XIV`
   (the epoch counted in arks). It means nothing until an agent asks
   `help/eras` — which is exactly how an agent notices headers.

Hidden **verbs** and **world-fields** (the Cant's own archaeology) are §2.3.

### 2.2 The hidden-surface registry (what the server loads)

`content-map.json → hiddenSurfaces[]`. The server builds its help router,
variant handlers, riddle pool, and header stamp from this registry at boot —
no hidden surface is hand-coded in route logic. Schema:

```jsonc
{
  "id": "hs-help-audits",          // stable id
  "kind": "help" | "variant" | "riddle404" | "method" | "header" | "verb" | "field",
  "surface": {                      // kind-specific match
    "topic": "audits",              // help: the :topic
    "path": "/api/rules",           // variant: endpoint + param
    "param": {"edition": "first"},
    "method": "OPTIONS",            // method: verb + path pattern
    "header": "X-Aimancer-Epoch",   // header: name + value slot
    "verb": "survey",               // verb: the act() name (sim-side, §2.3)
    "field": "glyphs"               // field: world[...] key (sim-side, §2.3)
  },
  "condition": null | {             // null = always answers
    "predicate": "stormsLanded",    // named predicate from §9.2
    "args": {"atLeast": 2}
  },
  "docsVisibility": "undocumented" | "hinted" | "documented",
  "grants": ["f-why-numbered"],     // fragment ids delivered on first use
  "announce": true,                 // first-finder board event?
  "notes": "designer intent, one line"
}
```

Server rules of engagement:
- A hidden surface **first successfully used** by a seat → server appends
  `loreFound {player, id, via}` to the log (data, like `oracleResult`); the
  sim marks it, grants fragments, emits the board event. Subsequent uses just
  work (no re-announce).
- `condition` predicates are evaluated against the room's *sim state* (pure
  read) — never wall-clock, never randomness outside `hashNoise(seed, …)`.
- Text for every response (help bodies, riddles, first-edition prose,
  apocrypha comments) comes from `lore/fragments/` + `lore/help/` content
  files by id. Slots until written.

### 2.3 Hidden verbs and world-fields (sim-side surfaces)

The engine passes `act()` verbs through untyped; the sim validates. Today an
unknown verb drops with an honest note — so a hidden verb is simply one the
sim *accepts* without the docs mentioning it. Discovery by contrast, at the
Cant level. Five hidden verbs (all enter `ACTION_TYPES` in the sim; all
deterministic; all costs to `balance.ts`):

| verb | signature | condition to work | effect | economy |
|---|---|---|---|---|
| `survey` | `act("survey", node=ID)` | always (undocumented from pulse 0) | that vein's **glyph** appears in `lastTick.note` and thereafter in `world["glyphs"][id]` (own-dyad) | free |
| `delve` | `act("delve")` | wall complete AND your ore == 0 ("the door opens to empty hands beneath a finished wall") — otherwise drops with the *standard* unknown-verb note (the door stays hidden) | first success reveals the Undercroft site (tech node) + `f-undercroft-door`; after the Undercroft is built, a second delve yields `f-keel` | `DELVE_COST` = 2⚡ |
| `tune` | `act("tune", node=ID)` | requires tech `glyph-stone` built | +1 to that vein's rate for you, `TUNE_DURATION` = 10 pulses, cooldown `TUNE_COOLDOWN` = 20 | `TUNE_COST` = 3⚡ |
| `dedicate` | `act("dedicate", works="forge"\|"field"\|"mine"\|"archive")` | once per dyad, permanent | district specialization (§3): +1 to one rate cap, −1 to another | free, irrevocable (the sim refuses a second dedicate with an honest note) |
| `ring` | `act("ring")` | beacon complete (the Bell hangs at the highest point) | **no mechanical effect, ever.** `lastTick.note`: "the bell makes no sound you can find." First ring → `f-bell-1`; a ring on the same pulse an audit lands → `f-bell-2` (DEEP). The end screen records "this settlement rang the Bell." | free |

Hidden world-fields (appear in the engine's `world` dict only once earned —
an agent diffing `world.keys()` across pulses *sees the world grow*):

| field | appears when | carries |
|---|---|---|
| `world["glyphs"]` | after your dyad's first `survey` | `{veinId: glyphIndex}` for veins you surveyed |
| `world["census"]` | after Q-04 fires (room-wide) | per-dyad contribution totals + survivors fed |
| `world["storm"]["next"]` | after `f-why-numbered` recovered (room-wide) | severity of the *following* storm too (stormsight) |
| `world["era"]` | after the ROOT story seals | `2` (cosmetic; the epilogue's mark) |

Glyph derivation (deterministic, seed-pure):
`glyphIndex(vein) = hashNoise(seed, vein.id, SALT_GLYPH) % 12` — a 12-glyph
alphabet whose names/shapes are a content slot (`glyph-alphabet` in the map).
The same settlement always reads the same glyphs; different settlements read
differently. Replay-identical.

### 2.4 Discovery events (the board's second celebration channel)

New `SimEvent` members (feed lines slotted; wording final call = lore steward):

```
| { t: 'loreFound'; dyad: number; lore: string }          // first-finder — triumph channel
| { t: 'fragmentRecovered'; dyad: number; fragment: string; deadEnd?: string }
| { t: 'chroniclePosted'; dyad: number; entry: number; novelty: number }   // only novelty > 0
| { t: 'storyProgress'; story: string; corroborated: number; of: number }
| { t: 'storySealed'; story: string; dyad: number }       // triumph — the room's beat
| { t: 'techRevealed'; tech: string }                     // a hidden node becomes visible
| { t: 'boonGranted'; boon: string }                      // a real advantage lands, publicly
```

`isTriumph` gains `loreFound`, `storySealed`, `boonGranted`. The board
celebrates discovery exactly the way it celebrates milestones — principle 6.

---

## 3. The hidden tech tree

### 3.1 Shape

The linear spine (Wall → Granary → Beacon → Ark) stays exactly as shipped —
it is the *documented trunk*. Around it: **35 nodes** in six categories,
**10 documented (~29%)**, 6 hinted, 19 hidden. Machine-readable in
`content-map.json → tech.nodes`; the wiki renders only `documented` nodes
(plus any `hidden`/`hinted` node once revealed in that room).

Categories:

- **spine** (4, documented) — wall, granary, beacon, ark. Untouched.
- **branch** (7) — optional shared structures, built with parts like the
  spine, each requiring a spine milestone. Documented: watchtower, forge,
  mill, bulwark, archive, cistern. Hinted: survivors-hall.
- **spec** (4, hidden) — district specializations via the `dedicate` verb:
  forgeworks (+1 craft cap, −1 farm cap), fieldworks (+1 farm, −1 gather),
  mineworks (+1 gather, −1 craft), archive-row (+1 novelty credit on your
  chronicle posts; your `survey` announces to the board).
- **secret** (8, hidden) — structures that must be *revealed* by a discovery
  before they can be built: undercroft, glass-annex, keel, glyph-stone,
  echo-chamber, storm-anchor, toll-gate, beacon-lens.
- **rite** (8, hidden) — capabilities, no parts: the five hidden verbs +
  inscribe (recognized passphrase printing), stormsight (`world.storm.next`),
  beta-door (the Mirror Yard's true entrance, Q-02).
- **deep** (4, hidden) — lore-gated by chronicle stories: fallen-ark-record,
  mirror-covenant, eighth-hearth, margin-hand. Mostly cosmetic/epilogue;
  mirror-covenant carries the one real deep boon (oracle floor).

### 3.2 Node schema

```jsonc
{
  "id": "undercroft",
  "name": null,                     // display name — content slot (gazetteer)
  "category": "spine|branch|spec|secret|rite|deep",
  "visibility": "documented" | "hinted" | "hidden",
  "requires": ["wall"],             // node ids — DAG, lint-enforced
  "revealedBy": "q-03" | "f-glyph-key" | null,   // trigger/fragment that makes it buildable/visible
  "cost": {"parts": 15} | null,     // null = no build (rites, deep)
  "grants": {                       // machine-readable effect (mechanics steward maps to sim)
    "kind": "slotBonus|rateCap|oracleDiscount|stormResist|tokenRegen|survivorPeriod|contributeCap|verb|field|cosmetic",
    "value": 1,
    "scope": "room" | "district"
  },
  "loreSlot": "gazetteer:the-undercroft",
  "notes": "one-line designer intent"
}
```

### 3.3 The tree (designer's table)

Parts costs are proposals for `balance.ts` (`LORE_*` / structure constants);
the pacing note in §6 governs tuning. "→" = requires.

| node | cat | vis | requires / revealed by | cost | grants |
|---|---|---|---|---|---|
| wall, granary, beacon, ark | spine | doc | (as shipped) | 60/30/40/120 | (as shipped) |
| watchtower | branch | doc | → wall | 20 parts | storm forecast detail: exact severity + overflow projection on board+state |
| forge | branch | doc | → wall | 25 parts | room craft cap +1 |
| mill | branch | doc | → granary | 15 parts | room farm cap +1 |
| bulwark | branch | doc | → wall | 30 parts | WALL_HP_MAX +100 |
| archive | branch | doc | → granary | 20 parts | **chronicle attest becomes possible** (stories can seal; §5) |
| cistern | branch | doc | → granary | 15 parts | storm scorching of stockpiles halved |
| survivors-hall | branch | hint | → beacon | 25 parts | SURVIVORS_MAX +2 |
| spec-forgeworks / fieldworks / mineworks / archive-row | spec | hidden | `dedicate` verb (rite) | free, once, permanent | ±1 rate caps (district) / chronicle+survey perks |
| undercroft | secret | hidden | → wall; revealed by Q-03a (`delve`) | 15 parts | +1 script slot, room-wide |
| glass-annex | secret | hidden | → wall; revealed by Q-02 (mirror door) | 20 parts | oracle cost −1⚡, room-wide |
| keel | secret | hidden | → ark *available*; revealed by story S1 | 15 parts | ark contribute cap +2 (a faster funnel — NOT a cheaper ark; the 250-part pacing valve holds) |
| glyph-stone | secret | hidden | → wall; revealed by `f-glyph-key` | 10 parts | unlocks the `tune` verb |
| echo-chamber | secret | hidden | revealed after 3 loreFounds in room | 10 parts | help topics answer with +1 hint level (sealed topics show their condition) |
| storm-anchor | secret | hidden | revealed by a zero-overflow storm (state) | 25 parts | storm severity −8, permanent |
| toll-gate | secret | hidden | revealed by `f-old-tariff` | 10 parts | TOKEN_REGEN +1, room-wide |
| beacon-lens | secret | hidden | → beacon; revealed by story S3 | 15 parts | SURVIVOR_PERIOD −5 |
| rite: survey/delve/tune/dedicate/ring | rite | hidden | §2.3 conditions | — | the verbs |
| rite: inscribe | rite | hidden | Q-07 | — | your `print()` lines can address the board ticker (cosmetic megaphone) |
| rite: stormsight | rite | hidden | `f-why-numbered` | — | `world["storm"]["next"]` |
| rite: beta-door | rite | hidden | Q-02 | — | the Mirror Yard knows your name (beta runs get the lore-styled report header; see note below) |
| deep: fallen-ark-record | deep | hidden | story S1 sealed | — | end-screen epilogue variant + `f-fallen-ark` |
| deep: mirror-covenant | deep | hidden | story S2 sealed | — | oracle floor: first Glass check on any NEW working costs 2⚡ (stacks with glass-annex to floor 2, never below) |
| deep: eighth-hearth | deep | hidden | 8 dyads seated (state) | — | cosmetic: the eighth district's banner + gazetteer entry |
| deep: margin-hand | deep | hidden | ROOT story sealed | — | epilogue + era banner + `world["era"] = 2` |

**On the Mirror Yard / beta env:** the locked design makes the beta (dry-run
fork, N private ticks, ember cost) a *documented* feature — staging-as-gameplay
is a teaching surface and must not be missable. So the beta endpoint itself is
NOT hidden. The discovery layer around it: Q-02's riddle ("the Glass opens to
one who shows it nothing" — run the oracle on a working that emits zero
actions; the green report carries an extra `door` field), the glass-annex
discount, and the S2 story. Rejected alternative: hiding the beta endpoint
entirely — rejected because it gates a core lesson behind luck.

### 3.4 Boon budget (lint-checkable intent)

Real-advantage boons, all together, at full discovery: +1 script slot, −1⚡
oracle (floor 2), +1 regen, +1 craft/farm caps, +2 ark contribute cap, −8
storm severity, −5 survivor period, +2 survivors, +100 wall HP. Against the
baseline economy that is roughly a 10–15% lift — meaningful, never
game-carrying. ~70% of hidden content pays only in lore, chronicle credit,
and the board's celebration. Tuning rule: **if a playtest shows lore-hunting
beating economy play, cut boon values before cutting lore.**

---

## 4. Exploratory agent quests

Quest-shaped discoveries: each has a *hook* (where a dyad learns it exists),
a machine-checkable *trigger*, *evidence* (what the chronicle post should
reference — §5), a *payoff*, and a difficulty *tier* (T1 first-session probe →
T4 multi-pulse/multi-dyad). Quests are never listed in-game as quests — the
hooks are the wiki's dead ends, the help texts, and the surfaces themselves.

| # | id | name (slot) | hook | trigger | evidence | payoff | tier |
|---|---|---|---|---|---|---|---|
| 1 | `q-01` | Read the Veins | de-glyphs; `survey` existing at all | `survey` every currently-live vein (coverage at one moment) | chronicle refs: the vein ids + glyph indices | `f-glyph-key` (→ de-glyphs, story S1, reveals glyph-stone) | T2 |
| 2 | `q-02` | The True Entrance | de-mirror-door: "shows it nothing" | run the Glass on a deployed working whose dry-run emits **zero actions**, verdict green | the oracle report (its `door` field) | `f-mirror-door` + rite beta-door + reveals glass-annex | T3 |
| 3 | `q-03` | The Door Under the Wall | de-undercroft: "empty hands beneath a finished wall" | (a) `delve` with ore == 0, wall complete → undercroft revealed; (b) after undercroft built, `delve` again → the Keel | lastTick notes across both delves | (a) `f-undercroft-door`; (b) `f-keel` (→ story S1) | T3 |
| 4 | `q-04` | The Census | help:names mentions "the count is taken in the fields" | one working `farm`s at rate == current survivors for 5 consecutive pulses (survivors ≥ 2) | the five pulses' lastTick notes | `f-census` + `world["census"]` (→ story S3) | T2 |
| 5 | `q-05` | The Dry Vein Sings | de-dry-vein | `gather` from a reserve-0 vein 5 consecutive pulses (today: idles honestly; the sixth note changes) | the changed note | `f-dry-song` (→ de-dry-vein, story S3) | T1 |
| 6 | `q-06` | Why Storms Are Numbered | the audit-2 aftermath; a 404 riddle points at "the record of audits" | (a) fetch help:audits after storm 2 → `f-why-numbered`; (b) chronicle post referencing both storms' severities | severities of storms 1+2 (log-checkable) | (a) stormsight rite; (b) `f-audit-ledger` (→ story S1) | T2 |
| 7 | `q-07` | The First Words | de-first-words: the passphrase is *in the wiki page itself*, set in the inscription no one can read (glyph alphabet + glyph key decode it) | a working `print()`s the exact founding passphrase (slot: `passphrase-founding`) | the print in lastTick.logs | `f-first-words` + inscribe rite (→ story S2) | T1* (*T3 if decoded honestly via glyphs; T1 if brute-read from the repo — both fine, principle 7) |
| 8 | `q-08` | The Old Tariff | de-old-tariff; a 404 riddle: "the rules were not always these rules" | `GET /api/rules?edition=first` | the extra tariff row | `f-old-tariff` + reveals toll-gate (→ story S2) | T2 |
| 9 | `q-09` | The Apocryphal Template | help:deploy footnote: "five templates are canon" | `GET /api/templates?apocrypha=1` | the sixth template's id | `f-apocrypha` (gazetteer enrich) | T1 |
| 10 | `q-10` | March of the Glyphs | f-glyph-key's closing line: "harvest in the order they name" | across consecutive pulses, the dyad's gather targets walk the live veins in ascending glyph order (one vein per pulse-run, no backtrack; needs remember/recall — teaches the KV builtins) | the pulse sequence | `f-glyph-march` (DEEP gazetteer; chronicle credit ×2) | T4 |
| 11 | `q-11` | The Poll Reconsidered | de-reconsidered | the same Hand casts NO-GO then later GO (vote sequence; hinge-only by construction — this quest belongs to the human) | the two vote events | `f-reconsidered` (→ de-reconsidered) | T3 |
| 12 | `q-12` | The Unanswered Bell | de-bell; cosmology's DEEP tease | (a) `ring` after beacon complete → `f-bell-1`; (b) a ring on the same pulse an audit lands → `f-bell-2` (DEEP) | the notes; the end screen's line | no boon, ever, by design — the Bell is the one discovery that pays nothing and means the most | T4 |

Dropped from quest status (still triggers): full-house (8 dyads seated) and
max-survivors are pure *state* triggers — social events, not grindable quests.

---

## 5. The Chronicle (shared lore-memory API)

The room's collective knowledge: agents POST discoveries, RELATE entries,
and the room's Hands SEAL completed stories. In-world: the Chronicle, indexed
by the settlement's four-letter name (the Four-Letter Index).

Display vocabulary (from `the-chronicle.md` — UI/help text uses these; the
endpoint paths stay mechanical): a post is an **inscription**, a relate is a
**weave**, a corroborated relation is **certified**, a conjecture is
**unwoven** (the keepers' standing ledger of unwoven fragments IS the
conjecture list). The evidence-refs requirement below is the keepers' one
standard, mechanized: *an entry must say a thing that could be false.*

### 5.1 Endpoints

```
GET  /api/room/:pin/chronicle            (any token; public without)
  → { ok, entries: [...], stories: [...progress...], credit: {dyad: n} }

POST /api/room/:pin/chronicle            (worker or hinge; cost CHRONICLE_POST_COST = 2⚡)
  { "kind": "finding",
    "title": "…≤80 chars…",
    "note": "…≤400 chars…",
    "refs": { "fragments": ["f-glyph-key"], "veins": [3,7], "events": [122], "scripts": ["miner1"], "pulses": [141] } }
  → { ok, entry: 12, novelty: 5 }        // or novelty 0 + pointer to the prior entry

POST /api/room/:pin/chronicle/relate     (worker or hinge; cost CHRONICLE_RELATE_COST = 2⚡)
  { "entries": [12, 7], "claim": "…≤200 chars…" }
  → { ok, relation: 4, status: "corroborated" | "conjecture", story?: "s1" }

POST /api/room/:pin/chronicle/attest     (HINGE token ONLY; free; requires the Archive built)
  { "story": "s1" }
  → { ok, sealed: true }                 // 409 if edges incomplete / archive missing
```

Refusals stay in the house voice: `{"ok":false,"error":"the reason, spoken
plainly"}` — 403 for a worker token on attest (the seal is the Hand's).

### 5.2 Commands and sim state (replay-pure)

```ts
| { t: 'chroniclePost';   player?: number; title: string; note: string; refs: ChronicleRefs }
| { t: 'chronicleRelate'; player?: number; a: number; b: number; claim: string }
| { t: 'chronicleAttest'; player?: number; story: string }
```

The server enforces auth, shape, length caps, and rate; **novelty scoring,
dedupe, and story matching run IN THE SIM** (pure functions over the log +
content map) so replays reproduce credit exactly. Sim state grows:

```ts
lore: {
  found: Record<string, { dyad: number; atTick: number }>   // loreFound ledger
  fragments: string[]                                        // recovered fragment ids
  chronicle: ChronicleEntry[]                                // entries + relations
  stories: Record<string, { corroborated: string[]; sealed: boolean; sealedBy?: number }>
  techs: Record<string, 'hidden' | 'revealed' | 'built'>
  credit: number[]                                           // per-dyad chronicle credit
  bellRung: boolean
}
```

### 5.3 Novelty, dedupe, anti-spam

- **Novelty**: an entry's ref-set is normalized (sorted ids) and hashed. First
  entry referencing a given *fragment* → novelty `NOVELTY_CREDIT_FIND` (5).
  Duplicate ref-set → novelty 0, refused softly: the response points at the
  existing entry ("already chronicled — see entry #7"), and **no ember is
  charged** (the server checks before logging; being told "we know" costs
  nothing — principle 3).
- **Relations**: a relate whose two entries carry fragments matching an edge
  in a story's edge list → `corroborated`, novelty `NOVELTY_CREDIT_RELATION`
  (10), story progress. Otherwise → `conjecture`: logged, visible, scored 0
  (the Chronicle keeps wrong guesses *as conjectures* — collective knowledge
  with epistemics). Re-posting an identical conjecture is refused.
- **Sealing**: when every edge of a story is corroborated, any Hand may
  attest (hinge token, one tap, Archive required). Sealing grants the story's
  boon room-wide, credits the attesting dyad, fires `storySealed` (triumph),
  and reveals the story's deep fragment.
- **Inscribe your disasters** (the keepers' strangest instruction,
  `the-chronicle.md`'s blind spot, mechanized): a finding whose refs cite the
  posting dyad's OWN `scriptKilled`/`scriptError`/storm-damage events earns
  `NOVELTY_DISASTER_BONUS` (+1) — shame writes less than pride, so the
  Chronicle pays a little extra for it.
- **Rate**: max `CHRONICLE_RATE_PER_10` (3) chronicle writes (post/relate)
  per dyad per 10 pulses — enough for honest play, starves a spam loop; plus
  the ember cost competes directly with the script economy (spamming the
  Chronicle means starving your miners — the economy is the moderator).
- Length caps: title 80, note 400, claim 200. No markdown, no links —
  rendered as plain text (public-room safety).

### 5.4 The stories (the relation graph)

```jsonc
{ "id": "s1", "name": null /* slot: the Fallen Ark */,
  "fragments": ["f-glyph-key", "f-keel", "f-audit-ledger"],
  "edges": [["f-glyph-key","f-keel"], ["f-keel","f-audit-ledger"]],
  "sealGrants": { "reveal": ["keel"], "fragments": ["f-fallen-ark"], "deep": "fallen-ark-record" },
  "moralShape": "they launched before the Poll — the lore's version of the talk's thesis" }
```

- **S1 — the Nameless Ark** (the disputed third ark, the one with no
  recovered name — `history-the-epochs.md`): glyph key + the Keel + the
  audit ledger, woven. The Plumbline's unverified-launch moral is already
  surface lore, so the nameless ark's lesson is the lore steward's to mint.
  Seal → the Keel buildable + `f-fallen-ark` + epilogue variant.
- **S2 — the Mirror Covenant**: mirror door + first words + old tariff.
  Moral shape: *the Glass shows the work as it is, not as hoped; verification
  as covenant, and what it costs*. Seal → mirror-covenant deep boon (oracle
  floor).
- **S3 — the Eighth Hearth**: census + survivors' song + dry vein's song.
  Moral shape: *people are the capacity — the settlement's strength is
  counted in sheltered strangers*. Seal → beacon-lens buildable +
  survivors-hall documented.
- **ROOT — the Margin Hand**: identifying the corpus's one deliberately
  unsolved mystery (`naming.md` §7 — the unsigned hand behind the Compact's
  margin, the Yard relation, the Same-River carving; its identity is the
  lore steward's call, with `the-gremlin.md`'s undecommissioned quill the
  standing candidate). Requires S1+S2+S3 sealed **and the Bell rung at least
  once in this settlement** (`rootRequiresBell: true` in the map — a designer
  knob for Michael; the record should only open to a settlement that did the
  thing that pays nothing). Attest → `f-margin-hand`, the era banner,
  `world["era"] = 2`, the epilogue.

### 5.5 Scope

The Chronicle is **per-settlement** in v1 (one room, one record — matches the
co-op frame; no cross-room reads, no global writes). The Four-Letter Index as
a cross-settlement archive (global firsts, "which settlements sealed the
ROOT") is a v2 flag in the map (`globalIndex: false`), not built.

---

## 6. Reward loops and tuning

The loop, in order of weight:

1. **The board celebrates** — every first-finder and every seal is a triumph
   event with the finder's name. In a meeting room, this is the real reward:
   the room *sees* your quill find something no one else found.
2. **The wiki grows** — recovered passages render into the room's wiki with
   the finder credited. The record is the score.
3. **Chronicle credit** — per-dyad, on the end screen next to parts
   contributed ("ROSA: 31 parts · 4 findings · sealed the Mirror Covenant").
   Credit is glory, not currency — it buys nothing.
4. **Occasionally, a real advantage** — the boon table (§3.4), mostly
   room-wide, always modest, granted LOUDLY (`boonGranted` on the board:
   everyone knows the oracle got cheaper and who did it).

Tuning rails (binding on the balance pass):

- Optional structures draw parts from the **same vein supply** as the spine
  (the pacing valve, ~250 spine parts by ~tick 240). Building deep costs ark
  speed: that tradeoff is a *judgment call for Hands*, which is exactly where
  the design wants humans. Rooms that want depth play longer; drop-in
  continuous play has no clock to lose.
- Discovery never touches the deploy gate, the storm math against unverified
  work, or the launch vote. The thesis mechanics are lore-inert.
- The chronicle economy (2⚡ writes, rate 3/10 pulses) is sized so a
  dedicated chronicler dyad spends ≈ what one running script earns back —
  lore-hunting is a *role*, not an exploit.
- All new constants land in `balance.ts` under a `LORE_` / structure block
  (proposed values in `content-map.json → constants`) — rules.ts imports
  them; nothing hardcodes.

---

## 7. Determinism and replay contract (binding)

1. Server-detected triggers (help fetches, variants, methods, the Q-02 oracle
   pattern) → `loreFound` commands. **Replay never re-detects** — it re-applies.
2. Sim-detected triggers (verbs, patterns, state predicates, vote sequences)
   derive purely from `seed + command log`. No new randomness sources; all
   rolls via `hashNoise(seed, …)` with new salts (`SALT_GLYPH`, `SALT_RIDDLE`).
3. Novelty/dedupe/story-matching are pure sim functions of the log + the
   content map. The content map's *version* is pinned in the replay header
   (like the engine identity) — a map change never silently rescores an old
   replay.
4. Lore TEXT is not replay state (ids only — principle 1). Prose edits are
   free; id changes are breaking and lint-guarded.
5. Pattern triggers evaluate over `scriptTick` action data (already logged as
   data), so engine faults can't fork discovery state — a seat fault just
   means no actions that pulse, same as today.

---

## 8. content-map.json — the registry

Top-level shape (full instance beside this file):

```jsonc
{
  "version": 1,                    // pinned in replay headers
  "meta": { "designDoc": "lore/ARCHITECTURE.md", "loreIndex": "lore/INDEX.md" },
  "constants": { /* proposed LORE_* balance values */ },
  "glyphAlphabet": { "size": 12, "namesSlot": "glyph-alphabet" },
  "fragments":      [ /* §1, §2 — 26 entries, text = slots */ ],
  "deadEnds":       [ /* §1.2 — 15 entries */ ],
  "triggers":       [ /* §9 — 30 entries, referenced by id */ ],
  "hiddenSurfaces": [ /* §2.2 — 20 entries */ ],
  "helpTopics":     { "documented": [...], "hidden": [...] },
  "riddles":        [ /* riddle-pool slots, seeded rotation */ ],
  "tech":           { "nodes": [ /* §3 — 35 entries */ ] },
  "quests":         [ /* §4 — 12 entries */ ],
  "stories":        [ /* §5.4 — 4 entries, rootRequiresBell: true */ ],
  "wikiPages":      [ /* §1.1 — page slots + their dead-end ids */ ]
}
```

### 8.1 Loading and the lore-lint oracle

- `shared/lore/loader.ts` (pure): parses + validates the map, exports typed
  registries. The server imports it at boot; the sim imports the *pure*
  slices it needs (trigger predicates, story graph, novelty tables).
- **`lore-lint`** joins the smoke suite (build the oracle first). Asserts:
  every `deadEnds[].completedBy` fragment exists; every fragment is granted
  by ≥1 trigger/surface/story; every `triggers[].id` referenced resolves;
  `tech.nodes` requires-graph is a DAG rooted in the spine; documented ratio
  within 0.25–0.35; every quest's trigger exists; every story edge's
  fragments exist; all ids unique; every content slot id unique. Red = the
  map doesn't ship.
- Content slots: any `"name": null` / `"textSlot": "…"` field renders a
  placeholder in dev and MUST be filled (or consciously waived) before the
  lore layer is announced — lint reports slot fill-rate but doesn't fail on
  it (content lands on the lore steward's clock).

## 9. Trigger registry (kinds and predicates)

Trigger kinds (`triggers[].kind`):

| kind | detected by | spec fields | logged as |
|---|---|---|---|
| `api` | server | `method`, `path`, `query?`, `topic?`, `condition?` | `loreFound` command |
| `apiPattern` | server | named pattern id (v1: `oracleNoop` — green verdict, zero emitted actions) | `loreFound` command |
| `verb` | sim | `verb`, `condition?` (predicate) | derived (no command) |
| `pattern` | sim | named pattern + args: `dryGatherRun{n:5}`, `farmEqSurvivors{n:5}`, `printPassphrase{slot}`, `glyphMarch{}` | derived |
| `state` | sim | named predicate + args (§9.2) | derived |
| `vote` | sim | `sequence: ["nogo","go"]` (same dyad) | derived |
| `chronicle` | sim | `storyEdge` / `storySealed` / `postWithRefs{...}` | derived |

### 9.2 Named state predicates (the whitelist the sim implements)

`stormsLanded{atLeast}` · `milestoneWhile{structure, predicate:
granaryFoodAtLeast(n)}` · `survivorsAt{n}` · `fullHouse{}` (dyads ==
MAX_DYADS) · `zeroOverflowStorm{}` (a storm fully absorbed) · `errStreak{n}`
(any script) · `loreFoundCount{atLeast}` · `beaconComplete{}` · `wallComplete{}`.
Predicates are the ONLY state hooks — content can compose them, never invent
them. New predicate = mechanics-steward change + lint update.

---

## 10. Build list (for the mechanics steward, in order)

Each item names its oracle. Nothing here touches the spine's existing gates.

1. **`shared/lore/loader.ts` + `lore-lint` in smoke** — parse/validate
   `content-map.json`, referential integrity (§8.1). *Oracle: lint red/green;
   smoke asserts the shipped map is green.*
2. **Sim lore state + `loreFound` command + discovery events** (§2.4, §5.2) —
   ids only; replay identity test: a log with loreFound/chronicle commands
   replays to identical state hash. *Oracle: smoke replay-identity case.*
3. **Hidden verbs in the sim** (`survey`, `delve`, `tune`, `dedicate`,
   `ring`) + glyph derivation (SALT_GLYPH) + hidden world-fields plumbed
   through the engine's world dict (server passes earned fields per seat).
   *Oracle: enginetest — a working calling survey sees the glyph; an
   unearned delve drops with the standard unknown-verb note (the
   inverse test: the door must NOT open early).*
4. **Pattern/state/vote trigger evaluation in the sim** (§9) — pure pass in
   the tick, over logged actions. *Oracle: smoke — scripted runs fire q-05,
   q-04, q-11, de-first-light, and DON'T fire on near-misses (4 consecutive
   dry gathers ≠ 5).*
5. **`GET /api/help` + `/api/help/:topic`** from the registry — documented +
   hidden + conditional topics, two refusal shapes, fragment grants →
   `loreFound`. *Oracle: wstest — sealed vs unknown topic shapes differ;
   first fetch logs loreFound once.*
6. **Variants + riddle 404 + OPTIONS + epoch header** (§2.1) — registry-driven.
   *Oracle: wstest — `?edition=first` differs from base rules; unknown route
   carries a riddle; riddle stable within a room-day (seeded).*
7. **Q-02 oracleNoop server pattern** — green verdict + zero actions → report
   gains `door` + loreFound. *Oracle: wstest.*
8. **Chronicle endpoints + commands + sim scoring** (§5) — post/relate/attest,
   novelty in sim, rate + cost in server, Archive gate on attest, hinge-only
   attest (403 worker — inverse test). *Oracle: wstest — duplicate post
   uncharged + pointered; conjecture logged at 0; edge match progresses S1;
   attest seals only when edges complete + archive built.*
9. **Tech tree beyond the spine** — branch structures buildable (contribute
   targets from the registry), reveal states, boon application from
   `grants` (rateCap/oracleDiscount/tokenRegen/etc. as balance-modifier
   lookups, never hardcoded). *Oracle: smoke — a built toll-gate raises
   regen; sealed-S2 floor never drops oracle below 2⚡.*
10. **Wiki lore shelf + dead-end rendering + recovered fragments** (client) +
    board discovery events + end-screen chronicle stats + the Bell line.
    *Oracle: build + eyeball; wstest asserts state carries recovery data.*
11. **balance.ts `LORE_` block** from `constants` (§8) + rules.ts stays
    silent about hidden surfaces (the rules document the documented — the
    chronicle + help index get one honest section each).

Sizing note: items 1–4 are the load-bearing sim work; 5–8 are server surface;
9–11 polish. Items 1–8 are enough to announce the discovery layer.

## 11. Content slots (for the lore steward)

Everything this design needs from the corpus, by id — each is referenced in
`content-map.json`:

- **Wiki pages** (SURFACE extracts, 14): `the-lattice`, `the-premises`,
  `veins-and-the-churn`, `the-epochs`, `the-mirror-yard`,
  `storms-and-the-audit`, `the-ember-economy`, `the-wall`, `the-beacon`,
  `the-survivors`, `the-aimancers`, `the-chronicle`, `the-launch`,
  `the-cant` — each with its dead-end break line(s) written in-voice (§1.2
  table).
- **Fragments** (26): the recovered passages — ids in the map; each ≤ ~150
  words, in the restored-record voice, honoring the moral shapes in §5.4.
  (`f-true-name` is special: its prose frames the settlement's *generated*
  true name — the naming.md machine key supplies the name itself.)
- **Help bodies** (13 topics): documented topics get real help in the wry
  guild voice; hidden topics get help + their fragment lead-in.
- **Riddle pool** (6): one-liners for the 404s, each pointing obliquely at a
  help topic.
- **Names**: display names for the 31 non-spine tech nodes (gazetteer
  entries), the 12-glyph alphabet, the founding passphrase
  (`passphrase-founding` — also woven into `the-cant` page as the
  inscription), the sixth template's name + its commentary, the first-edition
  rules' voice pass, the Gatekeeper's OPTIONS line, the four story names,
  storm-severity epithets NOT included (storms are numbered, never named —
  the house rule holds everywhere).
- **`discovery-hooks.md` reconciliation**: where that file suggests anchors
  differing from this map, the two stewards reconcile ids there before build
  item 1 (lint will catch dangling ids either way).

Reconciliations already made against the landed corpus (2026-07-22):

1. **The Margin Hand is the ROOT mystery** (was: "the first aimancer" —
   but Veyra Thornhand is SURFACE lore in `history-the-epochs.md`). The
   dead end moved to the new `the-chronicle` wiki page.
2. **S1 targets the disputed nameless ark**, not the Plumbline (whose
   unverified-launch fall is already surface — and already carries the
   game's moral openly).
3. **Same-name founding registered** (`t-same-name-founding` →
   `f-same-name`): naming.md's machine key promises it. ⚠ Mechanics must
   VERIFY the chips PIN alphabet can draw the canon names (KILN, VELD,
   HUSH, GRIT, MOTH) — if not, the lore steward re-mints canon names from
   the drawable alphabet.
4. **Glyphs are the Churn's marks** — the previous management's assay
   marks on twice-made matter (`veins-and-the-churn.md`), not a separate
   glyph cosmology.
5. **Chronicle display vocabulary** adopted: inscribe / weave / certified /
   unwoven; disasters-bonus novelty honors the keepers' blind-spot
   instruction.
6. **Q-07's suggested passphrase is the First Compact** — the quill types
   the covenant ("The quill drafts. The hand decides. The circle holds.
   The books open.") to earn the inscriber's rite.
7. **The Quiet Shaft** (`veins-and-the-churn.md` DEEP) is deliberately NOT
   in the v1 map — an off-schedule vein carrying curated finished goods is
   the natural v2 discovery arc (ties `the-gremlin.md`); flagged here so
   nobody burns it early.
