# AIMANCER

Each player runs a workshop with an AI apprentice that **drafts** automation
scripts — a hand of 2–3 cards per cycle. Only the human can **arm** them (the
hinge). A deterministic **oracle** can verify a script before arming (costs
tokens) versus YOLO-arming it free and risky; oracle-green scripts earn
auto-renew, and a red verdict auto-disarms — the oracle is the switch,
literally. Tokens are the economy: drafts cost tokens (cheap-model drafts are
cheap, smart-model drafts pricier with a better hit rate), oracle checks cost
tokens, and tokens regenerate every world tick like a rate limit. Hallucinated,
subtly-broken drafts are the comedy engine — the oracle catches them; YOLO
victims suffer publicly on the big screen.

A Jackbox-style party game: join with a 4-letter room PIN from your phone,
world ticks every ~25 seconds, the whole sim is a pure function of
`seed + command log` so every round replays exactly.

## Dev quickstart

```bash
npm ci --legacy-peer-deps
npm run smoke        # deterministic sim oracle (must be green)
npm run wstest       # over-the-wire oracle: rooms, tokens, hinge enforcement, redaction
npm run compile      # typecheck
npm run dev:server   # game server on :8080 (http + ws + /api)
npm run dev          # vite client on :5175 (proxies /ws and /api to :8080)
```

Production build: `npm run build` then `npm run serve` (serves `dist/` +
`/healthz` + `/version`). Docker: `docker compose up --build`.

## The shape

- `shared/sim/` — the pure deterministic sim: DSL, oracle, gremlin/market
  schedules, scoring. No `Date.now()`, no `Math.random()` — all randomness is a
  seeded hash of `(seed, tick, salt)`.
- `server/` — room registry (PIN join codes), authoritative sim per room,
  two-token seats: a **worker token** (AI: read/draft) and a **hinge token**
  (human: arm). `arm` is rejected server-side without the hinge token.
- `src/` — Svelte 5 client: JOIN page (your hand, oracle/arm buttons) and
  BOARD page (public world state + scoreboard).

MIT. Architecture adapted from the house siblings
([kernel-panic](https://github.com/cpuchip/kernel-panic),
[chips](https://github.com/cpuchip/chips)).
