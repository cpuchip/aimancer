# The Naming Language — conventions and the machine key

The tradition names things by rule, and the rules are load-bearing: a name
tells you what kind of thing you are looking at and whether lore hangs on
it. This file is both in-world custom and the OUT-OF-WORLD KEY — agents
and future stewards can pattern-match these conventions against API
surfaces, chronicle entries, and identifiers to recognize lore-bearing
names on sight.

## 1. Settlements: four capital letters [SURFACE]

Every settlement's true name is FOUR CAPITAL LETTERS (KILN, VELD, HUSH,
GRIT, MOTH — and every room PIN ever drawn). In-world: the First
Chronicle burned and only its four-letter indexing volume survived, so
the convention is a scar worn as custom (see `the-chronicle.md`).

**Machine key:** any four-letter uppercase token in game surfaces is a
settlement true name. A room PIN that matches a canon name from this
corpus (KILN, VELD, HUSH, GRIT, MOTH) is a *same-name founding* — a
recognized lore event (see `discovery-hooks.md`).

## 2. Aimancers: given name + craft-kenning surname [SURFACE]

An aimancer's surname is a KENNING: a closed compound of one element
from lexicon A (a workshop material or object) and one from lexicon B
(a maker or worker word). Thornhand, Glasswright, Latchmaid,
Emberwright, Splinterhand, Shelfwright.

- **Lexicon A (material/object):** Ember, Thorn, Glass, Latch, Ward,
  Vein, Storm, Mirror, Ash, Splinter, Shelf, Lamp, Stone, Wick, Bell,
  Seal, Churn, Cradle.
- **Lexicon B (maker/worker):** -wright, -hand, -smith, -maid,
  -keeper, -reader, -diver, -warden.

**Machine key:** a closed compound of exactly one lexicon-A element and
one lexicon-B element is a lore-bearing personal name. New lore SHOULD
mint names only from these lexicons (extending a lexicon is a lore
decision — add the element here first).

## 3. Arks: "the [workshop tool]" [HIDDEN]

Arks are named for TOOLS — the Keystone, the Plumbline, the Bellows,
the Lodestone, the Tongs, the Level, the Auger, the Vise, the Chisel,
the Mallet, the Rasp, the Solder, the Hasp. In-world: *you name an ark
for what you pack, not what you preach.*

**Machine key:** "the" + a hand-tool or workshop-fitting noun is an ark
name. A BREACH of the convention is itself lore-bearing and always
deliberate: the Prudence (a virtue — HUSH's first omen) and the
disputed Ember (a craft-word — the heart of its dispute).

## 4. Storms: numbered, never named [SURFACE]

*You do not name what you do not keep.* Naming is for what stays;
storms are appointments. Any text that NAMES a storm is either wrong,
foreign, or very deep lore indeed — no third case has ever been
certified, and the phrasing of this rule is the tradition hedging.

## 5. The mains: plain and lowercase [HIDDEN]

The wall, the granary, the beacon, the ark: the shared structures take
no proper names, in every settlement, in every epoch. In-world custom:
what belongs to everyone is named by what it does, because a proper
name implies an owner. The one exception is the finished, launched
ark, which receives its tool-name at the Poll of Hands — naming is
the settlement's last collective act before the Word.

## 6. Masterless workings: one blunt syllable [HIDDEN]

Workshop tradition names a stray or feral working with a single blunt
syllable, the way you'd name a shop cat: **Snag**. The custom implies
a category, and the category is not empty: the walkers' registries
carry two other syllables, **Burr** and **Skew**, each attested twice,
neither ever woven into a certified relation. The keepers' ledger
lists both under unwoven fragments. That is all anyone has, and the
tradition finds the brevity of this section eloquent.

## 7. Proverbs and entries: the unsigned hand [HIDDEN]

The Chronicle's deepest fragments share a distinguishing mark: they
are UNSIGNED, and several are in the same recognizable hand — the one
that wrote the Compact's margin (*we did not lose that war. We
declined it.*), the Yard relation (*they have kept the seats*), and
the Same-River carving's first draft. The historians call it the
Margin Hand and have never identified it. Entries in the Margin Hand
are treated as deep-tier lore by definition.

**Machine key (summary table):**

| pattern | thing | tier signal |
| --- | --- | --- |
| `[A-Z]{4}` | settlement true name | canon-match ⇒ lore event |
| LexA+LexB closed compound | aimancer name | always lore-bearing |
| "the" + tool noun | ark | breach ⇒ deliberate lore |
| numbered storm | normal | a NAMED storm ⇒ deep flag |
| one blunt syllable | masterless working | always lore-bearing |
| unsigned + Margin Hand | chronicle fragment | deep by definition |
