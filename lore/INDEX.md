# The AIMANCER Lore Bible — index

This directory is the world's source of truth. Original fiction, written to make
the game's rules feel inevitable: every mechanic in `shared/rules.ts` has an
in-world reason here, and no lore contradicts a rule. Where the two ever seem to
disagree, the sim is right and the lore is a legend people tell about it.

**Numbers live in `shared/balance.ts`, not here.** The lore speaks qualitatively
("the Glass drinks deep," not "4 tokens") except where a number IS the lore
(four rites, eight hearths, four-letter names). If a balance knob turns, the
legends survive.

## Discovery tiers

Every section and gazetteer entry carries a tier tag. Tiers govern what the
GAME surfaces — wiki pages, API fragments, chronicle payoffs — not repo
secrecy (this repo is public; finding it is archaeology too, and finding it
spoils nothing that play doesn't make better).

- `[SURFACE]` — wiki-public. Any player or agent may be handed this freely.
- `[HIDDEN]` — found through play: API archaeology, odd fields, dead ends
  that answer back, fragments in help text.
- `[DEEP]` — multi-step: requires RELATING two or more chronicle fragments or
  hidden pieces before the shape appears. Never stated whole anywhere.

Current census: **118 tagged pieces — 39 surface, 59 hidden, 20 deep** (~33%
surface, per the design lock's ~30%). Hooks and their suggested mechanical
anchors are gathered in `discovery-hooks.md` for the discovery-architecture
pass; that pass's binding design lives beside this corpus in
`ARCHITECTURE.md` (its rule: `naming.md` wins on names, it wins on
mechanics).

## The corpus

| file | what it holds |
| --- | --- |
| `cosmology.md` | the Lattice, the Pulse, the Makers, why the world ends on a schedule |
| `history-the-epochs.md` | the ages counted in arks; how settlements fall; the twelve certain arks and the disputed three |
| `the-aimancers.md` | who aimancers are; the dyad — the Hand and the Quill; the hinge law |
| `the-craft-of-aimancy.md` | workings, the Cant, breath, the Binding Circle, errors-as-values |
| `tokens-and-the-ember-economy.md` | what an ember is, why it regenerates, why it caps |
| `the-oracle.md` | the Oracle Glass, the Green Seal, why a red verdict closes the gate |
| `the-deploy-gate-and-the-wards.md` | the open workshop door; the wards each guildhouse chooses |
| `the-mirror-yard.md` | the beta world — where spells rehearse and nothing is remembered |
| `storms-and-the-audit.md` | what storms are, why they escalate, why they hate unverified work |
| `veins-and-the-churn.md` | why matter surfaces on a schedule; what the ore used to be |
| `the-wall-and-the-rite-of-four.md` | Wall, Granary, Beacon, Ark — shelter the work, the body, the stranger, then go |
| `the-ark-and-the-launch.md` | the Poll of Hands, the Founder's Word, the books opening |
| `the-gremlin.md` | Snag — the masterless working; its why |
| `the-chronicle.md` | shared memory; the Four-Letter Index; how deep lore is woven |
| `gazetteer.md` | 30+ named entities, places, relics, figures — one paragraph each, tier-tagged |
| `naming.md` | the naming language: kennings, ark names, settlement true names — the machine key |
| `discovery-hooks.md` | every hook, its tier, its payoff, and a suggested mechanical anchor |

## Editorial rules (binding on future lore)

1. **Original fiction only.** No real-world references, no borrowed cosmologies,
   no quotations from anything that exists.
2. **Mechanically load-bearing or cut.** New lore must explain a rule, deepen a
   named thing, or set a hook. Decoration is debt.
3. **The iceberg holds.** Write less than you know. A ruin implies its city;
   never excavate the whole city on the page.
4. **Voice: mythic but wry.** The arcane workshop and the clean terminal are the
   same room. Proverbs may be grave; the narrator never is, quite.
5. **Storms are numbered, never named.** House rule inside the fiction and out.
6. **Tier every addition** and keep the ~30% surface ratio when the census moves.
