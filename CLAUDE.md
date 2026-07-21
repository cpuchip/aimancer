# AIMANCER — Claude Code project context

A co-op ark-building game: dyads (human + their AI agent) script one shared
settlement with REAL Starlark (run by the aimancer-go engine), gated by a
deterministic oracle, against seeded escalating storms, ending in a
collective launch vote. Own repo
(`github.com/cpuchip/aimancer`), nested in the workspace at
`projects/aimancer/`. Sibling of kernel-panic, chips, first-orbit, deadweight;
same house harness and discipline. Michael owns intent/vision; the agent owns
the code within it. Design doc (binding):
`private-workspace/.spec/proposals/aimancer-design.md` in the parent workspace.

## The shape of the thing

- **`shared/sim/`** — the crown jewel: pure deterministic ARK sim,
  `sim = f(seed + command log)`. Integer math only; ALL randomness from
  `hashNoise(seed, tick, salt)`. The ENGINE NEVER RUNS IN THE SIM: deployed
  scripts' engine-emitted actions enter the log as DATA (`scriptTick`);
  engine faults = seat faults, never replay state. `balance.ts` holds every
  knob. `oracle.ts` is the pure half of the verifier (the engine dry-run
  happens in `server/engine.ts`). `smoke.ts` is the sim oracle.
- **`server/`** — room registry (4-letter PIN, chips alphabet), one
  authoritative sim per room, CONTINUOUS from creation (drop-in joins are
  logged commands). `engine.ts` hosts ONE Go engine subprocess (NDJSON,
  wall-clock timeout + respawn). **Two-token seats:** `workerToken`
  (agent: deploy/oracle/read) and `hingeToken` (human: the LAUNCH VOTE;
  host confirm). **THE DEPLOY GATE:** scope=shared deploys REQUIRE an
  oracle-green engine dry-run — 409 + sim backstop, proven by `wstest.ts`.
  Script SOURCE is redacted from every other seat until launch.
- **`src/`** — Svelte 5: phone district view (Join), living settlement
  board (Board), wiki. `shared/templates.ts` = the agentless floor.

## The discipline (inherited from the siblings)

1. **Build the oracle first.** New sim capability gets a `smoke.ts` assertion
   before/with the feature.
2. **Inverse hypothesis.** Tests that MUST fail: a worker-token VOTE must be
   rejected; an unverified shared deploy must 409; an ungated contribute must
   drop publicly; a red re-check must close the gate again.
3. **Replay identity IS the oracle.** Same seed + command log → identical
   state hash.
4. **Redaction is a security oracle.** wstest asserts other players' hands and
   ALL tokens never cross the wire to the wrong seat.
5. **`/version` is the deploy oracle** (git short sha).

## Gates (before every commit)

```bash
npm run smoke && npm run enginetest && npm run wstest && npm run compile && npm run build
```

(`enginetest`/`wstest` build the REAL engine from the sibling
`../aimancer-go` checkout — Go required once; Docker pins `ENGINE_REF`.)

Green all four, then commit. Before any push:
`wall-check --tracked` from the parent workspace must print `WALL: clean`.

## Conventions

- `.npmrc` sets `legacy-peer-deps=true`; `npm ci --legacy-peer-deps`.
- `shared/` stays pure: no `Date.now()`, no `Math.random()`, no I/O.
- The human arm surface must NEVER be assumed to be the same device as the
  agent (the phone-only player bridge — design doc).
- Keep `ROADMAP.md` current.
