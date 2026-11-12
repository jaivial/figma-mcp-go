package internal

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
)

// ── capture_review ─────────────────────────────────────────────────────────
//
// One call bundles everything a vision-capable agent needs to review a node:
// a PNG on disk, a trimmed layout context, the text inventory, and a checklist.

// Steps of the capture pipeline, named after the plugin commands they run so a
// failing step is obvious in the error message.
const (
	stepScreenshot = "get_screenshot"
	stepSavePNG    = "save_png"
	stepLayout     = "get_layout_context"
	stepTexts      = "scan_text_nodes"
)

// Caps that keep the result readable: 20 siblings, 40 text nodes, 80 runes of
// text per node.
const (
	maxReviewSiblings = 20
	maxReviewTexts    = 40
	maxReviewTextLen  = 80
)

// reviewLayoutContext is the trimmed get_layout_context payload kept in the
// capture_review result: only the fields a reviewer needs.
type reviewLayoutContext struct {
	NodeID   string                   `json:"nodeId"`
	Name     string                   `json:"name,omitempty"`
	Type     string                   `json:"type,omitempty"`
	Layout   map[string]interface{}   `json:"layout,omitempty"`
	Parent   *reviewParentLayout      `json:"parent,omitempty"`
	Siblings []map[string]interface{} `json:"siblings,omitempty"`
	Grid     []interface{}            `json:"grid,omitempty"`
	Hints    []string                 `json:"hints,omitempty"`
}

// reviewParentLayout keeps the parent's layout plus just enough identity to
// reference it; bounds and other extras are dropped.
type reviewParentLayout struct {
	ID         string                 `json:"id,omitempty"`
	Name       string                 `json:"name,omitempty"`
	Type       string                 `json:"type,omitempty"`
	Layout     map[string]interface{} `json:"layout,omitempty"`
	ChildCount int                    `json:"childCount,omitempty"`
}

// reviewTextEntry is one TEXT node from scan_text_nodes, truncated.
type reviewTextEntry struct {
	ID         string      `json:"id"`
	Name       string      `json:"name,omitempty"`
	Characters string      `json:"characters,omitempty"`
	FontSize   interface{} `json:"fontSize,omitempty"`
}

// ExecuteCaptureReview implements the capture_review tool: export a node as a
// PNG to disk and return its layout context, text inventory, and a visual
// review checklist in a single result.
func ExecuteCaptureReview(ctx context.Context, node *Node, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	nodeID, _ := req.Params.Arguments["nodeId"].(string)
	nodeID = strings.TrimSpace(nodeID)
	if nodeID == "" {
		return mcp.NewToolResultError("nodeId is required"), nil
	}
	outputPath, _ := req.Params.Arguments["outputPath"].(string)
	outputPath = strings.TrimSpace(outputPath)
	if outputPath == "" {
		return mcp.NewToolResultError("outputPath is required"), nil
	}
	if filepath.IsAbs(outputPath) {
		return mcp.NewToolResultError(fmt.Sprintf("outputPath must be relative to the working directory: %s", outputPath)), nil
	}

	scale := 1.0
	if s, ok := req.Params.Arguments["scale"].(float64); ok {
		if s <= 0 {
			return mcp.NewToolResultError("scale must be > 0"), nil
		}
		scale = s
	}
	contextDepth := 2.0
	if d, ok := req.Params.Arguments["contextDepth"].(float64); ok {
		if d <= 0 {
			return mcp.NewToolResultError("contextDepth must be > 0"), nil
		}
		contextDepth = d
	}

	// (a) Export the node as a PNG and write it to disk (never over an existing file).
	workDir, err := os.Getwd()
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("getwd: %v", err)), nil
	}
	resolvedPath, err := resolveOutputPath(outputPath, workDir)
	if err != nil {
		return mcp.NewToolResultError(stepError(stepSavePNG, err)), nil
	}
	if inferred := inferFormat(resolvedPath); inferred != "" && inferred != "PNG" {
		return mcp.NewToolResultError(stepError(stepSavePNG, fmt.Errorf("outputPath extension implies %s, but capture_review always exports PNG", inferred))), nil
	}

	file := fileArg(req)
	shotData, err := sendCaptureStep(ctx, node, file, stepScreenshot, []string{nodeID},
		map[string]interface{}{"format": "PNG", "scale": scale})
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	export, err := extractScreenshotExport(shotData)
	if err != nil {
		return mcp.NewToolResultError(stepError(stepScreenshot, err)), nil
	}
	if _, err := writeBase64(export.Base64, resolvedPath); err != nil {
		return mcp.NewToolResultError(stepError(stepSavePNG, err)), nil
	}

	// (b) Layout context, trimmed to what a review needs.
	layoutData, err := sendCaptureStep(ctx, node, file, stepLayout, nil,
		map[string]interface{}{"nodeId": nodeID, "contextDepth": contextDepth})
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	layoutContext, err := trimReviewLayoutContext(layoutData)
	if err != nil {
		return mcp.NewToolResultError(stepError(stepLayout, err)), nil
	}

	// (c) Text inventory of the subtree.
	textData, err := sendCaptureStep(ctx, node, file, stepTexts, nil,
		map[string]interface{}{"nodeId": nodeID})
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	texts, textCount, err := collectReviewTexts(textData)
	if err != nil {
		return mcp.NewToolResultError(stepError(stepTexts, err)), nil
	}

	// (d) Checklist and the assembled result.
	out, _ := json.Marshal(map[string]interface{}{
		"outputPath":    resolvedPath,
		"width":         export.Width,
		"height":        export.Height,
		"layoutContext": layoutContext,
		"texts":         texts,
		"textCount":     textCount,
		"checklist":     reviewChecklist(),
		"note":          "open outputPath and review against the checklist; annotate findings with annotate_finding, fix with the layout tools, then re-run capture_review to a NEW path and compare",
	})
	return mcp.NewToolResultText(string(out)), nil
}

// sendCaptureStep runs one plugin command and reports failures with the step
// name, so a failed capture_review names exactly where it stopped.
func sendCaptureStep(ctx context.Context, node *Node, file, step string, nodeIDs []string, params map[string]interface{}) (interface{}, error) {
	resp, err := node.Send(ctx, file, step, nodeIDs, params)
	if err != nil {
		return nil, fmt.Errorf("step %s: %w", step, err)
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("step %s: %s", step, resp.Error)
	}
	return resp.Data, nil
}

func stepError(step string, err error) string {
	return fmt.Sprintf("step %s: %v", step, err)
}

// trimReviewLayoutContext decodes the plugin response keeping only layout,
// parent.layout, siblings (capped), hints, and grid.
func trimReviewLayoutContext(data interface{}) (reviewLayoutContext, error) {
	b, err := json.Marshal(data)
	if err != nil {
		return reviewLayoutContext{}, fmt.Errorf("marshal layout context: %w", err)
	}
	var trimmed reviewLayoutContext
	if err := json.Unmarshal(b, &trimmed); err != nil {
		return reviewLayoutContext{}, fmt.Errorf("unmarshal layout context: %w", err)
	}
	if len(trimmed.Siblings) > maxReviewSiblings {
		trimmed.Siblings = trimmed.Siblings[:maxReviewSiblings]
	}
	return trimmed, nil
}

// collectReviewTexts caps the text inventory at maxReviewTexts entries and
// truncates characters; textCount stays the full scan count.
func collectReviewTexts(data interface{}) ([]reviewTextEntry, int, error) {
	b, err := json.Marshal(data)
	if err != nil {
		return nil, 0, fmt.Errorf("marshal text scan: %w", err)
	}
	var raw struct {
		Count     int `json:"count"`
		TextNodes []struct {
			ID         string      `json:"id"`
			Name       string      `json:"name"`
			Characters string      `json:"characters"`
			FontSize   interface{} `json:"fontSize"`
		} `json:"textNodes"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, 0, fmt.Errorf("unmarshal text scan: %w", err)
	}
	count := raw.Count
	if count == 0 {
		count = len(raw.TextNodes)
	}
	texts := make([]reviewTextEntry, 0, len(raw.TextNodes))
	for _, t := range raw.TextNodes {
		if len(texts) == maxReviewTexts {
			break
		}
		texts = append(texts, reviewTextEntry{
			ID:         t.ID,
			Name:       t.Name,
			Characters: truncateRunes(t.Characters, maxReviewTextLen),
			FontSize:   t.FontSize,
		})
	}
	return texts, count, nil
}

// truncateRunes cuts s to max runes, marking the cut with an ellipsis.
func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}

// reviewChecklist is the visual review protocol every capture points at.
func reviewChecklist() []string {
	return []string{
		"baseline alignment across sibling texts",
		"consistent gaps (multiples of the grid)",
		"content overflowing any frame",
		"truncated/overlapping text",
		"visual hierarchy (sizes descend sensibly)",
		"color contrast for text on fills",
		"elements off the 8px grid",
		"optical centering of labels in buttons",
		"consistent corner radii",
		"empty/dead spacing",
	}
}
