# figma-mcp-go

> A **zero-cost, unlimited** Figma MCP server — no API key, no rate limits, just a single Go binary.

Works with Cursor, Claude, GitHub Copilot, and any MCP-compatible AI tool.

---

## Why this exists

Most Figma MCP servers rely on the **Figma REST API**.

That sounds fine… until you hit this:

| Plan | Limit |
|------|-------|
| Starter / View / Collab | **6 tool calls/month** |
| Pro / Org (Dev seat) | 200 tool calls/day |
| Enterprise | 600 tool calls/day |

If you're experimenting with AI tools, you’ll burn through that in minutes.

I didn’t have enough money to pay for higher limits.
So I built something that **doesn’t use the API at all**.

## Setup

Watch the video:

[![Watch the video](https://img.youtube.com/vi/DjqyU0GKv9k/sddefault.jpg)](https://youtu.be/DjqyU0GKv9k)

### 1. Configure your AI tool

.vscode/mcp.json
```json
{
	"servers": {
		"figma-mcp-go": {
			"type": "stdio",
			"command": "npx",
			"args": [
				"-y",
				"@vkhanhqui/figma-mcp-go"
			]
		}
	}
}
```

.mcp.json
```json
{
  "mcpServers": {
    "figma-mcp-go": {
      "command": "npx",
      "args": ["-y", "@vkhanhqui/figma-mcp-go"]
    }
  }
}
```

### 2. Install the Figma plugin

1. In Figma Desktop: **Plugins → Development → Import plugin from manifest**
2. Select `manifest.json` in the [plugin.zip](https://github.com/vkhanhqui/figma-mcp-go/releases)
3. Run the plugin inside any Figma file

---

## Available tools

### Document & Selection

| Tool | Description |
|------|-------------|
| `get_document` | Full current page tree |
| `get_metadata` | File name, pages, current page |
| `get_selection` | Currently selected nodes |
| `get_node` | Single node by ID |
| `get_nodes_info` | Multiple nodes by ID |
| `get_design_context` | Depth-limited tree — token-efficient for large files |
| `scan_text_nodes` | All text nodes in a subtree |
| `scan_nodes_by_types` | Nodes matching given type list |

### Styles & Variables

| Tool | Description |
|------|-------------|
| `get_styles` | Paint, text, effect, and grid styles |
| `get_variable_defs` | Variable collections and values |
| `get_local_components` | All components in the file |
| `get_annotations` | Dev-mode annotations |

### Export

| Tool | Description |
|------|-------------|
| `get_screenshot` | Base64 image export of any node |
| `save_screenshots` | Export images to disk (server-side, no API call) |

### Writing & layout

| Tool | Description |
|------|-------------|
| `get_layout_context` | Layout around a node: parent auto-layout state, sibling geometry, page grid, free space — read it before writing near existing content |
| `set_text` | Edit text safely — loads every ranged font automatically |
| `place_node` | Place by absolute coordinates; converts to parent-local space and snaps (default 8px) |
| `align_nodes` | Align nodes to each other or their parent — no hand-computed centering |
| `distribute_nodes` | Space nodes evenly, horizontally or vertically |
| `auto_layout` | Convert an absolute-positioned group into an auto-layout frame |
| `validate_layout` | Find overlaps, out-of-bounds nodes, inconsistent gaps, off-grid nodes, auto-layout overflow |

Node IDs use colon format (`4029:12345`), never hyphens. Nodes inside instances carry the
instance prefix joined by a semicolon (`I80:165050;80:162650`) — pass IDs back exactly as
returned.

---

## Several files at once

Run the plugin in as many Figma files (tabs) as you like: the leader keeps one connection per
file instead of replacing the previous one, and names each connection by asking the plugin
(`get_metadata`), so plugins of any version work.

| Tool / argument | What it does |
|---|---|
| `list_files` | The connected files: connection id (`c1`, `c2`…), file name, current page, pending requests |
| `select_file` | Pick this session's file (connection id, exact name, or a unique part of the name) |
| `file` (every tool) | Override the target for one call |

Without `file` and without a selection, a call goes to the only connected file; with several
connected it fails and lists them, so an agent never writes into a file it did not choose.
Each MCP process (one per agent session) keeps its own selection, so different agents can
drive different files in parallel through the same leader.

**Standalone leader.** `figma-mcp-go leader` owns the port and the plugin connections without
being an MCP server; run it as a service and every MCP process becomes a follower of it, so
connections survive agent sessions ending. `FIGMA_MCP_PORT` changes the port (default 1994; the
plugin's `ui.html` and `manifest.json` must use the same one).

## Layout-safe workflow for AI agents

The short version of the `write_design_strategy` prompt:

0. **Pick the file first** — `list_files`, then `select_file`; never rely on the single-file default.
1. **Look before you place** — `get_layout_context` before creating or moving anything near
   existing content: it tells you if the parent is auto layout (x/y writes are silently
   ignored there), sibling geometry, the page grid, and where free space is.
2. **Structure over coordinates** — `auto_layout` to convert messy absolute groups;
   `place_node` (converts absolute → local and snaps, default 8px) over manual x/y;
   `align_nodes`/`distribute_nodes` over hand-computed centering — never compute
   `(parent.width - child.width) / 2` yourself.
3. **`set_text` for all text edits** — it loads every ranged font automatically; never set
   `.characters` directly without loading fonts first.
4. **`execute_code` for the rest** — helpers are in scope (`snap`, `round2`, `boundsOf`,
   `loadFonts`, `layoutInfo`); return ids/names/counts; the response includes an automatic
   changed-manifest, and `rollback: true` removes nodes created before a throw.
5. **Validate every batch** — `validate_layout` (overlaps, out-of-bounds, inconsistent gaps,
   off-grid, auto-layout overflow), fix the findings; `save_screenshots` only as final
   visual confirmation.
6. **Hygiene** — name layers, remove probe nodes in the same call, keep Light/Dark +
   breakpoint twin frames in sync, edit main components (not instances) for design-system
   changes.

## Running a second instance side-by-side

Each leader owns its port, so a second, fully independent instance just needs another one.
Set `FIGMA_MCP_PORT` — e.g. `1996` — on the second leader:

```ini
# /etc/systemd/system/figma-mcp-go-fork-leader.service
[Service]
Environment=FIGMA_MCP_PORT=1996
ExecStart=/usr/local/bin/figma-mcp-go leader
```

Everything follows the port: MCP processes started with the same `FIGMA_MCP_PORT` become
followers of that leader, and the plugin's WebSocket URL does too — point `WS_URL` in
`ui.html` (and the `allowedDomains` entry in `manifest.json`) at `ws://localhost:1996/ws`
and import that variant as a separate development plugin for the files this instance
should drive.

`FIGMA_MCP_TOKEN` (optional) enables shared-secret authentication: when set, only clients
presenting the same token are accepted.

## Migrating a rendered web page into Figma

`scripts/dom2figma.mjs` is the **code → design** half of the migration bridge: it snapshots
a page in the fork's CDP browser and rebuilds it in Figma through `build_from_spec`. The
browser has already resolved every style, so what you get is what the user actually sees —
Tailwind arbitrary values, media queries, and `oklch()` colors included.

What it maps:

| In the page | In Figma |
|---|---|
| `display: flex` container | Auto-layout frame (`dir`, `gap`, `pad`, `align`) with fixed measured size |
| Text-bearing leaf | Text node (`chars`, `size`, `weight` mapped 400/500/600/700+, `color`) |
| Plain block container | Frame whose children keep their absolute page coordinates |
| `<img>` (loaded) | Gray placeholder rectangle named `img:<alt or filename>` |
| Inline `<svg>` (≥ 12px) | Ellipse stub named `icon:<aria-label or class>` |

Example against the Neural dev server:

```bash
# inspect the generated spec first (children beyond 2 levels shown as counts)
./scripts/dom2figma.mjs http://127.0.0.1:5173 --dry

# rebuild the whole page, or just a section, into the connected Figma file
./scripts/dom2figma.mjs http://127.0.0.1:5173 --sel "header" --name "Neural — Header" --position 0,0
```

It connects to the CDP browser (`--cdp`, default `http://127.0.0.1:9395`) in a new tab,
grants `local-network-access`, waits for the page to settle (`--wait`), walks the DOM
(`--max-nodes`/`--max-depth` caps, `--snap` optional grid), and POSTs to the leader
(`--rpc`, default `http://127.0.0.1:1996`; `FIGMA_MCP_TOKEN` is honored). The tab it
opened is closed afterwards.

Fidelity limits: shadows, gradients, and blend modes fall back to the nearest solid fill;
fonts fall back to the closest mapped weight; `<canvas>`, `<video>`, `<iframe>`, and
SVG internals are skipped or stubbed; hover states and below-the-fold lazy content are
not captured. In return you get live geometry — the exact rendered sizes, gaps, and
colors — as a starting point to clean up by hand.

The reverse direction is `export_code`: it turns a Figma selection back into Tailwind
markup, so a page can round-trip DOM → Figma → code while you tune either side.

## Contributing

Issues and PRs are welcome.

## References

- [magic-spells/figma-mcp-bridge](https://github.com/magic-spells/figma-mcp-bridge)
- [grab/cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp)
- [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge)
