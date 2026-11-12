package internal

import (
	"fmt"
	"regexp"
)

// nodeIDPattern matches Figma node IDs: colon-separated integer pairs e.g.
// "4029:12345". Instance nodes chain their parent IDs with ";" and may carry an
// "I" prefix on each pair, e.g. "I80:165050;80:162650" — the exact form the
// plugin serializer returns for children of an instance.
var nodeIDPattern = regexp.MustCompile(`^I?\d+:\d+(?:;I?\d+:\d+)*$`)

// ValidNodeID reports whether s is a valid Figma node ID.
func ValidNodeID(s string) bool {
	return nodeIDPattern.MatchString(s)
}

// ValidateRPC validates an incoming RPC request against the tool's expected
// input shape. Returns an error string on failure, empty string if valid.
func ValidateRPC(tool string, nodeIDs []string, params map[string]interface{}) string {
	switch tool {
	case "get_node":
		if len(nodeIDs) == 0 || nodeIDs[0] == "" {
			return "nodeId is required"
		}
		if !ValidNodeID(nodeIDs[0]) {
			return fmt.Sprintf("nodeId must use colon format e.g. 4029:12345 (instance form: I80:165050;80:162650), got: %s", nodeIDs[0])
		}

	case "get_nodes_info":
		if len(nodeIDs) == 0 {
			return "nodeIds is required and must not be empty"
		}
		for _, id := range nodeIDs {
			if !ValidNodeID(id) {
				return fmt.Sprintf("invalid nodeId: %s — must use colon format e.g. 4029:12345 (instance form: I80:165050;80:162650)", id)
			}
		}

	case "get_screenshot":
		for _, id := range nodeIDs {
			if !ValidNodeID(id) {
				return fmt.Sprintf("invalid nodeId: %s — must use colon format e.g. 4029:12345 (instance form: I80:165050;80:162650)", id)
			}
		}
		if format, ok := params["format"].(string); ok {
			if !validExportFormat(format) {
				return fmt.Sprintf("format must be PNG, SVG, JPG, or PDF, got: %s", format)
			}
		}

	case "save_screenshots":
		items, ok := params["items"]
		if !ok {
			return "items is required"
		}
		itemList, ok := items.([]interface{})
		if !ok || len(itemList) == 0 {
			return "items must be a non-empty array"
		}
		for i, item := range itemList {
			m, ok := item.(map[string]interface{})
			if !ok {
				return fmt.Sprintf("items[%d] must be an object", i)
			}
			nodeID, _ := m["nodeId"].(string)
			if !ValidNodeID(nodeID) {
				return fmt.Sprintf("items[%d].nodeId must use colon format e.g. 4029:12345 (instance form: I80:165050;80:162650)", i)
			}
			outputPath, _ := m["outputPath"].(string)
			if outputPath == "" {
				return fmt.Sprintf("items[%d].outputPath is required", i)
			}
		}

	case "get_design_context":
		if depth, ok := params["depth"].(float64); ok {
			if depth < 0 {
				return "depth must be a non-negative number"
			}
		}

	case "scan_text_nodes", "scan_nodes_by_types":
		nodeID, _ := params["nodeId"].(string)
		if nodeID == "" {
			return "nodeId is required"
		}
		if !ValidNodeID(nodeID) {
			return fmt.Sprintf("nodeId must use colon format e.g. 4029:12345 (instance form: I80:165050;80:162650), got: %s", nodeID)
		}
		if tool == "scan_nodes_by_types" {
			types, ok := params["types"].([]interface{})
			if !ok || len(types) == 0 {
				return "types must be a non-empty array"
			}
		}
	}

	return ""
}

func validExportFormat(f string) bool {
	switch f {
	case "PNG", "SVG", "JPG", "PDF":
		return true
	}
	return false
}
