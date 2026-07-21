# AIMANCER roadmap — premiere Monday 2026-07-27, 1:00 PM Central

The build week (from the design doc, D1 = 2026-07-21):

- [x] **D1** — repo scaffold + pure sim (DSL, oracle, flaws, gremlin/market,
      scoring) + room server skeleton (PIN rooms, two-token seats, hinge-only
      arm, HTTP API) + placeholder JOIN/BOARD frontend. All oracles green.
- [x] **D2** — the 40-min weave IN THE SIM (round1 naive → intermission →
      round2 verified → reveal; host+hinge `phase` commands in the log; round
      budgets 12/19; round-2 same-seed re-seed — schedule-hash-proven), score
      counts widgets SOLD (ratified), `scrap`, eventSeq feed dedup, real
      phone CARDS UI + projected board (banner/countdown/flip scoreboard/
      disaster theater/summary/delta), `GET /api/room/:pin/log` (redacted).
      Deployed: aimancer.cpuchip.net. Gates: smoke 149 · wstest 84.
- [ ] **D3** — apprentice seats via loom + draft→hand→arm loop (flawScript
      powers the hosted apprentice's hallucinations).
- [ ] **D4** — BYO surface: REST/MCP for outside agents + big screen.
- [ ] **D5** — presentation weave (round switcher, delta board, replay
      theater) + assets + polish.
- [ ] **D6** — family+Dave playtest → fix → dress rehearsal.

## D2 rulings + deliberate deferrals (for the D3 brief)

- **Ratified (reviewer): score = widgets SOLD** (shipping IS selling; the
  market is load-bearing). `oracleCheck` stays either-token; `arm` stays
  hinge-only; gremlin corruption unchanged.
- **Interpretation flagged for Michael:** the spec said round 2 keeps
  "NOTHING but names" AND that intermission drafting "stocks your hand" —
  implemented as: names + *un-played drafts* (status `drafted`) carry into
  round 2; armed/dead/blown/disarmed do not, resources reset. Otherwise
  intermission drafting would be a pointless trap. Easy to tighten to
  names-only if ruled.
- `scrap` is FREE (tuning call: the dead script already cost its waste;
  charging for hygiene felt bad). `SCRAP_COST` in balance.ts if we change.
- Practice apprentice hallucination rates: cheap 45% / smart 15%
  (`PRACTICE_FLAW_*` in balance.ts) — D3's hosted apprentice replaces the
  stub in `Join.svelte#askApprentice` (worker-token draft is the same wire
  call the loom seat will make).
- HTTP surface still draft/arm/state/log only — `scrap`/`disarm`/`oracle`
  are ws-only; D4 (BYO REST) should mirror them + document the join flow.
- Log endpoint redacts other seats' draft `params` AND `when` (the condition
  carries hand-secrets — wstest's marker lives there). Host token unlocks
  the full log in `reveal` only. Replay consumers: entries are ordered;
  `atTick` restarts at 0 after the round-2 `phase` command (segment by the
  phase entries).
- Dry-run still predicts the candidate script in isolation (world schedules
  move, other scripts hold still).
