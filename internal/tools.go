package internal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// RegisterTools registers the MCP tools on the server.
//
// Several Figma files can run the plugin at once (one connection each). Every tool
// takes an optional `file` (connection id or file name); without it the call goes to
// the file chosen with select_file, or to the only connected file.
func RegisterTools(s *server.MCPServer, node *Node) {
	// Files

	s.AddTool(mcp.NewTool("list_files",
		mcp.WithDescription("List the Figma files currently running the plugin (one per connection): "+
			"connection id, file name, current page, pending requests. Also says which one this session selected."),
	), func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		files, err := node.Files(ctx)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		out, _ := json.Marshal(map[string]interface{}{"files": files, "selected": node.Selected()})
		return mcp.NewToolResultText(string(out)), nil
	})

	s.AddTool(mcp.NewTool("select_file",
		mcp.WithDescription("Choose the Figma file this session works on: every later call without `file` goes there. "+
			"Pass a connection id (from list_files) or a file name / unique part of it; empty clears the choice. "+
			"Use it before writing when more than one file is connected, so you never edit someone else's file."),
		mcp.WithString("file",
			mcp.Description("Connection id (e.g. 'c2') or file name; empty string clears the selection"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		target := fileArg(req)
		if target == "" {
			node.Select("")
			return mcp.NewToolResultText(`{"selected":""}`), nil
		}
		// Resolve through the same rule every call uses: the choice must name exactly one file now.
		resp, err := node.Send(ctx, target, "get_metadata", nil, nil)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		if resp.Error != "" {
			return mcp.NewToolResultError(resp.Error), nil
		}
		node.Select(target)
		out, _ := json.Marshal(map[string]interface{}{"selected": target, "metadata": resp.Data})
		return mcp.NewToolResultText(string(out)), nil
	})

	// ── Document & Selection ─────────────────────────────────────────────

	s.AddTool(mcp.NewTool("get_document",
		withFile(),
		mcp.WithDescription("Get the current Figma page document tree"),
	), makeHandler(node, "get_document", nil, nil))

	s.AddTool(mcp.NewTool("get_metadata",
		withFile(),
		mcp.WithDescription("Get metadata about the current Figma document: file name, pages, current page"),
	), makeHandler(node, "get_metadata", nil, nil))

	s.AddTool(mcp.NewTool("get_selection",
		withFile(),
		mcp.WithDescription("Get the currently selected nodes in Figma"),
	), makeHandler(node, "get_selection", nil, nil))

	s.AddTool(mcp.NewTool("get_node",
		withFile(),
		mcp.WithDescription("Get a specific Figma node by ID. Must use colon format e.g. '4029:12345', never hyphens."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("Node ID in colon format e.g. '4029:12345'"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		nodeID, _ := req.Params.Arguments["nodeId"].(string)
		resp, err := node.Send(ctx, fileArg(req), "get_node", []string{nodeID}, nil)
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("get_nodes_info",
		withFile(),
		mcp.WithDescription("Get detailed information about multiple Figma nodes by ID in a single call."),
		mcp.WithArray("nodeIds",
			mcp.Required(),
			mcp.Description("List of node IDs in colon format e.g. ['4029:12345', '4029:67890']"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		raw, _ := req.Params.Arguments["nodeIds"].([]interface{})
		nodeIDs := toStringSlice(raw)
		resp, err := node.Send(ctx, fileArg(req), "get_nodes_info", nodeIDs, nil)
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("get_design_context",
		withFile(),
		mcp.WithDescription("Get a depth-limited tree of the current selection or page. More token-efficient than get_document for large files."),
		mcp.WithNumber("depth",
			mcp.Description("How many levels deep to traverse (default 2)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		params := map[string]interface{}{}
		if d, ok := req.Params.Arguments["depth"].(float64); ok && d > 0 {
			params["depth"] = d
		}
		resp, err := node.Send(ctx, fileArg(req), "get_design_context", nil, params)
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("get_layout_context",
		withFile(),
		mcp.WithDescription("Everything needed to place/align inside or next to a node WITHOUT guessing: "+
			"parent layout mode (auto-layout vs absolute), sibling geometry, free space, page grid, and explicit hints. "+
			"Call this BEFORE moving/creating nodes near existing content — the #1 cause of misplaced frames is ignoring the parent's auto-layout."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("Node ID, colon format e.g. '4029:12345' or instance 'I80:165050;80:162650'"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		nodeID, _ := req.Params.Arguments["nodeId"].(string)
		resp, err := node.Send(ctx, fileArg(req), "get_layout_context", nil, map[string]interface{}{"nodeId": nodeID})
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("scan_text_nodes",
		withFile(),
		mcp.WithDescription("Scan all TEXT nodes in a subtree. Useful for extracting all copy from a component or frame."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("Root node ID to scan from, colon format e.g. '4029:12345'"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		nodeID, _ := req.Params.Arguments["nodeId"].(string)
		resp, err := node.Send(ctx, fileArg(req), "scan_text_nodes", nil, map[string]interface{}{"nodeId": nodeID})
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("scan_nodes_by_types",
		withFile(),
		mcp.WithDescription("Find all nodes matching specific types (e.g. FRAME, COMPONENT, INSTANCE) within a subtree."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("Root node ID to scan from, colon format e.g. '4029:12345'"),
		),
		mcp.WithArray("types",
			mcp.Required(),
			mcp.Description("Node types to find e.g. ['FRAME', 'COMPONENT', 'INSTANCE']"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		nodeID, _ := req.Params.Arguments["nodeId"].(string)
		raw, _ := req.Params.Arguments["types"].([]interface{})
		resp, err := node.Send(ctx, fileArg(req), "scan_nodes_by_types", nil, map[string]interface{}{
			"nodeId": nodeID,
			"types":  raw,
		})
		return renderResponse(resp, err)
	})

	// ── Styles & Variables ───────────────────────────────────────────────

	s.AddTool(mcp.NewTool("get_styles",
		withFile(),
		mcp.WithDescription("Get all local styles in the document: paint, text, effect, and grid styles"),
	), makeHandler(node, "get_styles", nil, nil))

	s.AddTool(mcp.NewTool("get_variable_defs",
		withFile(),
		mcp.WithDescription("Get all local variable definitions: collections, modes, and values. Variables are Figma's design token system."),
	), makeHandler(node, "get_variable_defs", nil, nil))

	s.AddTool(mcp.NewTool("get_local_components",
		withFile(),
		mcp.WithDescription("Get all components defined in the current Figma file."),
	), makeHandler(node, "get_local_components", nil, nil))

	s.AddTool(mcp.NewTool("get_annotations",
		withFile(),
		mcp.WithDescription("Get all dev-mode annotations in the current document or on a specific node."),
		mcp.WithString("nodeId",
			mcp.Description("Optional node ID to filter annotations, colon format e.g. '4029:12345'"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		params := map[string]interface{}{}
		if id, ok := req.Params.Arguments["nodeId"].(string); ok && id != "" {
			params["nodeId"] = id
		}
		resp, err := node.Send(ctx, fileArg(req), "get_annotations", nil, params)
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("search_nodes",
		withFile(),
		mcp.WithDescription("Find existing nodes by name BEFORE creating new ones — reuse beats rebuild. "+
			"Case-insensitive substring match over the current page (or a parentId subtree), optional type filter "+
			"(e.g. COMPONENT, FRAME, TEXT); returns id/name/type/geometry for up to `limit` (default 30) matches. "+
			"If a suitable component or frame already exists, reuse or instance it instead of rebuilding from scratch."),
		mcp.WithString("query",
			mcp.Required(),
			mcp.Description("Case-insensitive name substring to search for, e.g. 'Button/Primary'"),
		),
		mcp.WithString("type",
			mcp.Description("Optional node type filter e.g. 'COMPONENT', 'FRAME', 'TEXT'"),
		),
		mcp.WithString("parentId",
			mcp.Description("Optional subtree root node ID; default searches the whole current page"),
		),
		mcp.WithNumber("limit",
			mcp.Description("Maximum matches to return (default 30)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		query, _ := req.Params.Arguments["query"].(string)
		if strings.TrimSpace(query) == "" {
			return mcp.NewToolResultError("query is required"), nil
		}
		resp, err := node.Send(ctx, fileArg(req), "search_nodes", nil, paramsFrom(req, "query", "type", "parentId", "limit"))
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("apply_style",
		withFile(),
		mcp.WithDescription("Bind an existing named style to nodes instead of hardcoding values: paint styles → fills, "+
			"text styles → TEXT nodes, effect styles, grid styles → frames. `styleName` resolves case-insensitively "+
			"(exact name, then unique prefix); ambiguous names error listing the matches, unknown names error with the 5 "+
			"closest names. Nodes that cannot take the style are skipped with a per-node reason; the rest get the style id "+
			"bound, so later style edits propagate. Call get_styles first to see what exists."),
		mcp.WithArray("nodeIds",
			mcp.Required(),
			mcp.Description("Node IDs to bind the style to, colon format e.g. ['4029:12345', '4029:67890']"),
		),
		mcp.WithString("styleType",
			mcp.Enum("paint", "text", "effect", "grid"),
			mcp.Description("Kind of style to bind (default paint)"),
		),
		mcp.WithString("styleName",
			mcp.Required(),
			mcp.Description("Style name, case-insensitive exact or unique prefix e.g. 'Primary/Button'"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		styleName, _ := req.Params.Arguments["styleName"].(string)
		if strings.TrimSpace(styleName) == "" {
			return mcp.NewToolResultError("styleName is required"), nil
		}
		raw, _ := req.Params.Arguments["nodeIds"].([]interface{})
		resp, err := node.Send(ctx, fileArg(req), "apply_style", toStringSlice(raw), paramsFrom(req, "styleType", "styleName"))
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("apply_variable",
		withFile(),
		mcp.WithDescription("Bind a color variable (design token) to fills[0] of nodes instead of hardcoding hex values. "+
			"`variableName` resolves across all local collections (exact name, then unique prefix; ambiguous or unknown names error). "+
			"Needs a SOLID fill in fills[0] — unsuitable nodes are skipped with a per-node reason. Use get_variable_defs to list "+
			"tokens, then prefer this over hand-written fills whenever a matching color token exists."),
		mcp.WithArray("nodeIds",
			mcp.Required(),
			mcp.Description("Node IDs to bind the variable to, colon format e.g. ['4029:12345', '4029:67890']"),
		),
		mcp.WithString("variableName",
			mcp.Required(),
			mcp.Description("Color variable name, case-insensitive exact or unique prefix e.g. 'brand/primary'"),
		),
		mcp.WithString("field",
			mcp.Enum("color"),
			mcp.Description("Paint field to bind (only 'color' is supported for now)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		variableName, _ := req.Params.Arguments["variableName"].(string)
		if strings.TrimSpace(variableName) == "" {
			return mcp.NewToolResultError("variableName is required"), nil
		}
		raw, _ := req.Params.Arguments["nodeIds"].([]interface{})
		resp, err := node.Send(ctx, fileArg(req), "apply_variable", toStringSlice(raw), paramsFrom(req, "variableName", "field"))
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("annotate_finding",
		withFile(),
		mcp.WithDescription("Attach a QA finding as a dev-mode annotation on the exact node, so humans see the problem in Dev Mode "+
			"right where it lives. Severity blocker|major|minor|nit (default minor). Idempotent: re-annotating a node replaces this "+
			"tool's previous '**QA' note on it and leaves every other annotation untouched; finds or creates a red 'QA' category."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("Node ID to annotate, colon format e.g. '4029:12345'"),
		),
		mcp.WithString("message",
			mcp.Required(),
			mcp.Description("Finding description in plain English, e.g. 'label off the 8px grid by 3px'"),
		),
		mcp.WithString("severity",
			mcp.Enum("blocker", "major", "minor", "nit"),
			mcp.Description("Severity of the finding (default minor)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		nodeID, _ := req.Params.Arguments["nodeId"].(string)
		if strings.TrimSpace(nodeID) == "" {
			return mcp.NewToolResultError("nodeId is required"), nil
		}
		message, _ := req.Params.Arguments["message"].(string)
		if strings.TrimSpace(message) == "" {
			return mcp.NewToolResultError("message is required"), nil
		}
		resp, err := node.Send(ctx, fileArg(req), "annotate_finding", nil, paramsFrom(req, "nodeId", "message", "severity"))
		return renderResponse(resp, err)
	})

	// ── Export ───────────────────────────────────────────────────────────

	s.AddTool(mcp.NewTool("get_screenshot",
		withFile(),
		mcp.WithDescription("Export a screenshot of selected or specific nodes. Returns base64-encoded image data."),
		mcp.WithArray("nodeIds",
			mcp.Description("Optional node IDs to export, colon format. If empty, exports current selection."),
		),
		mcp.WithString("format",
			mcp.Description("Export format: PNG (default), SVG, JPG, or PDF"),
		),
		mcp.WithNumber("scale",
			mcp.Description("Export scale for raster formats (default 2)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		raw, _ := req.Params.Arguments["nodeIds"].([]interface{})
		nodeIDs := toStringSlice(raw)
		params := map[string]interface{}{}
		if f, ok := req.Params.Arguments["format"].(string); ok && f != "" {
			params["format"] = f
		}
		if s, ok := req.Params.Arguments["scale"].(float64); ok && s > 0 {
			params["scale"] = s
		}
		resp, err := node.Send(ctx, fileArg(req), "get_screenshot", nodeIDs, params)
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("export_code",
		withFile(),
		mcp.WithDescription("Export a Figma subtree as HTML+Tailwind (default), React+Tailwind JSX, or JSON AST. "+
			"Auto-layout maps to flex utilities (gap/padding/justify/items), absolute frames to positioned divs, "+
			"text styles to type utilities. Use for Figma→code migration, then map utilities to the target project's tokens."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("Root node ID to export, colon format e.g. '4029:12345'"),
		),
		mcp.WithString("flavor",
			mcp.Enum("html-tailwind", "react-tailwind", "json"),
			mcp.Description("Output flavor: html-tailwind (default), react-tailwind (JSX), or json (serialized AST)"),
		),
		mcp.WithNumber("maxNodes",
			mcp.Description("Maximum nodes to walk before truncating the output (default 2000)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		nodeID, _ := req.Params.Arguments["nodeId"].(string)
		if strings.TrimSpace(nodeID) == "" {
			return mcp.NewToolResultError("nodeId is required"), nil
		}
		params := map[string]interface{}{"nodeId": nodeID}
		if flavor, ok := req.Params.Arguments["flavor"].(string); ok && flavor != "" {
			params["flavor"] = flavor
		}
		if maxNodes, ok := req.Params.Arguments["maxNodes"].(float64); ok && maxNodes > 0 {
			params["maxNodes"] = maxNodes
		}
		resp, err := node.Send(ctx, fileArg(req), "export_code", nil, params)
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("save_screenshots",
		withFile(),
		mcp.WithDescription("Export screenshots for multiple nodes and save them to the local filesystem. Returns metadata only (no base64)."),
		mcp.WithArray("items",
			mcp.Required(),
			mcp.Description("List of {nodeId, outputPath, format?, scale?} objects"),
		),
		mcp.WithString("format",
			mcp.Description("Default export format: PNG (default), SVG, JPG, or PDF"),
		),
		mcp.WithNumber("scale",
			mcp.Description("Default export scale for raster formats (default 2)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return executeSaveScreenshots(ctx, node, req)
	})

	s.AddTool(mcp.NewTool("capture_review",
		withFile(),
		mcp.WithDescription("Screenshot a node to disk AND return its layout context + text inventory + a visual-review checklist in one call — everything a vision agent needs to review a design without extra round-trips. Write findings with annotate_finding, fix with place_node/align_nodes/auto_layout/set_text, then capture_review again to a NEW file and compare before/after."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("Node to capture, colon format e.g. '4029:12345'"),
		),
		mcp.WithString("outputPath",
			mcp.Required(),
			mcp.Description("Relative path for the PNG, inside the working directory, must not already exist (e.g. .figma-shots/review-1.png)"),
		),
		mcp.WithNumber("scale",
			mcp.Description("Export scale for the PNG (default 1)"),
		),
		mcp.WithNumber("contextDepth",
			mcp.Description("How many levels of surrounding layout to include in the context (default 2)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return ExecuteCaptureReview(ctx, node, req)
	})

	s.AddTool(mcp.NewTool("export_visual_review",
		withFile(),
		mcp.WithDescription("Export EVERY reviewable frame of EVERY page (or filtered pages) as ready-to-review images in ONE call: "+
			"enumerates top-level frames (optional nested), exports each at a legibility-preserving auto scale (2x small components, 1x screens, "+
			"downscale for oversized), tiles frames taller than tileMaxHeight (default 1600 design px, 64px overlap) so text stays readable after "+
			"model downscaling, writes JPG/PNG under outputDir (relative, must not exist) with deterministic page/frame naming, and returns a "+
			"manifest (paths + tile counts + review checklist). No base64 reaches your context. Review each image against the checklist, "+
			"annotate issues with annotate_finding, fix, then re-run into a NEW directory and compare."),
		mcp.WithString("outputDir",
			mcp.Required(),
			mcp.Description("Relative output directory for the review images; must not exist yet"),
		),
		mcp.WithArray("pages",
			mcp.Description("Optional page names/ids to review; default: every page"),
		),
		mcp.WithString("filter",
			mcp.Description("Optional case-insensitive regex on frame names"),
		),
		mcp.WithBoolean("includeNested",
			mcp.Description("Also include nested frames one level deep (default: top-level screens only)"),
		),
		mcp.WithNumber("scale",
			mcp.Description("Fixed export scale; default 0 = auto (2x <800px, 1x <=2400px, else fit 1600)"),
		),
		mcp.WithString("format",
			mcp.Description("JPG (default, jpegQuality 88) or PNG"),
		),
		mcp.WithNumber("tileMaxHeight",
			mcp.Description("Max tile height in design px (default 1600; tall frames are sliced with overlap)"),
		),
		mcp.WithNumber("maxFrames",
			mcp.Description("Safety cap, default 200"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		out, err := ExecuteVisualReview(ctx, node, req.Params.Arguments)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		b, _ := json.Marshal(out)
		return mcp.NewToolResultText(string(b)), nil
	})

	// ── Layout writes ────────────────────────────────────────────────────

	s.AddTool(mcp.NewTool("set_text",
		withFile(),
		mcp.WithDescription("Set the text and typography of an existing TEXT node: characters, fontSize, fontName, "+
			"textAlignHorizontal, textAutoResize. Loads every font the node currently uses (plus the fontName override) "+
			"before writing, and applies font/style before characters. Safer than execute_code for text edits."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("TEXT node ID in colon format e.g. '4029:12345'"),
		),
		mcp.WithString("characters",
			mcp.Description("Replacement text"),
		),
		mcp.WithNumber("fontSize",
			mcp.Description("Font size in px"),
		),
		mcp.WithObject("fontName",
			mcp.Properties(map[string]interface{}{
				"family": map[string]interface{}{"type": "string", "description": "Font family e.g. 'Inter'"},
				"style":  map[string]interface{}{"type": "string", "description": "Font style e.g. 'Regular' or 'Bold'"},
			}),
			mcp.Description("Font override {family, style}; applied to the whole node"),
		),
		mcp.WithString("textAlignHorizontal",
			mcp.Enum("LEFT", "CENTER", "RIGHT", "JUSTIFIED"),
			mcp.Description("Horizontal text alignment"),
		),
		mcp.WithString("textAutoResize",
			mcp.Enum("NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"),
			mcp.Description("Auto-resize behaviour of the text node"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		nodeID, _ := req.Params.Arguments["nodeId"].(string)
		if nodeID == "" {
			return mcp.NewToolResultError("nodeId is required"), nil
		}
		resp, err := node.Send(ctx, fileArg(req), "set_text", []string{nodeID},
			paramsFrom(req, "characters", "fontSize", "fontName", "textAlignHorizontal", "textAutoResize"))
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("place_node",
		withFile(),
		mcp.WithDescription("Move and/or reparent a node. `position` is in ABSOLUTE page coordinates and is converted "+
			"to the parent's local space via the parent's absoluteTransform (never naive subtraction), then snapped to an "+
			"8px grid by default; `relative` is already parent-local. Do NOT set x/y on children of auto-layout parents — "+
			"Figma silently ignores it; this tool detects auto-layout and uses child order (`after`) plus parent alignment "+
			"instead, reporting mode 'auto-layout'. Refuses nodes inside instances (edit the main component)."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("Node ID to place, colon format e.g. '4029:12345'"),
		),
		mcp.WithString("parentId",
			mcp.Description("Optional target parent node ID; default keeps the current parent"),
		),
		mcp.WithObject("position",
			mcp.Properties(map[string]interface{}{
				"x": map[string]interface{}{"type": "number", "description": "Absolute page x"},
				"y": map[string]interface{}{"type": "number", "description": "Absolute page y"},
			}),
			mcp.Description("Absolute page coordinates {x, y}; converted to parent-local and snapped"),
		),
		mcp.WithObject("relative",
			mcp.Properties(map[string]interface{}{
				"x": map[string]interface{}{"type": "number", "description": "Parent-local x"},
				"y": map[string]interface{}{"type": "number", "description": "Parent-local y"},
			}),
			mcp.Description("Parent-local coordinates {x, y}; used as-is, then snapped"),
		),
		mcp.WithString("after",
			mcp.Description("Sibling node ID to insert after; in auto-layout parents this sets the order"),
		),
		mcp.WithString("align",
			mcp.Enum("left", "hcenter", "right", "top", "vcenter", "bottom"),
			mcp.Description("Align within the parent: absolute parents align to the content box (bounds minus paddings); "+
				"auto-layout parents set counterAxisAlignItems only when the node is the only child — per-child alignment "+
				"inside auto-layout needs a nested frame"),
		),
		mcp.WithNumber("snap",
			mcp.Description("Snap grid in px for the local position (default 8; <= 0 disables snapping)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		nodeID, _ := req.Params.Arguments["nodeId"].(string)
		if nodeID == "" {
			return mcp.NewToolResultError("nodeId is required"), nil
		}
		resp, err := node.Send(ctx, fileArg(req), "place_node", []string{nodeID},
			paramsFrom(req, "parentId", "position", "relative", "after", "align", "snap"))
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("align_nodes",
		withFile(),
		mcp.WithDescription("Align several nodes to a shared reference box: the union of the nodes' absolute bounding boxes, "+
			"or a `relativeTo` node. Moves are applied as local deltas, so nodes inside auto-layout parents are skipped with "+
			"'inside auto-layout parent: use order/padding', nodes with rotated ancestors with 'rotated ancestor — manual "+
			"handling needed', and nodes inside instances are skipped too. Per-node errors come back in results; the other "+
			"nodes still apply."),
		mcp.WithArray("nodeIds",
			mcp.Required(),
			mcp.Description("Node IDs to align, colon format e.g. ['4029:12345', '4029:67890']"),
		),
		mcp.WithString("mode",
			mcp.Required(),
			mcp.Enum("left", "hcenter", "right", "top", "vcenter", "bottom"),
			mcp.Description("Alignment mode"),
		),
		mcp.WithString("relativeTo",
			mcp.Description("'selection' (default: union of nodeIds) or a node ID to align against"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		raw, _ := req.Params.Arguments["nodeIds"].([]interface{})
		resp, err := node.Send(ctx, fileArg(req), "align_nodes", toStringSlice(raw), paramsFrom(req, "mode", "relativeTo"))
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("distribute_nodes",
		withFile(),
		mcp.WithDescription("Distribute nodes along an axis: with `spacing`, fixed gaps are applied sequentially from the "+
			"first node; without it, the current span is divided into equal gaps. Same guards as align_nodes — nodes inside "+
			"auto-layout parents, inside instances, or under rotated ancestors are skipped with per-node errors. "+
			"Returns the target absolute placement per node."),
		mcp.WithArray("nodeIds",
			mcp.Required(),
			mcp.Description("Node IDs to distribute (at least 2), colon format"),
		),
		mcp.WithString("axis",
			mcp.Required(),
			mcp.Enum("horizontal", "vertical"),
			mcp.Description("Axis to distribute along"),
		),
		mcp.WithNumber("spacing",
			mcp.Description("Fixed gap in px between nodes; omit for equal gaps across the current span"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		raw, _ := req.Params.Arguments["nodeIds"].([]interface{})
		resp, err := node.Send(ctx, fileArg(req), "distribute_nodes", toStringSlice(raw), paramsFrom(req, "axis", "spacing"))
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("auto_layout",
		withFile(),
		mcp.WithDescription("Stack nodes into auto layout in visual order (vertical: by y then x; horizontal: by x then y): "+
			"either reparent `nodeIds` into a new frame positioned at their absolute union, or convert an existing `frameId` "+
			"and reorder its children. Sets direction, spacing, padding (single number or {top,right,bottom,left}) and hug "+
			"sizing on the frame. Refuses nodes inside instances (edit the main component). Afterwards do not set x/y on the "+
			"children — Figma silently ignores it; use place_node order/`after` plus the stack's spacing and padding."),
		mcp.WithArray("nodeIds",
			mcp.Description("Nodes to stack, colon format; or pass frameId to reuse an existing frame's children"),
		),
		mcp.WithString("frameId",
			mcp.Description("Existing frame to convert into the stack (its children are reordered visually)"),
		),
		mcp.WithString("direction",
			mcp.Required(),
			mcp.Enum("horizontal", "vertical"),
			mcp.Description("Stack direction"),
		),
		mcp.WithNumber("spacing",
			mcp.Description("Gap between children in px (default 24)"),
		),
		mcp.WithObject("padding",
			mcp.Properties(map[string]interface{}{
				"top":    map[string]interface{}{"type": "number", "description": "Top padding in px"},
				"right":  map[string]interface{}{"type": "number", "description": "Right padding in px"},
				"bottom": map[string]interface{}{"type": "number", "description": "Bottom padding in px"},
				"left":   map[string]interface{}{"type": "number", "description": "Left padding in px"},
			}),
			mcp.Description("Padding in px: a single number or {top, right, bottom, left} (default 24)"),
		),
		mcp.WithString("hug",
			mcp.Enum("none", "horizontal", "vertical", "both"),
			mcp.Description("Which axes hug their content (default 'none' = fixed at the current size)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		raw, _ := req.Params.Arguments["nodeIds"].([]interface{})
		resp, err := node.Send(ctx, fileArg(req), "auto_layout", toStringSlice(raw),
			paramsFrom(req, "frameId", "direction", "spacing", "padding", "hug"))
		return renderResponse(resp, err)
	})

	// build_from_spec: the spec is a whole grammar tree (object OR array), which
	// the typed schema helpers cannot express — so the property stays permissive
	// (oneOf object|array) and the grammar is taught in the description instead.
	buildSpecTool := mcp.NewTool("build_from_spec",
		withFile(),
		mcp.WithDescription("Build a whole section in ONE call from a JSON spec (nested auto-layout frames, texts, fills). "+
			"Prefer this over repeated execute_code for new UI: ~10x fewer round-trips, auto-layout by default, 8px snapping. "+
			"'auto' nodes map dir/gap/pad/align/hug to Figma auto-layout; fill accepts '#hex' or 'style:<name>' to bind existing paint styles. "+
			"Grammar — auto node: {type:'auto', dir:'h'|'v', gap?, pad?: 16|{t,r,b,l}, align?: {main?: 'start'|'center'|'end'|'space-between', counter?: 'start'|'center'|'end'}, hug?: {w?, h?}}; "+
			"other nodes: {type:'frame'|'text'|'rectangle'|'ellipse'}; common keys: name?, w?, h?, x?, y? (parent-local; ignored under auto layout with a warning), "+
			"fill?, radius?, stroke? ('#hex'), strokeWeight?, opacity?, children? (not for text). "+
			"text adds text:{chars (required), size?, weight?: 'regular'|'medium'|'semibold'|'bold' (Inter, default regular), align?: 'left'|'center'|'right', color?, lineHeight?}. "+
			"Unknown keys become warnings, not errors; an auto axis without an explicit size hugs its content. "+
			"spec = one node or an array (array → wrapped in a hugging horizontal auto frame). "+
			"Example: {type:'auto', dir:'v', gap:8, pad:16, children:[{type:'text', name:'Label', text:{chars:'Total', size:12, weight:'medium'}}, "+
			"{type:'text', name:'Value', text:{chars:'$42', size:24, weight:'bold'}}]}"),
		mcp.WithString("parentId",
			mcp.Description("Optional parent node ID, colon format; default places the tree on the current page"),
		),
		mcp.WithObject("position",
			mcp.Properties(map[string]interface{}{
				"x": map[string]interface{}{"type": "number", "description": "Absolute page x"},
				"y": map[string]interface{}{"type": "number", "description": "Absolute page y"},
			}),
			mcp.Description("Absolute page coordinates {x, y} of the root (default {0, 0}); converted to parent-local and snapped"),
		),
		mcp.WithString("name",
			mcp.Description("Root node name; overrides the spec root's own name"),
		),
		mcp.WithNumber("snap",
			mcp.Description("Snap grid in px for the root position (default 8; <= 0 disables snapping)"),
		),
		mcp.WithNumber("maxNodes",
			mcp.Description("Cap on total nodes created (default 500); the call fails without creating anything when exceeded"),
		),
	)
	buildSpecTool.InputSchema.Properties["spec"] = map[string]interface{}{
		"description": "Declarative node tree: a single node object or an array of nodes (grammar in the tool description)",
		"oneOf": []interface{}{
			map[string]interface{}{"type": "object"},
			map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}},
		},
	}
	buildSpecTool.InputSchema.Required = append(buildSpecTool.InputSchema.Required, "spec")
	s.AddTool(buildSpecTool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		params := paramsFrom(req, "spec", "parentId", "position", "name", "snap", "maxNodes")
		if params["spec"] == nil {
			return mcp.NewToolResultError("spec is required"), nil
		}
		resp, err := node.Send(ctx, fileArg(req), "build_from_spec", nil, params)
		return renderResponse(resp, err)
	})

	// ── Write ────────────────────────────────────────────────────────────

	s.AddTool(mcp.NewTool("execute_code",
		withFile(),
		mcp.WithDescription("Run JavaScript against the Figma Plugin API in the open file and return its result. "+
			"The code is the body of an async function with `figma` in scope: use `await`, and `return` a JSON-serialisable value "+
			"(node ids, names, counts — not nodes). This is the write tool: create/modify/delete nodes, components, variants, "+
			"styles, prototype reactions. Helpers are already in scope: snap(v, g=8) snaps to a grid, round2(v) rounds to 2 decimals, "+
			"boundsOf(n) returns rounded absolute bounds, loadFonts(...nodes) loads every font used by the given text nodes, "+
			"and layoutInfo(f) summarises auto-layout. Every response carries a changed manifest (created/removed node ids and names); "+
			"on error it names the failing user-code line with a code excerpt (compile errors included). "+
			"Set rollback=true to delete the nodes a failed run created. "+
			"Load fonts before editing text (await figma.loadFontAsync(...)); "+
			"use figma.getNodeByIdAsync and page.loadAsync(). Keep each call under ~25 s; split big jobs into several calls."),
		mcp.WithString("code",
			mcp.Required(),
			mcp.Description("Async function body, e.g. `const n = figma.createRectangle(); n.resize(100, 40); return n.id;`"),
		),
		mcp.WithBoolean("rollback",
			mcp.Description("On error, delete every node the run created (best effort)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		code, _ := req.Params.Arguments["code"].(string)
		if strings.TrimSpace(code) == "" {
			return mcp.NewToolResultError("code is required"), nil
		}
		params := map[string]interface{}{"code": code}
		if rollback, ok := req.Params.Arguments["rollback"].(bool); ok && rollback {
			params["rollback"] = true
		}
		resp, err := node.Send(ctx, fileArg(req), "execute_code", nil, params)
		return renderResponse(resp, err)
	})

	s.AddTool(mcp.NewTool("validate_layout",
		withFile(),
		mcp.WithDescription("Lint a subtree for the classic AI layout mistakes: overlapping siblings, children outside parent bounds, "+
			"inconsistent gaps, off-grid values, auto-layout overflow. Run after every write batch; fix findings instead of screenshot-guessing."),
		mcp.WithString("nodeId",
			mcp.Required(),
			mcp.Description("Root node ID to validate, colon format e.g. '4029:12345'"),
		),
		mcp.WithNumber("grid",
			mcp.Description("Grid size in px (default 8)"),
		),
		mcp.WithArray("checks",
			mcp.Description("Subset of checks to run: overlap, outOfBounds, spacing, grid, hug (default all)"),
		),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		nodeID, _ := req.Params.Arguments["nodeId"].(string)
		if strings.TrimSpace(nodeID) == "" {
			return mcp.NewToolResultError("nodeId is required"), nil
		}
		params := map[string]interface{}{"nodeId": nodeID}
		if grid, ok := req.Params.Arguments["grid"].(float64); ok && grid > 0 {
			params["grid"] = grid
		}
		if raw, ok := req.Params.Arguments["checks"].([]interface{}); ok && len(raw) > 0 {
			params["checks"] = raw
		}
		resp, err := node.Send(ctx, fileArg(req), "validate_layout", nil, params)
		return renderResponse(resp, err)
	})
}

// RegisterPrompts registers MCP prompts on the server.
func RegisterPrompts(s *server.MCPServer) {
	s.AddPrompt(mcp.NewPrompt("read_design_strategy",
		mcp.WithPromptDescription("Best practices for reading Figma designs with figma-mcp-go"),
	), func(ctx context.Context, req mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		return mcp.NewGetPromptResult(
			"Best practices for reading Figma designs",
			[]mcp.PromptMessage{
				mcp.NewPromptMessage(
					mcp.RoleUser,
					mcp.NewTextContent(`To effectively read a Figma design with figma-mcp-go:

0. Several files can be connected at once: call list_files, then select_file (or pass file on each call)
1. Start with get_metadata — understand file name, pages, and current page
2. Use get_design_context (depth=2) for a summary of the current selection or page
3. Drill into specific nodes with get_node or get_nodes_info (prefer batch over single calls)
4. For text-heavy components, use scan_text_nodes to collect all copy at once
5. Use scan_nodes_by_types to find all FRAME/COMPONENT/INSTANCE nodes in a subtree
6. Call get_styles and get_variable_defs once per session to understand the design system
7. Call get_screenshot last and only when visual confirmation is needed — it is expensive
8. Node IDs use colon format: 4029:12345 — never use hyphens
9. get_design_context is more token-efficient than get_document for large files
10. get_local_components lists all components — use with get_node to inspect internals`),
				),
			},
		), nil
	})

	s.AddPrompt(mcp.NewPrompt("write_design_strategy",
		mcp.WithPromptDescription("Best practices for WRITING/EDITING Figma designs with figma-mcp-go"),
	), func(ctx context.Context, req mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		return mcp.NewGetPromptResult(
			"Best practices for writing and editing Figma designs",
			[]mcp.PromptMessage{
				mcp.NewPromptMessage(
					mcp.RoleUser,
					mcp.NewTextContent(`To effectively write or edit a Figma design with figma-mcp-go:

0. Call list_files, then select_file before writing — never rely on the single-file default
1. Call get_layout_context(nodeId) BEFORE creating or moving anything near existing content:
   it tells you if the parent is auto layout (x/y writes are silently ignored there),
   sibling geometry, page grid, and free space
2. Prefer structure over coordinates: auto_layout to convert messy absolute groups;
   place_node (converts absolute→local AND snaps, default 8px) over manual x/y;
   align_nodes/distribute_nodes over hand-computed centering — never compute
   (parent.width-child.width)/2 yourself
3. Use set_text for ALL text edits — it loads every ranged font automatically;
   never set .characters directly without loading fonts first
4. execute_code: helpers are in scope (snap, round2, boundsOf, loadFonts, layoutInfo);
   return ids/names/counts; the response includes an automatic changed-manifest;
   rollback:true removes nodes created before a throw
5. After every write batch: validate_layout (overlaps, out-of-bounds, inconsistent gaps,
   off-grid, auto-layout overflow) and FIX the findings; screenshot (save_screenshots)
   only as final visual confirmation
6. Hygiene: name layers, remove probe nodes in the same call, keep Light/Dark + breakpoint
   twin frames in sync, edit main components (not instances) for design-system changes`),
				),
			},
		), nil
	})

	s.AddPrompt(mcp.NewPrompt("visual_review_strategy",
		mcp.WithPromptDescription("Protocol for visually reviewing a Figma design with figma-mcp-go: capture, review, fix, re-capture"),
	), func(ctx context.Context, req mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		return mcp.NewGetPromptResult(
			"Visual review protocol for Figma designs",
			[]mcp.PromptMessage{
				mcp.NewPromptMessage(
					mcp.RoleUser,
					mcp.NewTextContent(`Visual review protocol with figma-mcp-go:

0. list_files then select_file so the review targets the right file
1. Whole file? export_visual_review(outputDir) first — every frame of every page as
   ready-to-review tiled images (tall frames are sliced at 1600px with overlap so text
   stays legible). Single frame? capture_review(nodeId, .figma-shots/review-N.png)
   to disk and returns the layout context, text inventory, and checklist
2. Open the PNG and review EVERY checklist item, citing concrete nodes from the
   layout context and text inventory — never vague impressions
3. annotate_finding for each issue (severity honest: blocker / major / minor / nit)
4. Fix with the layout tools: place_node, align_nodes, distribute_nodes, auto_layout,
   set_text, apply_style
5. capture_review to a NEW path (.figma-shots/review-(N+1).png) and compare with the
   previous capture — every finding must be visibly fixed, nothing regressed
6. validate_layout(nodeId) must end with 0 warnings
7. Report a findings → fixes → evidence table (before/after capture paths)`),
				),
			},
		), nil
	})
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// withFile is the optional target-file argument every tool accepts.
func withFile() mcp.ToolOption {
	return mcp.WithString("file",
		mcp.Description("Optional target Figma file: connection id (e.g. 'c2') or file name. "+
			"Default: the file chosen with select_file, else the only connected file."),
	)
}

// fileArg reads the optional `file` argument.
func fileArg(req mcp.CallToolRequest) string {
	file, _ := req.Params.Arguments["file"].(string)
	return strings.TrimSpace(file)
}

// paramsFrom copies the named request arguments (when present) into a params
// map, forwarding nested objects and arrays untouched.
func paramsFrom(req mcp.CallToolRequest, names ...string) map[string]interface{} {
	params := map[string]interface{}{}
	for _, name := range names {
		if v, ok := req.Params.Arguments[name]; ok && v != nil {
			params[name] = v
		}
	}
	return params
}

// makeHandler creates a simple tool handler with no parameters.
func makeHandler(node *Node, command string, nodeIDs []string, params map[string]interface{}) func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		resp, err := node.Send(ctx, fileArg(req), command, nodeIDs, params)
		return renderResponse(resp, err)
	}
}

// renderResponse converts a BridgeResponse into an MCP tool result.
func renderResponse(resp BridgeResponse, err error) (*mcp.CallToolResult, error) {
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if resp.Error != "" {
		return mcp.NewToolResultError(resp.Error), nil
	}
	text, err := json.Marshal(resp.Data)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("marshal response: %v", err)), nil
	}
	return mcp.NewToolResultText(string(text)), nil
}

// toStringSlice converts []interface{} to []string.
func toStringSlice(raw []interface{}) []string {
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// ── save_screenshots ─────────────────────────────────────────────────────────

type saveItem struct {
	NodeID     string  `json:"nodeId"`
	OutputPath string  `json:"outputPath"`
	Format     string  `json:"format,omitempty"`
	Scale      float64 `json:"scale,omitempty"`
}

type saveResult struct {
	Index        int     `json:"index"`
	NodeID       string  `json:"nodeId"`
	NodeName     string  `json:"nodeName,omitempty"`
	OutputPath   string  `json:"outputPath"`
	Format       string  `json:"format,omitempty"`
	Width        float64 `json:"width,omitempty"`
	Height       float64 `json:"height,omitempty"`
	BytesWritten int     `json:"bytesWritten,omitempty"`
	Success      bool    `json:"success"`
	Error        string  `json:"error,omitempty"`
}

func executeSaveScreenshots(ctx context.Context, node *Node, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	rawItems, _ := req.Params.Arguments["items"].([]interface{})
	defaultFormat, _ := req.Params.Arguments["format"].(string)
	defaultScale, _ := req.Params.Arguments["scale"].(float64)

	workDir, err := os.Getwd()
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("getwd: %v", err)), nil
	}

	results := make([]saveResult, 0, len(rawItems))
	succeeded, failed := 0, 0

	for i, rawItem := range rawItems {
		item, err := parseSaveItem(rawItem)
		if err != nil {
			results = append(results, saveResult{Index: i, Error: err.Error()})
			failed++
			continue
		}

		r := saveScreenshotItem(ctx, node, fileArg(req), item, i, workDir, defaultFormat, defaultScale)
		results = append(results, r)
		if r.Success {
			succeeded++
		} else {
			failed++
		}
	}

	out, _ := json.Marshal(map[string]interface{}{
		"total":     len(results),
		"succeeded": succeeded,
		"failed":    failed,
		"hasErrors": failed > 0,
		"results":   results,
	})
	return mcp.NewToolResultText(string(out)), nil
}

func saveScreenshotItem(ctx context.Context, node *Node, file string, item saveItem, index int, workDir, defaultFormat string, defaultScale float64) saveResult {
	resolvedPath, err := resolveOutputPath(item.OutputPath, workDir)
	if err != nil {
		return saveResult{Index: index, NodeID: item.NodeID, OutputPath: item.OutputPath, Error: err.Error()}
	}

	format := coalesce(item.Format, defaultFormat)
	inferredFormat := inferFormat(resolvedPath)
	if format == "" {
		format = inferredFormat
	}
	if format == "" {
		format = "PNG"
	}
	if inferredFormat != "" && format != inferredFormat {
		return saveResult{Index: index, NodeID: item.NodeID, OutputPath: resolvedPath,
			Error: fmt.Sprintf("format %s conflicts with file extension %s", format, inferredFormat)}
	}

	scale := item.Scale
	if scale <= 0 {
		scale = defaultScale
	}

	params := map[string]interface{}{"format": format}
	if scale > 0 {
		params["scale"] = scale
	}

	resp, err := node.Send(ctx, file, "get_screenshot", []string{item.NodeID}, params)
	if err != nil {
		return saveResult{Index: index, NodeID: item.NodeID, OutputPath: resolvedPath, Error: err.Error()}
	}
	if resp.Error != "" {
		return saveResult{Index: index, NodeID: item.NodeID, OutputPath: resolvedPath, Error: resp.Error}
	}

	export, err := extractScreenshotExport(resp.Data)
	if err != nil {
		return saveResult{Index: index, NodeID: item.NodeID, OutputPath: resolvedPath, Error: err.Error()}
	}

	bytes, err := writeBase64(export.Base64, resolvedPath)
	if err != nil {
		return saveResult{Index: index, NodeID: item.NodeID, OutputPath: resolvedPath, Error: err.Error()}
	}

	return saveResult{
		Index:        index,
		NodeID:       export.NodeID,
		NodeName:     export.NodeName,
		OutputPath:   resolvedPath,
		Format:       format,
		Width:        export.Width,
		Height:       export.Height,
		BytesWritten: bytes,
		Success:      true,
	}
}

type screenshotExport struct {
	NodeID   string  `json:"nodeId"`
	NodeName string  `json:"nodeName"`
	Base64   string  `json:"base64"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
}

func extractScreenshotExport(data interface{}) (screenshotExport, error) {
	b, err := json.Marshal(data)
	if err != nil {
		return screenshotExport{}, err
	}
	var wrapper struct {
		Exports []screenshotExport `json:"exports"`
	}
	if err := json.Unmarshal(b, &wrapper); err != nil {
		return screenshotExport{}, err
	}
	if len(wrapper.Exports) == 0 {
		return screenshotExport{}, errors.New("no screenshot export returned by plugin")
	}
	return wrapper.Exports[0], nil
}

func writeBase64(b64, outputPath string) (int, error) {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return 0, fmt.Errorf("base64 decode: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0755); err != nil {
		return 0, fmt.Errorf("mkdir: %w", err)
	}
	f, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		if os.IsExist(err) {
			return 0, fmt.Errorf("file already exists at outputPath: %s", outputPath)
		}
		return 0, err
	}
	defer f.Close()
	n, err := f.Write(data)
	return n, err
}

func resolveOutputPath(outputPath, workDir string) (string, error) {
	resolved := filepath.Join(workDir, outputPath)
	rel, err := filepath.Rel(workDir, resolved)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", fmt.Errorf("outputPath must be inside the working directory: %s", workDir)
	}
	return resolved, nil
}

func inferFormat(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "PNG"
	case ".svg":
		return "SVG"
	case ".jpg", ".jpeg":
		return "JPG"
	case ".pdf":
		return "PDF"
	}
	return ""
}

func parseSaveItem(raw interface{}) (saveItem, error) {
	b, err := json.Marshal(raw)
	if err != nil {
		return saveItem{}, err
	}
	var item saveItem
	if err := json.Unmarshal(b, &item); err != nil {
		return saveItem{}, err
	}
	return item, nil
}

func coalesce(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
