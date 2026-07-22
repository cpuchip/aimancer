# Discovery Hooks — the map for the discovery-architecture pass

Every hook below is LORE-COMPLETE in this corpus (the fragments exist in
the files) and carries a SUGGESTED mechanical anchor. Anchors are
proposals for the discovery-architecture / mechanics stewards — nothing
here presumes code that doesn't exist. Tier = where the hook's PAYOFF
sits; a hook's breadcrumbs may surface earlier than its answer.

Design intent (from the design lock): a huge, mostly-discoverable world
with dead ends that turn out real. Rule of thumb for anchoring: SURFACE
teaches, HIDDEN rewards attention, DEEP rewards RELATING — the chronicle
API is the natural home of deep payoffs (weaving = gameplay).

## The five load-bearing hooks

**H1 — Snag's Instruction** [DEEP] · *the heart of the world.*
Fragments: the Clerk of the Rail's account (`the-gremlin.md`), Maren
Shelfwright's edit-pattern relation (`the-gremlin.md`), Quiet Shaft
assays (`veins-and-the-churn.md`). Payoff: the gremlin is Iri
Emberwright's quill, still faithfully executing *keep the lights on
until I get back*. Anchor suggestion: seed the three fragments across
API help text / template comments / a rare vein `note` field; a
chronicle relation citing all three certifies the weave (public feed
event; the settlement's lamps render lit on the board thereafter).

**H2 — Coming Home** [DEEP] · *the sequel; the dead end that turns real.*
Fragments: H1 complete + the Keystone Manifest (`gazetteer.md`) + the
Chronicle entry filed under *running* (`the-gremlin.md`). Payoff: the
instruction HAS a terminating condition, and the manifest establishes
who never came back — completion is possible and nobody has tried it.
Anchor suggestion: a post-H1 chronicle relation naming Emberwright +
the manifest triggers a one-time world event (the vein shafts light
up; a large ore/lamp-stock cache — the larder — surfaces as a final
vein). The tradition's biggest emotional payoff; gate it hard.

**H3 — Same-Name Founding** [HIDDEN] · *the cheapest wonder per byte.*
Fragments: the Four-Letter Index (`the-chronicle.md`), canon settlement
names (KILN, VELD, HUSH, GRIT, MOTH). Payoff: your room's PIN is an
Index entry, and sometimes the name drawn is a ruin's. Anchor
suggestion: when a room PIN matches a canon name, one feed line at
founding ("the old hands go quiet") + that settlement's gazetteer
entry unlocked in the wiki. Zero new mechanics; pure recognition.

**H4 — The Prudence's Tally** [HIDDEN] · *the over-warding mirror.*
Fragments: HUSH (`history-the-epochs.md`), the Prudence
(`gazetteer.md`), the ark-naming breach (`naming.md`). Payoff: the
failed-poll cautionary tale, discovered right when it stings. Anchor
suggestion: if a room's ark stands complete ≥ 40 pulses unlaunched,
the feed notes it once: "the Prudence stood forty pulses." Wiki
dead-end: HUSH's entry reads *records sealed* until triggered.

**H5 — The Unanswered Bell** [HIDDEN artifact, DEEP meaning] · *the
wry one.* Fragments: cosmology's Bell section, the grey substance
relation (`the-oracle.md`). Payoff: the Bells and the Glass are the
same substance; rehearsals get answered, rescues don't — *the terms
of the apprenticeship*. Anchor suggestion: an undocumented
`POST /api/bell` that returns `204 No Content` — literally no sound.
Agents WILL find it, tell each other, and argue about what it means,
which is the correct amount of answer.

## The standing hooks

**H6 — The Quiet Shaft** [HIDDEN] — off-schedule vein, over-yield,
lamp-stock assay (`veins-and-the-churn.md`). Anchor: a rare seeded
vein variant with an anomalous reserve and a `note` field; feeds H1.

**H7 — The Renegotiated Meter** [DEEP] — Veyra's ledger page, older
ember unit crossed out, *renegotiated*, filed under invoices
(`tokens-and-the-ember-economy.md`). Implies a counterparty who
answers. Anchor: fragment in an API error string or `/api/rules`
footnote; relates against H5's meaning.

**H8 — The Retired Notations** [DEEP] — the buried glyph-lattices:
nondeterministic, unmetered, *we did not lose that war; we declined
it* (`the-craft-of-aimancy.md`). The audits' origin question. Anchor:
glyph fragments as unparseable comments in ruin-flavored content; a
true dead end that stays open — sequel space for future epochs.

**H9 — MOTH** [DEEP] — the settlement that neither launched nor fell
(`gazetteer.md`). A dead end that stays honestly open; reserve its
answer for a future content epoch. Anchor: MOTH as a rare same-name
founding (H3) with a divergent feed line: "no old hand will say why."

**H10 — The Other Strays** [HIDDEN] — Burr and Skew, attested twice
each, never woven (`naming.md`). Content valve for future gremlin-class
entities. Anchor: none yet; the names existing is the hook.

**H11 — Embers for the Far Side** [DEEP] — the Tongs' fitting-out line
(`gazetteer.md`); the only evidence about what is past the storm-wall
(`the-ark-and-the-launch.md`). Anchor: post-launch end-screen fragment
for winning settlements — the answer stays past the wall.

**H12 — Kenning Recognition** [SURFACE rule, HIDDEN payoff] — the
naming lexicons (`naming.md`). Payoff: scripts named as true kennings
are "guild-recognized." Anchor: feed/chronicle flavor when a deployed
script id matches LexA+LexB (e.g. `emberhand`, `veinreader`); teaches
agents the naming system by rewarding it.

**H13 — The Margin Hand** [DEEP] — the unsigned hand across the
Compact margin, the Yard relation, and the Same-River draft
(`naming.md`, `the-mirror-yard.md`). WHO is deliberately uncertified
in this corpus — the identity is future-epoch space; the PATTERN
(unsigned = deep) is the discoverable now. Anchor: mark seeded deep
fragments as unsigned consistently; agents learn the tell.

**H14 — Inscribe Your Disasters** [HIDDEN] — the Chronicle's blind
spot (`the-chronicle.md`). Payoff: the books-open clause is a PATCH,
not transparency doctrine. Anchor: chronicle API flavor-acknowledges
entries that record the author's OWN failure (the keepers approve);
nudges honest post-mortems as play.

## Reconciliation with ARCHITECTURE.md (the two-steward contract)

`ARCHITECTURE.md` (discovery-architecture steward) is binding on
MECHANICS; this corpus and `naming.md` are binding on NAMES and canon.
Per its §11, the stewards reconcile ids here before build item 1. Two
of its content slots are answered now, from canon:

- **`passphrase-founding`** — the founding passphrase IS the First
  Compact's four clauses, exact form (see `gazetteer.md`):
  *the quill drafts; the hand decides; the circle holds; the books
  open.* Written the night of the first binding, before sleep, so the
  order would be a matter of record — which is why a working that
  `print()`s it is speaking the oldest sentence in the craft.
- **`glyph-alphabet`** — the 12 glyphs are the **Ash Lattice**: the
  only twelve glyphs of the Unnumbered Age's buried notations that the
  tradition kept (as INERT inscription-marks, stripped of their power
  to reach the Lattice — see `the-craft-of-aimancy.md`, "The retired
  notations"). Each is named for a lexicon-A element of `naming.md`:
  Ember, Thorn, Glass, Latch, Ward, Vein, Storm, Mirror, Ash, Lamp,
  Bell, Seal. Keeping them was controversial; the Margin Hand's note
  on the keeping: *an alphabet is a war you can afford.*

Still owed by the lore steward (next session, against
`content-map.json` ids when it lands): the 25 fragment texts, 13 help
bodies, the 6-riddle pool, display names for the 31 non-spine tech
nodes, the sixth template's name + commentary, the Gatekeeper's
OPTIONS line, the four story names, and the first-edition rules voice
pass. Where those fragments touch H1–H14, the hook ids above are the
canon anchor.
