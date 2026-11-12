package internal

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ── export_visual_review ─────────────────────────────────────────────────────
//
// One call produces every screenshot a vision review needs:
//  1. list_review_frames — top-level (or nested) reviewable frames on every page
//  2. get_screenshot per frame at a legibility-preserving auto scale
//  3. tile tall frames into readable chunks (models downscale >~1568px images
//     into mush; 1600px-tall tiles keep UI text legible)
//  4. write files under outputDir (relative to cwd, must not exist) — no base64
//     ever reaches the model context — and return a review manifest.

type reviewFrameInfo struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Type   string  `json:"type"`
	Depth  int     `json:"depth"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type reviewPageInfo struct {
	PageID   string            `json:"pageId"`
	PageName string            `json:"pageName"`
	Frames   []reviewFrameInfo `json:"frames"`
}

// autoScale picks an export scale from the frame WIDTH only — height is handled
// by tiling, never by shrinking (a shrunken tall page is unreadable).
func autoScale(w, h float64) float64 {
	switch {
	case w < 800:
		return 2
	case w <= 2400:
		return 1
	default:
		s := 1600 / w
		if s < 0.25 {
			s = 0.25
		}
		return s
	}
}

func sanitizeName(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	re := regexp.MustCompile(`[^a-z0-9]+`)
	s = re.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 48 {
		s = s[:48]
	}
	if s == "" {
		s = "frame"
	}
	return s
}

type visualReviewParams struct {
	OutputDir     string   `json:"outputDir"`
	Pages         []string `json:"pages"`
	Filter        string   `json:"filter"`
	IncludeNested bool     `json:"includeNested"`
	Scale         float64  `json:"scale"`         // 0 = auto
	Format        string   `json:"format"`        // JPG (default) | PNG
	TileMaxHeight float64  `json:"tileMaxHeight"` // design px, default 1600
	TileOverlap   float64  `json:"tileOverlap"`   // design px overlap, default 64
	MaxFrames     int      `json:"maxFrames"`     // default 200
	JPEGQuality   int      `json:"jpegQuality"`   // default 88
}

type reviewTile struct {
	Path   string `json:"path"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Tile   int    `json:"tile"`
	Tiles  int    `json:"tiles"`
}

type reviewFrameResult struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Type     string       `json:"type"`
	Page     string       `json:"page"`
	Scale    float64      `json:"scale"`
	Tiles    []reviewTile `json:"tiles"`
	Warnings []string     `json:"warnings,omitempty"`
}

// ExecuteVisualReview implements the export_visual_review tool.
func ExecuteVisualReview(ctx context.Context, node *Node, req map[string]interface{}) (interface{}, error) {
	var p visualReviewParams
	b, _ := json.Marshal(req)
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, fmt.Errorf("invalid arguments: %v", err)
	}
	if strings.TrimSpace(p.OutputDir) == "" {
		return nil, fmt.Errorf("outputDir is required (relative path, must not exist yet)")
	}
	if p.Format == "" {
		p.Format = "JPG"
	}
	if p.Format != "JPG" && p.Format != "PNG" {
		return nil, fmt.Errorf("format must be JPG or PNG, got %s", p.Format)
	}
	if p.TileMaxHeight == 0 {
		p.TileMaxHeight = 1600
	}
	if p.TileOverlap == 0 {
		p.TileOverlap = 64
	}
	if p.MaxFrames == 0 {
		p.MaxFrames = 200
	}
	if p.JPEGQuality == 0 {
		p.JPEGQuality = 88
	}

	workDir, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	rootPath, err := resolveOutputPath(p.OutputDir, workDir)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(rootPath); err == nil {
		return nil, fmt.Errorf("outputDir already exists: %s — pass a new directory", p.OutputDir)
	}

	// 1. Enumerate frames.
	params := map[string]interface{}{"includeNested": p.IncludeNested}
	if len(p.Pages) > 0 {
		params["pages"] = p.Pages
	}
	if p.Filter != "" {
		if _, err := regexp.Compile(p.Filter); err != nil {
			return nil, fmt.Errorf("filter: %v", err)
		}
		params["filter"] = p.Filter
	}
	resp, err := node.Send(ctx, fileFromMap(req), "list_review_frames", nil, params)
	if err != nil {
		return nil, err
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("%s", resp.Error)
	}
	pagesRaw, _ := json.Marshal(resp.Data)
	var pages struct {
		Pages []reviewPageInfo `json:"pages"`
	}
	if err := json.Unmarshal(pagesRaw, &pages); err != nil {
		return nil, fmt.Errorf("decode frame list: %v", err)
	}

	// 2. Export + tile + write.
	total := 0
	results := make([]reviewFrameResult, 0)
	truncated := false
	for _, pg := range pages.Pages {
		pageDir := filepath.Join(rootPath, fmt.Sprintf("%s", sanitizeName(pg.PageName)))
		for fi, f := range pg.Frames {
			if total >= p.MaxFrames {
				truncated = true
				break
			}
			scale := p.Scale
			if scale <= 0 {
				scale = autoScale(f.Width, f.Height)
			}
			img, err := exportFramePNG(ctx, node, fileFromMap(req), f.ID, scale)
			if err != nil {
				results = append(results, reviewFrameResult{ID: f.ID, Name: f.Name, Type: f.Type, Page: pg.PageName, Warnings: []string{err.Error()}})
				total++
				continue
			}
			tiles, err := writeTiles(img, pageDir, fmt.Sprintf("%03d-%s", fi+1, sanitizeName(f.Name)), p.Format, scale, p.TileMaxHeight, p.TileOverlap, p.JPEGQuality)
			if err != nil {
				results = append(results, reviewFrameResult{ID: f.ID, Name: f.Name, Type: f.Type, Page: pg.PageName, Warnings: []string{err.Error()}})
				total++
				continue
			}
			results = append(results, reviewFrameResult{ID: f.ID, Name: f.Name, Type: f.Type, Page: pg.PageName, Scale: scale, Tiles: tiles})
			total++
		}
		if truncated {
			break
		}
	}

	manifest := map[string]interface{}{
		"outputDir":   p.OutputDir,
		"totalFrames": total,
		"pages":       len(pages.Pages),
		"truncated":   truncated,
		"frames":      results,
		"checklist": []string{
			"baseline alignment across sibling texts",
			"consistent gaps (multiples of the grid)",
			"content overflowing any frame",
			"truncated or overlapping text",
			"visual hierarchy (sizes descend sensibly)",
			"text contrast on fills (WCAG AA)",
			"elements off the 8px grid",
			"optical centering of labels in buttons",
			"consistent corner radii",
			"empty or dead spacing",
		},
		"note": "Review every image against the checklist; report issues with annotate_finding (severity), fix with the layout tools, then re-run export_visual_review into a NEW directory and compare.",
	}
	return manifest, nil
}

// exportFramePNG exports one frame and decodes it. The plugin always exports
// lossless PNG; conversion to JPG happens per tile.
func exportFramePNG(ctx context.Context, node *Node, file, frameID string, scale float64) (image.Image, error) {
	resp, err := node.Send(ctx, file, "get_screenshot", []string{frameID}, map[string]interface{}{"format": "PNG", "scale": scale})
	if err != nil {
		return nil, err
	}
	if resp.Error != "" {
		return nil, fmt.Errorf("%s", resp.Error)
	}
	raw, _ := json.Marshal(resp.Data)
	var wrapper struct {
		Exports []struct {
			Base64 string `json:"base64"`
		} `json:"exports"`
	}
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		return nil, err
	}
	if len(wrapper.Exports) == 0 {
		return nil, fmt.Errorf("no export returned")
	}
	data, err := base64.StdEncoding.DecodeString(wrapper.Exports[0].Base64)
	if err != nil {
		return nil, err
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("png decode: %v", err)
	}
	return img, nil
}

// writeTiles crops img into <=tileMaxHeight (design px) vertical chunks and
// writes them under dir. Returns the tile manifest entries.
func writeTiles(img image.Image, dir, base, format string, scale, tileMax, overlap float64, quality int) ([]reviewTile, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	w := img.Bounds().Dx()
	h := img.Bounds().Dy()
	tilePx := int(tileMax * scale)
	overlapPx := int(overlap * scale)
	tiles := []reviewTile{}
	if tilePx <= 0 || h <= tilePx {
		path, err := writeImage(img, filepath.Join(dir, base+ext(format)), format, quality)
		if err != nil {
			return nil, err
		}
		tiles = append(tiles, reviewTile{Path: path, Width: w, Height: h, Tile: 1, Tiles: 1})
		return tiles, nil
	}
	step := tilePx - overlapPx
	if step <= 0 {
		step = tilePx / 2
	}
	n := (h - overlapPx + step - 1) / step
	if n < 1 {
		n = 1
	}
	for i := 0; i < n; i++ {
		y0 := i * step
		y1 := y0 + tilePx
		if i == n-1 {
			y1 = h // last tile always reaches the bottom
		}
		if y1 > h {
			y1 = h
		}
		if y0 >= y1 {
			break
		}
		sub, ok := img.(interface {
			SubImage(r image.Rectangle) image.Image
		})
		if !ok {
			return nil, fmt.Errorf("cannot crop export")
		}
		crop := sub.SubImage(image.Rect(0, y0, w, y1))
		name := fmt.Sprintf("%s-t%dof%d", base, i+1, n)
		path, err := writeImage(crop, filepath.Join(dir, name+ext(format)), format, quality)
		if err != nil {
			return nil, err
		}
		tiles = append(tiles, reviewTile{Path: path, Width: w, Height: y1 - y0, Tile: i + 1, Tiles: n})
	}
	return tiles, nil
}

func writeImage(img image.Image, path, format string, quality int) (string, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if format == "PNG" {
		if err := png.Encode(f, img); err != nil {
			return "", err
		}
	} else {
		if err := jpeg.Encode(f, img, &jpeg.Options{Quality: quality}); err != nil {
			return "", err
		}
	}
	return path, nil
}

func ext(format string) string {
	if format == "PNG" {
		return ".png"
	}
	return ".jpg"
}

func fileFromMap(req map[string]interface{}) string {
	if v, ok := req["file"].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}
