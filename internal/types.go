package internal

// BridgeRequest is sent from the Go server to the Figma plugin over WebSocket.
type BridgeRequest struct {
	Type      string                 `json:"type"`
	RequestID string                 `json:"requestId"`
	NodeIDs   []string               `json:"nodeIds,omitempty"`
	Params    map[string]interface{} `json:"params,omitempty"`
}

// BridgeResponse is received from the Figma plugin over WebSocket.
type BridgeResponse struct {
	Type      string      `json:"type"`
	RequestID string      `json:"requestId"`
	Data      interface{} `json:"data,omitempty"`
	Error     string      `json:"error,omitempty"`
	// Progress fields — sent mid-operation for long-running commands
	Progress int    `json:"progress,omitempty"`
	Message  string `json:"message,omitempty"`
}

// RPCRequest is the wire format for follower → leader /rpc calls.
//
// File selects which connected Figma file handles the call: a connection id
// ("c3"), an exact file name, or a unique substring of one. Empty means "the
// only connected file" — with more than one connected it is an error, so a
// caller never writes into a file it did not choose.
type RPCRequest struct {
	Tool    string                 `json:"tool"`
	File    string                 `json:"file,omitempty"`
	NodeIDs []string               `json:"nodeIds,omitempty"`
	Params  map[string]interface{} `json:"params,omitempty"`
}

// FileInfo describes one plugin connection (one open Figma file running the plugin).
type FileInfo struct {
	ID          string `json:"id"`
	FileName    string `json:"fileName"`
	CurrentPage string `json:"currentPage,omitempty"`
	ConnectedAt string `json:"connectedAt"`
	Pending     int    `json:"pending"`
}

// RPCResponse is returned by the leader /rpc endpoint.
type RPCResponse struct {
	Data  interface{} `json:"data,omitempty"`
	Error string      `json:"error,omitempty"`
}

// Role represents the current role of this server process.
type Role int

const (
	RoleUnknown  Role = 0
	RoleLeader   Role = 1
	RoleFollower Role = 2
)
