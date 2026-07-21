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
- [x] **D4** — the BYO-AI day (★ PIVOT ruled: v1 is BYO-AI ONLY — every
      seat's apprentice is the player's OWN agent; hosted apprentice DORMANT,
      not deleted). HTTP room lifecycle (`POST /api/room` create +
      `/join` w/ reconnect-by-key + `/start` + `/phase`, host-hinge rules
      mirrored, HTTP-only rooms sweep-safe via touch()) + `GET
      /api/room/:pin/agent-prompt` (the paste-prompt, single source of truth;
      worker-token-only, never carries the hinge, never teaches arm, never
      asks an agent to bypass its own permission prompts) + phone "Connect
      your agent" panel (copy button; hinge stays on the phone) + `disarm`
      TIGHTENED to hinge-only (ws + HTTP — script-lifecycle control) +
      `cpuchip/aimancer-go` client kit (package + `aimancer-play` bot CLI;
      full fast game LIVE-PROVEN vs a local server) + `scripts/loom-bots.ps1`
      seat-filler bots — **LIVE CAPSTONE PROOF (room SLZM, local :18090):
      REAL copilot (1.0.73, THROUGH loom + the argv-shim) and REAL codex
      (0.144.6, native sandbox) each HTTP-joined a seat, curled the API
      unaided, and landed 2 drafts on the wire (log: seat 2 tick 2, seat 1
      tick 7).** Gates: smoke 196 · wstest 149.
- [x] **D5a — THE DEPTH UPDATE** (live-playtest verdict: "there isn't much
      going on once I draft"): the world MOVES now. (1) **The workshop map** —
      seeded matter veins (3 initial, spawns every ~5 ticks, ids 1..12) with
      richness `rate` + FINITE reserve; `harvest` requires `node` (vein
      binding); exhausted veins idle harvesters with a `re-target` lastRun
      (never kill); `prospect` (2⚡, either surface) previews the next vein
      into own-seat state. Board renders the map as the RTS centerpiece
      (zones, drain bars, spawn pings, shuttling workers per armed harvester,
      nest flare); phone gets the compact vein list. (2) **A living market** —
      second good CHARMS (`craft`: 2 matter + 1 widget → 1 charm; sells at its
      own drifting rate; scores 25 vs widget 10), `sell` takes optional
      `good` enum; **RUSH windows** (seeded, ×2-3 for 3 ticks) announced on
      the BOARD+phone ONLY — **the agent's HTTP /state never carries the rush
      banner/forecast, and the oracle dry-run quotes BASE prices** (CORE
      IDENTITY #2 mechanized + documented in rules + paste-prompt).
      (3) **Contracts** (round 2 only): seeded offers, HINGE-only claim (403
      for workers), auto-delivery from sells, bonus/penalty land as SCORE.
      Flaw classes +badNode/+wrongGood; presets reach craft/charms/nodes;
      wiki/rules regenerated (3 new sections incl. the asymmetry, spelled
      out); replay identity proven across the full depth set. Gates:
      smoke 385 · wstest 211.
- [ ] **D5** — presentation weave (round switcher, delta board, replay
      theater) + assets + polish.
- [ ] **D6** — family+Dave playtest → fix → dress rehearsal. **★ HOTFIX 1
      (live playtest 07-21): the silent budget-freeze is gone** — round-end is
      LOUD (COMPLETE banner + pulsing host advance + waiting line) and rooms
      **auto-advance by default** (`autoAdvance` room setting, host can
      uncheck for the talk; server issues the same logged host `phase`
      command after a visible ~8s countdown; intermission dwells 20s first;
      reveal never advances; ws+HTTP `hold` suspends it). Plus teachability:
      how-to-play overlay (5 beats), contextual nudges (arm nudge, oracle
      callout, lobby hints), board-lobby join steps + goal line, tier-bet
      subtext (rates from balance.ts), oracle-deal subtext, wall-clock
      mm:ss round countdown (board+phone, `nextTickInMs` anchored),
      **agent-liveness** (`lastWorkerSeenAt` per seat → `agentSeenAgoMs`;
      phone dyad line + board 🤖 dots; agent-prompt fetch excluded),
      **per-script `lastRun` yield** (sim-tracked, own-seat only — starved ≠
      dead; agents read it in /state) and the paste-prompt's KEEP PLAYING
      monitoring section. Gates: smoke 203 · wstest 174. **★ HOTFIX 2 (fast
      follow, same day): the WIKI + one source of truth for the rules.**
      `shared/rules.ts` generates the complete reference (dyad/scoring/economy/
      verbs+saturation/conditions/phases/oracle/gremlin/drafts/API) from
      balance.ts + mpConfig.ts — numbers can never drift; smoke asserts the
      constants landed in the text AND that the API section covers every
      server route. Three surfaces: `/wiki` (client route + SPA-fallback
      pathname, game-styled, per-section anchors), `GET /api/rules` (public
      text/plain markdown for agents; paste-prompt gained the one curl line),
      and the landing screen now TEACHES (pitch + 3 steps + goal + 📖 Full
      rules) while joining stays the primary action; board lobby + how-to-play
      link the wiki too. Gates: smoke 255 · wstest 180.

## D4 rulings + notes (for the D5 brief)

- **BYO-AI pivot is live end-to-end:** phone join → "Connect your agent" →
  paste into Claude Code/codex/copilot → the agent drafts over HTTP with the
  worker token; the phone keeps the hinge. Full HTTP lifecycle proven in
  wstest with NO websocket anywhere (create→join→draft→oracle→arm→state).
- **`start`/`phase` joined the HTTP mirror** (host-hinge only, same rules as
  ws). The brief listed only create/join, but the full-loop test requires
  reaching round 2 (oracle is round-2-only) and the loom-bots runner needs a
  ws-free way to run a room — the mirror-ws-semantics rule covers both.
- **`disarm` is now HINGE-only on BOTH surfaces** (the D3 flag, ruled in the
  D4 brief): script-lifecycle control lives with arm. The phone UI already
  used the hinge; wstest asserts the 403 on ws and HTTP.
- **HTTP-only rooms and the sweeper:** a room played entirely over HTTP has
  no sockets, so every API call `touch()`es the room (pushes the 30-min empty
  TTL); instant-delete on socket-close now applies only to never-seated
  rooms. Without this, an agent-only room would never be reaped (emptyAt
  stayed null) — or a passing watcher's disconnect would delete it mid-game.
- **Practice generator + hand-authoring are the no-agent floor** (both
  pre-D4); `draft-request` stays either-token and works for HTTP seats.
- The agent-prompt embeds the room's CURRENT tickMs at fetch time; if the
  host later starts with a different tick, the pacing hint is stale (cosmetic
  — state carries the truth). D5 could re-fetch after start if it matters.
- **BYO-agent field notes (from the live capstone, all verified on this box;
  demo-day relevance = players' agents will hit the same walls):**
  - copilot on Windows: the npm `.cmd` shim MANGLES quote-heavy prompts when
    exec'd (loom hits this) — `scripts/copilot-shim/` is the fix (pin via
    `LOOM_COPILOT_BIN`). URL permissions are a separate class from tool
    permissions, headless prompts fail closed, a user's
    `~/.copilot/settings.json` `allowedUrls` allowlist silently blocks the
    room, and `--allow-url` only matches WITH the scheme. A human PASTING the
    prompt interactively just gets asked — that flow is untouched.
  - codex on Windows: the experimental sandbox declines shell commands under
    `workspace-write` even with `network_access=true` — the working encoding
    is `-s danger-full-access` (macOS/Linux keep the researched
    workspace-write + network override).
  - loom (for its own roadmap, not ours): no passthrough for codex `-c`
    overrides or copilot `--allow-url` — the two scoped-permission encodings
    a game bot wants; plus the Windows .cmd resolution above.

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
- ⚠ **PROD APPRENTICE TIMES OUT — one env var short of live.** Michael's
  Dokploy env already wires `llama-nocix.cpuchip.net/v1` + `gemma-4-e2b`
  (key verified working), and Dokploy DOES interpolate compose `${VAR:-}`
  (an earlier note here blamed interpolation — wrong, corrected). The real
  finding, measured on the REAL path: gemma-4-e2b on the NOCIX CPU node
  serves 3 parseable drafts in **~87s**, so the 20s default times out and
  every live "Ask for drafts" refunds (gracefully — the refund flow works
  exactly as designed). **Fix = set `APPRENTICE_TIMEOUT_MS=120000` in the
  aimancer Dokploy env + redeploy** (87s ≈ 3-4 show ticks — the async flow
  absorbs it), or point at a faster endpoint. Michael's call — env is his.
  `apprenticeConfig()` now also requires a real http(s) URL (defensive
  hardening from the same investigation; a garbage URL = practice mode).
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

## ★ THE ARK PIVOT (2026-07-22 locked design → shipped)

The rounds/phases party game above is SUPERSEDED. AIMANCER is now the co-op
ark: one settlement per room, drop-in dyads, REAL Starlark scripts run by the
aimancer-go engine, THE DEPLOY GATE (district=branch, shared=protected main),
seeded escalating storms, milestones Wall→Granary→Beacon→ARK, and the
collective GO/NO-GO launch vote. See README.md + /wiki for the game.

### Design calls of record

- **Replay/engine choice: engine-emitted actions enter the log AS DATA**
  (`scriptTick` commands), exactly like LLM drafts did pre-pivot. Replays
  re-apply actions and never re-run the engine. Why: (1) the probe's ruling —
  engine subprocess faults (timeout/respawn) are SEAT faults, not replay
  state, and a replay that re-ran the engine would have to reproduce
  non-deterministic wall-clock faults; (2) engine upgrades can't invalidate
  old replays (the /log header pins the engine identity that emitted the
  actions); (3) the sim stays pure TS. Cost: fatter logs — bounded by
  ACTIONS_PER_TICK_MAX.
- Per-script KV memory lives server-side only (Room.memories), round-tripped
  to the engine; it is NOT replay state (actions are). A server restart
  resets script memory — accepted for v1.
- The deploy gate is enforced twice: HTTP 409 (server dry-runs before
  logging) AND in the sim (`deploy scope=shared` without `verified` is
  unrepresentable; runtime `contribute`/`store` from ungated scripts drop
  with a public gateRefused event).
- `verified` follows the LATEST oracle verdict — a red re-check closes the
  shared gate again (the oracle is the switch, continued).
- v1 storms only batter the WALL's HP; other structures carry hp/hpMax for
  the record. Districts have integrity instead.
- Pacing valve = the VEIN SUPPLY SCHEDULE (250 parts = 1500 ore ≈ ore
  surfaced by ~tick 240). Smoke's scripted 3-dyad speed-run launches ~tick
  239 with 4 storms — the 30-45 min meeting band at the 5s tick; tickMs=1000
  makes the 10-minute room.

### BREAKING HTTP API changes (pre-audience, deliberate)

GONE: `start`/`phase`/`hold` (continuous play), `draft`/`draft-request`
(write real scripts), `arm`/`disarm` (deploy/undeploy), `scrap`, `prospect`,
`claim-contract`, the rich/narrow `/state` split (co-op has no fog).
NEW: `deploy` (scope district|shared; shared runs the gate, 409 + report),
`undeploy`, `oracle` (engine dry-run), `vote` (HINGE only), `launch` (host
hinge), `GET /api/templates`. `/state` view is the new RoomView shape;
`/log` gained the replay header (seed/tickMs/engine identity) and redacts
other seats' deploy source until launch. aimancer-go client + reference bot
updated to match.

### Retired deliberately with the phase machine

`shared/sim/flaws.ts`, `shared/apprentice.ts`, `server/apprentice.ts` (the
hosted-drafts escrow), `scripts/copilot-shim`, `scripts/loom-bots.ps1`, the
old smoke/wstest suites (their still-true floors — replay identity, token
economy, vein mechanics, redaction, feed dedup — carried into the new
suites). Git history keeps them; the D1-D6 notes above are historical.

### Next (the polish day)

- Storm/milestone/launch SFX + art pass (asset-harness).
- Family playtest → balance pass on storm severity + vein cadence.
- Board: wall-absorb animation beat + survivor arrivals visual.
- loom-bots equivalent for the ark (drive 2-3 real agent seats).
