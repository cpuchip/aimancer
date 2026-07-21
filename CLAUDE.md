# AIMANCER — Claude Code project context

A Jackbox-style multiplayer party game about arming (or YOLO-arming) the
automation scripts your AI apprentice drafts. Own repo
(`github.com/cpuchip/aimancer`), nested in the workspace at
`projects/aimancer/`. Sibling of kernel-panic, chips, first-orbit, deadweight;
same house harness and discipline. Michael owns intent/vision; the agent owns
the code within it. Design doc (binding):
`private-workspace/.spec/proposals/aimancer-design.md` in the parent workspace.

## The shape of the thing

- **`shared/sim/`** — the crown jewel: pure deterministic sim,
  `sim = f(seed + command log)`. Integer math only; ALL randomness from
  `hashNoise(seed, tick, salt)` (stateless seeded hash — command timing can
  never desync it). `balance.ts` holds every tuning constant. `oracle.ts` is
  the deterministic verifier (static checks + 3-tick dry-run). `flaws.ts`
  makes the subtly-broken hallucinated variants. `smoke.ts` is the oracle.
- **`server/`** — room registry (4-letter PIN, chips alphabet), one
  authoritative sim per room, tick length is a room setting (~25s show, 2s
  dev). **Two-token seats:** every seat gets a `workerToken` (draft/read) and
  a `hingeToken` (arm). `arm` REQUIRES the hinge token — enforced server-side,
  proven by `wstest.ts`. Hands and tokens are redacted from every other seat.
- **`src/`** — Svelte 5 placeholder client: JOIN page + BOARD page.

## The discipline (inherited from the siblings)

1. **Build the oracle first.** New sim capability gets a `smoke.ts` assertion
   before/with the feature.
2. **Inverse hypothesis.** Tests that MUST fail: every flaw class must be
   caught; a worker-token arm must be rejected; a YOLO'd flawed script must
   die publicly.
3. **Replay identity IS the oracle.** Same seed + command log → identical
   state hash.
4. **Redaction is a security oracle.** wstest asserts other players' hands and
   ALL tokens never cross the wire to the wrong seat.
5. **`/version` is the deploy oracle** (git short sha).

## Gates (before every commit)

```bash
npm run smoke && npm run wstest && npm run compile && npm run build
```

Green all four, then commit. Before any push:
`wall-check --tracked` from the parent workspace must print `WALL: clean`.

## Conventions

- `.npmrc` sets `legacy-peer-deps=true`; `npm ci --legacy-peer-deps`.
- `shared/` stays pure: no `Date.now()`, no `Math.random()`, no I/O.
- The human arm surface must NEVER be assumed to be the same device as the
  agent (the phone-only player bridge — design doc).
- Keep `ROADMAP.md` current.
