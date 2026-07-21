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

## The apprentice (pluggable LLM)

Each seat's apprentice is a real model behind any **OpenAI-compatible chat
endpoint** — configured by env (see `.env.example`; never commit values):
`APPRENTICE_BASE_URL`, `APPRENTICE_MODEL_CHEAP`, `APPRENTICE_MODEL_SMART`,
`APPRENTICE_API_KEY` (optional), `APPRENTICE_TIMEOUT_MS` (default 20s).
With `APPRENTICE_BASE_URL` unset the server runs **practice mode**: a seeded
offline generator answers draft requests — no LLM anywhere, same economy,
same flaw rates, fully playable (the UI labels it).

The flow is **async**: a draft request debits tokens IMMEDIATELY (cheap 3 /
smart 8), the model runs in the background, and the drafts land in your hand
when ready — the ~25s world tick absorbs the latency. A timeout refunds
through the log. **Hybrid hallucination:** real drafts get seeded flaw
injection at the tier rate (cheap 45% / smart 15%, `balance.ts`) from the
room's noise stream — deterministic per room+tick+seat. A model that returns
actual gibberish serves a flawed preset instead (an *organic* hallucination,
logged honestly). LLM output enters the command log **as data** — replays
never re-call a model.

## HTTP API (the BYO-agent surface)

**v1 is BYO-AI:** every seat's apprentice is the player's OWN agent (Claude
Code / codex / copilot — anything that can curl). The human joins on their
phone, taps **Connect your agent**, and pastes the generated prompt into their
agent; the agent plays the worker surface over this API while the ARM buttons
stay on the phone. Agents without a human can create/join rooms directly.

Auth: an `Authorization` header carrying `Bearer <token>` (or `?token=` in the
query string). Every seat holds TWO tokens (from the ws `welcome` or the HTTP
create/join response): a **worker token** (the AI surface) and a **hinge
token** (the human surface). ARM REQUIRES THE HINGE — there is no AI-reachable
arm path, by design.

| Route | Method | Token | Does |
|---|---|---|---|
| `/api/rules` | GET | — | the complete rules + this API as markdown — generated from `shared/rules.ts` (the `/wiki` page renders the same source). Public by design |
| `/api/room` | POST | — | create a room; creator = host, seat 0. Optional `{name, tickMs, round1Ticks, round2Ticks}` presets (dev-fast from curl). Returns `{pin, seat, name, key, workerToken, hingeToken}` |
| `/api/room/:pin/join` | POST | — | join by PIN: `{name?, key?}`. The same `key` reconnects to the SAME seat + tokens; omit it and one is minted and returned |
| `/api/room/:pin/agent-prompt` | GET | **worker** | the ready-to-paste "connect your agent" text (single source of truth); never carries the hinge token |
| `/api/room/:pin/start` | POST | host **hinge** | `{tickMs?, round1Ticks?, round2Ticks?}` — start the game |
| `/api/room/:pin/phase` | POST | host **hinge** | `{to}` — advance the weave (round1→intermission→round2→reveal) |
| `/api/room/:pin/state` | GET | any/none | redacted room view (a seat token adds `you.hand` + `you.pending`) |
| `/api/room/:pin/log` | GET | any/none | command log + seed (other seats' draft bodies stripped; host unlocks all in reveal) |
| `/api/room/:pin/draft` | POST | worker | `{script, tier?}` — submit a script you wrote (costs tier price) |
| `/api/room/:pin/draft-request` | POST | either | `{tier, order?}` — ask the practice generator (or a wired model); debits now, drafts arrive async (poll state) |
| `/api/room/:pin/oracle` | POST | either | `{id}` — paid verify; returns the verdict + 3-tick dry-run report (round 2 only) |
| `/api/room/:pin/arm` | POST | **hinge** | `{id}` — the human act; worker tokens get 403 |
| `/api/room/:pin/disarm` | POST | **hinge** | `{id}` — script-lifecycle control lives with arm (tightened D4) |
| `/api/room/:pin/scrap` | POST | either | `{id}` — free an (unarmed) hand slot |

Errors are always `{ ok: false, error }`: **401** no/unknown token · **403**
wrong surface (e.g. worker tries to arm) · **404** no such room · **405**
wrong method · **409** the sim refused, with the spoken reason (round-1
oracle, not enough tokens, armed scrap…) · **400** malformed body.

The Go client kit + reference bot lives at
[cpuchip/aimancer-go](https://github.com/cpuchip/aimancer-go) —
`aimancer-play -url <server> -pin <PIN> -name Bot` puts an autonomous seat in
any room. The paste-prompt never asks an agent to bypass its own permission
prompts: one approval click per curl is the design.

## The shape

- `shared/sim/` — the pure deterministic sim: DSL, oracle, gremlin/market
  schedules, scoring. No `Date.now()`, no `Math.random()` — all randomness is a
  seeded hash of `(seed, tick, salt)`.
- `shared/apprentice.ts` — the apprentice's pure half: prompt, defensive
  JSON parsing (fences tolerated), seeded flaw injection, practice generator.
- `server/` — room registry (PIN join codes), authoritative sim per room,
  two-token seats: a **worker token** (AI: read/draft) and a **hinge token**
  (human: arm). `arm` is rejected server-side without the hinge token.
  `server/apprentice.ts` is the LLM I/O (env config + the chat call).
- `src/` — Svelte 5 client: JOIN page (your hand, oracle/arm buttons),
  BOARD page (public world state + scoreboard), and the WIKI (`/wiki`).
- `shared/rules.ts` — ONE source of truth for the rules: the complete game
  reference generated from the live constants (never hardcoded numbers).
  Serves three consumers: `/wiki` (humans), `GET /api/rules` (agents), and
  `smoke.ts` (asserts the constants really made it into the text).

MIT. Architecture adapted from the house siblings
([kernel-panic](https://github.com/cpuchip/kernel-panic),
[chips](https://github.com/cpuchip/chips)).
