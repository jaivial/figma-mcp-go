package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/mark3labs/mcp-go/server"

	"github.com/vkhanhqui/figma-mcp-go/internal"
)

// version is injected at build time:
// go build -ldflags "-X main.version=1.0.0" ./cmd/figma-mcp-go
var version = "dev"

var logger = log.New(os.Stderr, "", 0)

const defaultPort = 1994

// port is 1994 unless FIGMA_MCP_PORT says otherwise (the plugin must point at the same one).
func port() int {
	if v, err := strconv.Atoi(os.Getenv("FIGMA_MCP_PORT")); err == nil && v > 0 && v < 65536 {
		return v
	}
	return defaultPort
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// `figma-mcp-go leader`: own the port and the plugin connections without being an MCP
	// server. Run it as a service and every MCP process becomes a follower of it, so the
	// plugin connections survive agent sessions coming and going.
	if len(os.Args) > 1 && os.Args[1] == "leader" {
		runLeader(ctx)
		return
	}

	node := internal.NewNode(port())
	node.SetVersion(version)
	election := internal.NewElection(port(), node)

	if err := election.Start(ctx); err != nil {
		logger.Fatalf("election start: %v", err)
	}

	logger.Printf("Starting figma-mcp-go %s (role: %s)", version, node.RoleName())

	s := server.NewMCPServer("figma-mcp-go", version)
	internal.RegisterTools(s, node)
	internal.RegisterPrompts(s)

	go func() {
		<-ctx.Done()
		logger.Printf("Shutting down...")
		election.Stop()
		node.Stop()
	}()

	if err := server.ServeStdio(s); err != nil {
		logger.Fatalf("mcp serve: %v", err)
	}
}

func runLeader(ctx context.Context) {
	node := internal.NewNode(port())
	node.SetVersion(version)
	if err := node.BecomeLeader(); err != nil {
		logger.Fatalf("leader: cannot bind :%d: %v", port(), err)
	}
	logger.Printf("figma-mcp-go %s standalone leader on :%d", version, port())
	<-ctx.Done()
	logger.Printf("Shutting down...")
	node.Stop()
}
