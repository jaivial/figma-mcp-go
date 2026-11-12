# Why LLMs botch layout in Figma through figma-mcp-go — and how to fix it

Analysis of `RamenSV/figma-mcp-go` (fork: `jaivial/figma-mcp-go`, includes the local
`feat/multi-file` commits: `execute_code` + multi-file routing).

**TL;DR** — The server side is solid (multi-file routing, timeouts, progress, screenshot-to-disk,
ID validation). The failure point is the *contract with the model*: the read tools strip exactly
the fields layout depends on (auto-layout, sizing modes, absolute bounds, parent links), and the
only write tool (`execute_code`) is a blank canvas with no guards, no diff and no validation
loop. LLMs don't misalign frames because they're dumb; they misalign because **the tool surface
hides the information that would let them be right, and gives no feedback when they're wrong.**

---

## 1. Architecture recap

```
MCP client ──stdio── follower ──HTTP /rpc──▶ leader :1994 ──WebSocket──▶ Figma plugin
                                            (election: first process wins)
```

- `internal/`: leader/follower election, bridge (request/response matching, timeouts, progress),
  RPC validation, 13 read tools + 1 write tool (`execute_code`).
- `plugin/code.js`: request handlers executed in the Figma sandbox; `serializeNode` produces what
  the model sees of the document.

## 2. Root causes of LLM layout mistakes (with code evidence)

### 2.1 The serializer strips the layout model

`plugin/code.js → serializeNode()` returns `{id, name, type, bounds, styles{fills, strokes,
cornerRadius, padding}}` (+ text bits). It omits everything that decides geometry:

| Missing field | Consequence for the model |
|---|---|
| `layoutMode`, `itemSpacing`, `primaryAxisAlignItems`, `counterAxisAlignItems` | Model can't know the parent is an auto-layout frame; plans absolute positioning |
| `primaryAxisSizingMode` / `counterAxisSizingMode` (HUG vs FIXED) | Model resizes a HUG frame and expects the width to stick, or centers into a frame whose size changes |
| `layoutAlign`, `layoutGrow`, `layoutSizingHorizontal/Vertical` | Per-child auto-layout behavior invisible |
| `constraints` (h/v) | Model assumes top-left pinning everywhere |
| `absoluteBoundingBox` / `absoluteRenderBounds` | Model aligns to geometric bounds that ignore strokes, shadows, blur, rotation |
| `rotation`, `absoluteTransform` | Coordinate math silently wrong under rotated parents |
| `parentId`, `childCount` in flat reads | Model can't tell nesting or which frame owns a node |
| `textAutoResize`, `lineHeight`, `letterSpacing` | Text resize/typography edits behave unexpectedly |
| `clipsContent`, `opacity`, `effects`, `layoutGrids` | Overlap/visibility reasoning wrong; page grid ignored |
| `mainComponent` (INSTANCE) | Model edits an instance instead of the main component, or vice versa |

### 2.2 Writes are raw code with silent no-ops — *live-verified*

Probes run against the real plugin (self-cleaning scratch nodes):

```js
f.layoutMode = 'VERTICAL'; f.appendChild(r);
r.x = 200; r.y = 200;        // → r.x stays 0, r.y stays 0. NO error. Silent no-op.
r2.x = 500; f.appendChild(r2); // → auto-layout re-places r2 to {x:0, y:100}
```

This is the worst possible failure mode for an agent: the code "succeeds", the model believes the
node moved, and nothing happened. No exception, no diff, no report. The classic LLM mistakes then
compound:

- hand-computed centers: `(parent.width - child.width)/2` on nested frames using local vs global coords;
- gaps set as absolute positions instead of `itemSpacing`/padding (12, 12, 13, 27…);
- children "placed" inside auto-layout frames (silently re-flowed);
- `resize()` on TEXT whose `textAutoResize` the model never saw;
- fonts not loaded before setting `.characters` → hard throw, retry loop;
- nodes created but never appended (orphaned, "nothing happened");
- exception mid-script → half-built layout, no rollback;
- `findAll` over a whole 140,000-px page → 30 s timeout, everything lost.

### 2.3 Real node IDs are rejected by the validator — *live-verified*

Instances produced ids like `I80:165050;80:162650` in the same file. But
`internal/schema.go → nodeIDPattern = ^\d+:\d+$` rejects them, so `get_node`,
`get_nodes_info`, `get_screenshot`, `save_screenshots`, `scan_text_nodes`,
`scan_nodes_by_types` **fail on IDs that this MCP's own serializer returns**. The model reads a
child list, calls `get_node` on a child, and gets "must use colon format".

### 2.4 No post-write verification loop

Nothing tells the model "child 3/7 is 14 px outside the frame", "these siblings overlap",
"gaps are inconsistent", "values are off the 8-pt grid". The only feedback channel is a screenshot
— expensive, and vision models are weak at pixel-level diffing of subtle misalignment.

### 2.5 No alignment primitives

The Plugin API deliberately has no align/distribute commands; every MCP consumer must re-derive
that math in generated code each time — on data that (per 2.1) lacks absolute transforms. It is the
most error-prone path in the whole pipeline, and it runs on every single "make this neat" request.

### 2.6 Bare errors, no change report

`execute_code` returns only what the code `return`s. If the model forgets to return ids, it's
blind. Syntax errors surface as "Unexpected token }" with no line or excerpt. Plugin API errors
arrive terse, and there is no automatic manifest of created/changed/removed nodes.

### 2.7 Security (not LLM-related, but real)

`leader.go → net.Listen(":"+port)` binds **all interfaces**; `/rpc` has no auth and
`websocket.Accept` skips origin verification. Any LAN host can POST `execute_code` into any
open Figma file and exfiltrate screenshots of private designs.

---

## 3. Improvement plan (ranked: impact ÷ effort)

### Tier 1 — Make reads layout-aware (plugin-only, ~1 PR, kills the root cause)

**P1 · Extend `serializeNode` with a `layout` block** (omit when absent; round numbers to 2 dp):

```js
layout: {
  mode, itemSpacing, wrap, padding{t,r,b,l},
  primaryAlign, counterAlign, primarySizing, counterSizing,
  constraints{h,v}, clipsContent, rotation,
  absoluteBoundingBox, absoluteRenderBounds,   // rounded
  parentLayoutMode                             // "the parent is auto-layout → x/y writes no-op"
}
// TEXT: + textAutoResize, lineHeight, letterSpacing
// INSTANCE: + mainComponent{id, name}
// every node: + parentId, childCount
```

**P2 · New `get_layout_context({nodeId})`**: one call returning everything needed to place a child
— parent config, sibling boxes sorted along the main axis, free space, page `layoutGrids`, effective
bounds incl. stroke/shadow, and an explicit `hints` array ("parent is VERTICAL auto-layout: use
itemSpacing/padding; x/y are ignored", "page grid is 8pt: snap values").

**P3 · Fix the ID validator**: accept `^I?\d+(?::\d+)*(?:;I?\d+:\d+)*$` — i.e. optional `I`
prefix and `;` compound instance ids — and normalize (Figma accepts both forms in
`getNodeByIdAsync`).

### Tier 2 — Guardrailed writes (prevent the mistake instead of punishing it)

**P4 · `set_text({nodeId, characters, style?})`**: loads every ranged font via
`getRangeAllFontNames`, applies style, respects/handles `textAutoResize`, returns final bounds.

**P5 · `place_node({nodeId, parentId?, position|after|below|align, snap=8})`**: the plugin does
the absolute→local transform (never the model), snaps to grid, appends in visual order to
auto-layout parents, auto-hugs, and returns an actionable error for impossible ops (instance child,
locked, auto-layout x/y).

**P6 · `align_nodes({nodeIds, mode, relativeTo})` + `distribute_nodes({nodeIds, axis, spacing})`**:
exact math server-side, rotation-aware via `absoluteTransform`.

**P7 · `auto_layout({nodeIds, direction, spacing, padding, hug})`**: converts hand-placed nodes
into a proper auto-layout frame in visual order — fixes the #1 legacy mistake in one call.

**P8 · `execute_code` rails**:
- inject a documented prelude of helpers into scope: `snap()`, `row()`, `col()`, `hug()`,
  `spaceEvenly()`, `loadFonts()`, `boundsOf()` — so models reach for primitives instead of raw math;
- track created nodes; opt-in `rollback: true` removes them if the script throws;
- always return `{result, changed: {created[], removed, moved}}`;
- on syntax error, echo the offending line ±3 lines of context;
- warn when a write targeted an auto-layout child's `x`/`y` (detectable post-hoc by re-reading).

**P9 · `validate_layout({nodeId, grid=8, checks[]})`** — the missing "layout compiler": returns
findings with node ids and exact deltas ("overlap 14×8 px", "gap 27 px vs sibling 12 px", "4 values
off 8-pt grid"). Enables the loop *write → validate → fix* without screenshots.

### Tier 3 — Workflow, safety, DX

**P10 · `write_design_strategy` prompt** + rewritten tool descriptions encoding the heuristics
("prefer auto-layout + itemSpacing over manual gaps; never hand-compute centers; snap to 8;
validate after writing"). Tool descriptions are the model's only system prompt.

**P11 · Token discipline**: optional `fields` filter on `get_node(s)`; truncate children with
"…and N more" markers; compact index mode (rows of id/name/type/size); cap response sizes.

**P12 · Security**: bind leader to `127.0.0.1`; token handshake between plugin and leader; verify
WS origin.

**P13 · Robustness/tests**: node-count caps on `get_document`; fuzz `serializeNode` against
mixed-value symbols; there are currently zero tests.

**P14 · Optional `begin_edit`/`end_edit`**: snapshot id/type/bounds, return a change summary —
cheap transactions for multi-step edits.

---

## 4. Mistake → cause → fix map

| Common LLM mistake | Why this surface causes it | Fix |
|---|---|---|
| Sets x/y on auto-layout child (silently ignored) | `layoutMode` never serialized; no-op writes undetected | P1, P8, P9 |
| Child placed with global coords in local space | `parentId`, `absoluteBoundingBox`, `absoluteTransform` missing | P1, P2, P5 |
| Siblings overlap after insert | no collision feedback | P9 |
| Gaps 12/12/13/27 px | `itemSpacing` invisible; no lint | P1, P7, P9 |
| Centering off by a few px in nested frames | hand math without absolute transforms | P5, P6 |
| "font not loaded" throw → retry loop | model must remember `loadFontAsync` | P4 |
| `resize()` breaks HUG text | `textAutoResize` invisible | P1, P4 |
| Edits instance instead of main component | `mainComponent` invisible | P1 |
| Orphan nodes, "nothing happened" | no created-nodes report | P8 |
| Half-built layout after mid-script error | no rollback | P8, P14 |
| "must use colon format" on valid instance ids | regex rejects `I…;…` ids | P3 |
| Retry loops on bare errors | no line context in errors | P8 |
| Writes into wrong file | ~~already fixed~~ `select_file` ✔ | — |

## 5. What's already right

- Multi-file routing (`select_file` / `file` arg) that fails instead of guessing the target file.
- `save_screenshots` — metadata only, no base64 in context. Correct call for token budget.
- Progress updates extending timeouts; disconnect fail-fast; 100 MB WS read limit.
- `get_design_context` depth limiting; `read_design_strategy` prompt.
- Clean leader/follower election; small, readable Go.

## 6. Suggested PR sequence

1. **P3** (ID regex fix — 5 lines, unblocks instance workflows today).
2. **P1 + P2** (layout-aware serializer + `get_layout_context`) — one PR, plugin + tools.go.
3. **P8 rails + P9 validator** — makes the write loop self-correcting.
4. **P4–P7** structured write tools, one PR each.
5. **P10–P13** prompt/descriptions, token discipline, security hardening, tests.

