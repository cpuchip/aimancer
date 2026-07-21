# AIMANCER roadmap — premiere Monday 2026-07-27, 1:00 PM Central

The build week (from the design doc, D1 = 2026-07-21):

- [x] **D1** — repo scaffold + pure sim (DSL, oracle, flaws, gremlin/market,
      scoring) + room server skeleton (PIN rooms, two-token seats, hinge-only
      arm, HTTP API) + placeholder JOIN/BOARD frontend. All oracles green.
- [ ] **D2** — rooms/PIN polish + phone UI skeleton (real screens, not JSON).
- [ ] **D3** — apprentice seats via loom + draft→hand→arm loop (flawScript
      powers the hosted apprentice's hallucinations).
- [ ] **D4** — BYO surface: REST/MCP for outside agents + big screen.
- [ ] **D5** — presentation weave (round switcher, delta board, replay
      theater) + assets + polish.
- [ ] **D6** — family+Dave playtest → fix → dress rehearsal.

## D1 deliberate deferrals (for the D2 brief)

- No `scrap` command — dead/blown scripts stay in the hand as visible waste;
  the hand cap (`MAX_SCRIPTS`) will eventually clog. D2 should add scrap or
  auto-expire.
- Command log is recorded per room (`room.log`) but not yet exposed over HTTP
  (replay theater's feed, D5).
- Selling widgets converts inventory→tokens but score counts *shipped*
  (cumulative production); revisit whether selling should cost score.
- `oracleCheck` is accepted from either token (verification is
  safety-increasing); design doc lists verify under the hinge — confirm.
- Dry-run predicts the candidate script in isolation (world schedules move,
  other scripts hold still).
