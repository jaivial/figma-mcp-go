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

## Contributing

Issues and PRs are welcome.

## References

- [magic-spells/figma-mcp-bridge](https://github.com/magic-spells/figma-mcp-bridge)
- [grab/cursor-talk-to-figma-mcp](https://github.com/grab/cursor-talk-to-figma-mcp)
- [gethopp/figma-mcp-bridge](https://github.com/gethopp/figma-mcp-bridge)
