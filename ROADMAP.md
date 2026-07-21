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
- [x] **D3** — the REAL apprentice: `server/apprentice.ts` (any OpenAI-compat
      endpoint via APPRENTICE_* env; practice mode when unset) + async draft
      flow in the sim (`draftRequested` debit-now → `draftAccepted` 0-cost
      data → `draftSettled`/`draftFailed` refund; escrow survives the round-2
      reseed) + HYBRID hallucination (seeded flaw injection at tier rates,
      deterministic per room+tick+seat; organic fallback on gibberish) + the
      FULL HTTP action mirror (`oracle`/`disarm`/`scrap`/`draft-request`,
      409-with-spoken-reason) + phone pending slots + board refund line.
      LIVE-PROVEN vs llama-chip (Qwen3-4B-Instruct-2507-Q8_0, ~0.9-1.1s per
      2-3-draft batch): order → drafts → oracle caught 4 injected flaws →
      verified chain SHIPPED (`npm run liveproof` = the rehearsal driver).
      Gates: smoke 196 · wstest 113.
- [ ] **D4** — BYO surface: REST/MCP for outside agents + big screen.
- [ ] **D5** — presentation weave (round switcher, delta board, replay
      theater) + assets + polish.
- [ ] **D6** — family+Dave playtest → fix → dress rehearsal.

## D3 rulings + notes (for the D4 brief)

- **Escrow shape (steward's interpretation):** the brief named three commands
  (`draftRequested`/`draftAccepted`+reqId/`draftFailed`); a fourth tiny one,
  `draftSettled`, closes a DELIVERED request (drafts arrive one command each,
  so something must clear the escrow exactly once). All four are logged;
  replay identity proven across the round-2 reseed (escrow carries — a
  request paid in round 1 delivers into the round-2 hand).
- **HTTP `disarm` is either-token** (the brief's parenthetical said hinge; ws
  has been either-token since D2 — "turning OFF is always safe" — and the
  mirror matches ws by the brief's own headline rule). Easy to tighten.
- **Order text never enters the log** — it goes to the model only. A player's
  strategy whisper isn't replay data and never crosses to other seats.
- The `draftRequested` command refuses on a FULL hand up front (no doomed
  escrow); if the hand fills while a request is in flight, undeliverable
  drafts are skipped and a fully-empty delivery refunds (`draftFailed`).
- Client-side practice generator is GONE; practice mode now lives server-side
  behind the same async flow (same economy, same seeded flaw rates), so BYO
  agents and the phone behave identically with no model wired. The live
  deploy runs practice mode until APPRENTICE_* env is set (Dokploy).
- **For D4:** README's HTTP API table is current and wstest-proven — build
  the join prompt on it. Room create/join is still ws-only; the join flow
  needs either a `POST /api/room` + `POST /api/room/:pin/join` pair or a
  paste-prompt that opens a ws once. `draft-request` + polling `state` is
  enough for a curl-only agent to play (proven in wstest).

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
