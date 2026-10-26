package internal

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"
)

var nodeLogger = log.New(os.Stderr, "[node] ", 0)

// Node dynamically routes MCP tool calls to either the Leader bridge
// or the Follower HTTP proxy, depending on the current role.
//
// Each MCP process (one per agent session) keeps its own selected file: set once with
// select_file, it is the target of every call that does not pass `file` explicitly.
// That is what lets several agents drive different files through one leader.
type Node struct {
	mu       sync.RWMutex
	role     Role
	port     int
	leader   *Leader
	follower *Follower
	version  string
	selected string
}

// NewNode creates a Node in the Unknown role.
func NewNode(port int) *Node {
	return &Node{
		port:     port,
		role:     RoleUnknown,
		follower: NewFollower(fmt.Sprintf("http://localhost:%d", port)),
	}
}

// SetVersion records the build version (served by the leader's /ping).
func (n *Node) SetVersion(version string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.version = version
}

// Select sets this process's default target file ("" clears it).
func (n *Node) Select(file string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.selected = file
}

// Selected returns this process's default target file.
func (n *Node) Selected() string {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.selected
}

// Role returns the current role.
func (n *Node) Role() Role {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.role
}

// RoleName returns a human-readable role string.
func (n *Node) RoleName() string {
	switch n.Role() {
	case RoleLeader:
		return "LEADER"
	case RoleFollower:
		return "FOLLOWER"
	default:
		return "UNKNOWN"
	}
}

// Send routes a request to the appropriate backend. An empty file falls back to the
// selected one (select_file); still empty means "the only connected file".
func (n *Node) Send(ctx context.Context, file, tool string, nodeIDs []string, params map[string]interface{}) (BridgeResponse, error) {
	n.mu.RLock()
	role := n.role
	leader := n.leader
	if file == "" {
		file = n.selected
	}
	n.mu.RUnlock()

	nodeLogger.Printf("tool=%s role=%s file=%q nodeIDs=%v", tool, n.RoleName(), file, nodeIDs)

	if role == RoleLeader && leader != nil {
		return leader.GetBridge().Send(ctx, file, tool, nodeIDs, params)
	}
	return n.follower.Send(ctx, file, tool, nodeIDs, params)
}

// Files lists the connected files, from the bridge or through the leader.
func (n *Node) Files(ctx context.Context) ([]FileInfo, error) {
	n.mu.RLock()
	role := n.role
	leader := n.leader
	n.mu.RUnlock()

	if role == RoleLeader && leader != nil {
		return leader.GetBridge().Files(ctx, true), nil
	}
	return n.follower.Files(ctx)
}

// BecomeLeader attempts to bind the port and transition to Leader role.
// Returns an error if the port is already in use.
func (n *Node) BecomeLeader() error {
	n.mu.Lock()
	defer n.mu.Unlock()

	if n.role == RoleLeader {
		return nil
	}

	leader := NewLeader(n.port, n.version)
	if err := leader.Start(); err != nil {
		return err
	}

	n.leader = leader
	n.role = RoleLeader
	nodeLogger.Printf("became LEADER")
	return nil
}

// BecomeFollower transitions to Follower role, stopping the leader if running.
func (n *Node) BecomeFollower() {
	n.mu.Lock()
	defer n.mu.Unlock()

	if n.role == RoleFollower {
		return
	}

	if n.leader != nil {
		n.leader.Stop()
		n.leader = nil
	}

	n.role = RoleFollower
	nodeLogger.Printf("became FOLLOWER")
}

// Stop shuts down the node regardless of role.
func (n *Node) Stop() {
	n.mu.Lock()
	defer n.mu.Unlock()

	if n.leader != nil {
		n.leader.Stop()
		n.leader = nil
	}
	n.role = RoleUnknown
}
