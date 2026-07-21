# AIMANCER — the ark

A co-op base-building game about AI automation, played by **dyads** — a human
plus their AI agent. One shared settlement per room; **drop in anytime** (no
rounds, no phases, no late penalty). Your agent writes **REAL Starlark
scripts** that run every world tick in a sandboxed, deterministic, gas-metered
Go engine ([cpuchip/aimancer-go](https://github.com/cpuchip/aimancer-go)):
gather ore from finite veins, farm food, craft parts, build.

**THE DEPLOY GATE** is the whole point. Your district is your branch — deploy
anything, YOLO allowed, your rubble. The shared structures are protected main:
a script that contributes to them must pass **the oracle** (a real engine
dry-run + static checks) and deploy with scope `shared`. Storms come on a
visible countdown, escalating; the wall absorbs for everyone; **unverified
running scripts are each district's attack surface**. Milestones unlock
collectively — Wall → Granary → Beacon (survivors arrive when fed + protected
= more script capacity for all) → **THE ARK** — and the game ends with a
collective **GO/NO-GO launch vote**: every human votes from their phone (the
hinge token; no agent can cast it, by construction), then the host confirms.
The end screen tells the story: contributions, storms weathered, whose
districts stood — and every script's source goes public.

Tokens ⚡ stay the economy: script runs, deploys, and oracle checks cost them;
they regenerate every tick like a rate limit. The whole sim is a pure function
of `seed + command log` — a deployed script's engine-emitted actions enter the
log **as data**, so every settlement replays exactly (engine faults are seat
faults, never replay state).

LIVE: [aimancer.cpuchip.net](https://aimancer.cpuchip.net) · rules: `/wiki` or
`curl -s https://aimancer.cpuchip.net/api/rules`

## Dev quickstart

```bash
npm ci --legacy-peer-deps
npm run smoke        # deterministic sim oracle (must be green)
npm run enginetest   # REAL engine subprocess: templates, KV, gas, timeout/respawn
npm run wstest       # over-the-wire oracle: gate, vote split, drop-in, redaction, replay
npm run compile      # typecheck
npm run dev:server   # game server on :8080 (http + ws + /api)
npm run dev          # vite client on :5175 (proxies /ws and /api to :8080)
```

**The engine binary:** the server spawns ONE `aimancer-engine` subprocess
(NDJSON over stdio). Resolution order: `$AIMANCER_ENGINE_BIN` → repo-root
`./aimancer-engine(.exe)` → auto-`go build` from the sibling
`../aimancer-go` checkout (needs Go once; cached in `node_modules/.cache`).
`$AIMANCER_GO_DIR` overrides the sibling path. The Docker image builds the
engine in a golang stage pinned by `ENGINE_REF` and sets
`AIMANCER_ENGINE_BIN` — see the Dockerfile. Every room's `/log` replay header
pins the engine identity. A wall-clock timeout (`ENGINE_TIMEOUT_MS`, default
2000) kills and respawns a wedged engine — the affected seat just skips that
tick; the container `mem_limit` (docker-compose.yml) is the hard wall behind
the engine's own allocation watchdog.

Production build: `npm run build` then `npm run serve`. Docker:
`docker compose up --build`. Deploy: push to main → Dokploy builds →
`aimancer.cpuchip.net`; verify `/version` = HEAD sha, then
`npx tsx server/liveproof.ts` (creates a probe room on the LIVE site, deploys
a template through the real engine, watches it mine).

## Play from your phone

Open the site → found a settlement (or enter the PIN) → your district view:
deploy a starter template (the agentless floor — 5 working scripts to tap and
tweak), watch its per-tick yield, hit the oracle button, contribute through
the gate. Big screen: `/#/board/PIN`. Connect your agent with one copy-paste
(the prompt embeds the WORKER token only — the vote never leaves your phone).

## BYO agent (plain HTTP)

```bash
curl -s -X POST https://aimancer.cpuchip.net/api/room -H 'content-type: application/json' -d '{"name":"me"}'
# → pin + workerToken (agent surface) + hingeToken (KEEP — the vote)
curl -s -X POST .../api/room/PIN/deploy -H "Authorization: Bearer w_…" \
  -d '{"id":"m1","scope":"district","source":"act(\"farm\", rate=3)"}'
```

Full surface: `GET /api/rules` · `GET /api/templates` · `POST join` ·
`GET state` · `GET log` · `POST deploy|undeploy|oracle` · `POST vote`
(hinge) · `POST launch` (host hinge). Go client kit + reference bot:
[cpuchip/aimancer-go](https://github.com/cpuchip/aimancer-go).

## The shape of the repo

- `shared/sim/` — the crown jewel: pure deterministic ark sim
  (`sim = f(seed + command log)`); `balance.ts` holds every knob; `oracle.ts`
  is the pure half of the verifier; `smoke.ts` is its floor.
- `shared/templates.ts` — the agentless floor (engine-tested Starlark).
- `server/` — rooms + the HTTP/ws surface; `engine.ts` hosts the Go engine
  subprocess; `enginetest.ts` + `wstest.ts` are the integration floors.
- `src/` — Svelte 5: phone district view (Join), the living settlement board
  (Board), the wiki.

MIT. Built on the house pattern (kernel-panic rooms, chips redaction oracle,
first-orbit deploy discipline).
