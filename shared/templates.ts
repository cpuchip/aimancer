// The TEMPLATE LIBRARY — the agentless floor. Five working Starlark scripts a
// player can tap-deploy (and tweak) with no AI at all. Each is real engine
// code, exercised by server/enginetest.ts against the actual Go engine.
//
// The world a script sees each tick (read-only, frozen):
//   world["tick"]        int
//   world["district"]    your district index
//   world["you"]         {"tokens","ore","food","parts","integrity"}
//   world["veins"]       [{"id","rate","reserve"}] — live veins only
//   world["structures"]  {"wall"|"granary"|"beacon"|"ark":
//                          {"parts","required","complete","hp","hpMax"}}
//   world["granaryFood"] int
//   world["survivors"]   int
//   world["storm"]       {"inTicks","severity"} — the visible countdown
//   world["frontier"]    "wall"|"granary"|"beacon"|"ark"|None — next milestone
//   world["dyads"]       [{"name","district","parts","contributed"}]
// Builtins: act(verb, **params) · rand() · randint(n) · remember(k, v) ·
// recall(k, default) · print(...) — plus the deterministic Starlark universe.

export interface Template {
  id: string
  name: string
  scope: 'district' | 'shared'
  blurb: string
  source: string
}

export const TEMPLATES: Template[] = [
  {
    id: 'miner',
    name: 'Vein Miner',
    scope: 'district',
    blurb: 'gathers ore from the richest live vein, re-targeting as veins run dry',
    source: `# Vein Miner — gather from the richest vein that still has ore.
best = None
for v in world["veins"]:
    if v["reserve"] > 0 and (best == None or v["rate"] > best["rate"]):
        best = v
if best != None:
    act("gather", node=best["id"], rate=best["rate"])
else:
    print("no live veins — waiting for a new one to surface")
`,
  },
  {
    id: 'farmer',
    name: 'Field Hand',
    scope: 'district',
    blurb: 'steady food every tick — the granary and survivors will need it',
    source: `# Field Hand — food is slow but the fields never run dry.
act("farm", rate=3)
`,
  },
  {
    id: 'smith',
    name: 'Parts Smith',
    scope: 'district',
    blurb: 'crafts ark parts whenever there is ore to spare (4 ore = 1 part)',
    source: `# Parts Smith — turn ore into parts, keep a small ore buffer.
if world["you"]["ore"] >= 8:
    act("craft", amount=2)
elif world["you"]["ore"] >= 4:
    act("craft", amount=1)
`,
  },
  {
    id: 'builder',
    name: 'Frontier Builder',
    scope: 'shared',
    blurb: 'SHARED: pushes your parts into the current milestone (needs the oracle gate)',
    source: `# Frontier Builder — contribute parts to the next milestone.
# SHARED SCOPE: this script only lands parts if it deployed oracle-green.
target = world["frontier"]
if target == None:
    # everything is built — top up the wall before the next storm
    target = "wall"
parts = world["you"]["parts"]
if parts > 0:
    act("contribute", structure=target, amount=min(parts, 5))
    print("contributing", min(parts, 5), "to", target)
`,
  },
  {
    id: 'quartermaster',
    name: 'Quartermaster',
    scope: 'shared',
    blurb: 'SHARED: farms, then stores food in the granary once it stands',
    source: `# Quartermaster — keep the granary stocked so survivors can arrive.
act("farm", rate=3)
if world["structures"]["granary"]["complete"] and world["you"]["food"] >= 6:
    act("store", amount=5)
`,
  },
]

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id)
}
