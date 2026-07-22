// AIMANCER balance — every tuning constant in one place, rebuilt for the ARK
// pivot's CO-OP pacing. Integer math only; probabilities are x-in-65536 rolls
// against hashNoise.
//
// PACING FRAME: the meeting arc is ~30-45 min at the default 5s tick
// (≈ 360-540 ticks); a 10-minute fast room just runs tickMs=1000 — every knob
// below is in TICKS, so the arc compresses cleanly. The milestone chain needs
// 250 parts = 1500 ore, and the VEIN SUPPLY SCHEDULE is the true pacing
// valve: ore surfaces at ~5/tick room-wide (initial field ~290 ore + ~95 per
// spawned vein), so the ark lands ~tick 220-300 however hard a room
// optimizes — smoke's scripted speed-run pins it (currently ~239).

// ── Tokens (⚡ — the per-dyad compute budget; the real economy) ──────────────
export const TOKEN_START = 20 // opening balance per dyad
export const TOKEN_REGEN = 5 // +N per tick, like a rate limit refilling
export const TOKEN_CAP = 50 // regen caps here
export const SCRIPT_RUN_COST = 1 // one deployed script executing one tick
export const DEPLOY_COST = 2 // landing a script (district or shared)
export const ORACLE_COST = 4 // one oracle verification (engine dry-run + checks)

// ── Scripts (real Starlark — deployments, slots, source bounds) ─────────────
export const SCRIPT_SLOTS_BASE = 3 // deployed scripts per dyad at settlement start
export const SCRIPT_SLOTS_MAX = 8 // hard ceiling (survivors raise toward it)
export const SURVIVORS_PER_SLOT = 2 // every N survivors = +1 slot for EVERY dyad
export const SOURCE_MAX_BYTES = 16 * 1024 // a seat script is a script, not a repo
export const SCRIPT_GAS_LIMIT = 50_000 // engine VM steps per script per tick
export const ORACLE_GAS_LIMIT = 50_000 // dry-run runs on the same budget
export const ACTIONS_PER_TICK_MAX = 16 // sim applies at most N actions per script per tick

// ── The map: ore veins (finite, seeded, they surface and run dry) ───────────
export const VEINS_INITIAL = 3 // veins live at tick 0
export const VEIN_SPAWN_TICKS = 18 // a new vein surfaces every ~N ticks…
export const VEIN_SPAWN_JITTER = 7 // …+0..(J-1) seeded jitter
export const VEIN_ID_MAX = 30 // hard cap on vein ids over the whole arc
export const VEIN_RATE_MIN = 2 // richness: flow cap per gatherer per tick
export const VEIN_RATE_MAX = 5
export const VEIN_RESERVE_FACTOR_MIN = 20 // reserve = rate × factor (seeded) —
export const VEIN_RESERVE_FACTOR_MAX = 35 // a vein feeds minutes, not the game

// ── Action rates (per script per tick — the act() verb bounds) ──────────────
export const GATHER_RATE_MAX = 5 // ore attempted per tick (vein rate also caps)
export const FARM_RATE_MAX = 3 // food per tick (fields are slow but infinite)
export const CRAFT_RATE_MAX = 2 // parts attempted per tick
export const ORE_PER_PART = 6 // ore consumed per part
export const CONTRIBUTE_RATE_MAX = 5 // parts moved to a shared structure per tick
export const STORE_RATE_MAX = 5 // food moved into the granary per tick

// ── Shared structures + milestones (Wall → Granary → Beacon → ARK) ──────────
export const WALL_PARTS_REQUIRED = 60
export const GRANARY_PARTS_REQUIRED = 30
export const BEACON_PARTS_REQUIRED = 40
export const ARK_PARTS_REQUIRED = 120
export const WALL_HP_PER_PART = 5 // each part into the wall adds HP too
export const WALL_HP_MAX = 300 // over-contribution keeps repairing up to here
export const STRUCTURE_HP_PER_PART = 5 // hpMax bookkeeping for the others (v1: storms only batter the wall)

// ── Storms (seeded schedule, escalating, visible countdown) ─────────────────
export const STORM_FIRST_TICK = 45 // ~4 min of building before the first hit
export const STORM_PERIOD = 55 // one storm every ~4.5 min at the 5s tick
export const STORM_JITTER = 8 // +0..(J-1) seeded ticks per storm
export const STORM_SEVERITY_BASE = 20
export const STORM_SEVERITY_RAMP = 12 // +N per storm index — escalation
export const STORM_SEVERITY_MAX = 120
export const STORM_WARN_TICKS = 10 // the feed calls it this many ticks out
/** Extra damage per UNVERIFIED running script — un-verified work is the
 * storm's attack surface (the deploy gate's teeth). */
export const STORM_UNVERIFIED_EXTRA = 4
/** District damage at/above this kills one unverified script (seeded pick). */
export const SCRIPT_KILL_THRESHOLD = 12
export const DISTRICT_INTEGRITY_MAX = 100

// ── Survivors (beacon milestone — fed + protected people arrive) ────────────
export const SURVIVOR_PERIOD = 20 // one may arrive every N ticks…
export const SURVIVOR_FOOD_COST = 12 // …if the granary can feed them
export const SURVIVORS_MAX = 10

// ── The Mirror Yard (beta env — fork the world, rehearse a script) ──────────
export const BETA_RUN_COST = 3 // one beta run (any tick count — the fork is the product)
export const BETA_TICKS_MIN = 1
export const BETA_TICKS_MAX = 10

// ── The Chronicle (shared lore-memory — claims cost, discoveries are free) ──
export const CHRONICLE_COST = 2 // posting a claim (anti-spam; discoveries free)
export const CHRONICLE_TEXT_MAX = 500 // characters per entry
export const CHRONICLE_EVIDENCE_MAX = 6 // evidence refs per entry
export const CHRONICLE_EVIDENCE_LEN_MAX = 160 // characters per evidence ref
export const CHRONICLE_RELATES_MAX = 6 // relates-to links per entry
export const CHRONICLE_MAX_ENTRIES = 300 // the book is finite — write what matters

// ── The launch (the climax — collective GO/NO-GO) ───────────────────────────
/** GO votes must exceed half of ALL seated dyads (abstain ≠ GO), then the
 * HOST confirms with the launch command. Majority + host confirm, by design. */
export const LAUNCH_MAJORITY_OF_ALL = true

// ── Room / world caps ───────────────────────────────────────────────────────
export const MAX_DYADS = 8
