package internal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

var bridgeLogger = log.New(os.Stderr, "[bridge] ", 0)

const (
	// requestTimeout is the inactivity window of one request (a progress update resets it).
	requestTimeout = 30 * time.Second
	// progressTimeout is the window granted after each progress update.
	progressTimeout = 60 * time.Second
	// identifyTimeout bounds the get_metadata call that names a fresh connection.
	identifyTimeout = 5 * time.Second
)

// pendingEntry holds the response channel and inactivity timer for an in-flight request.
//
// Ownership rule: whoever removes the entry from Bridge.pending (under the lock) is the
// only one allowed to deliver on ch or close it. That keeps the timer, the read loop,
// a disconnect and Close from ever sending on a closed channel.
type pendingEntry struct {
	ch     chan BridgeResponse
	timer  *time.Timer
	connID string
}

// pluginConn is one Figma file running the plugin.
type pluginConn struct {
	id          string
	seq         int64
	ws          *websocket.Conn
	connectedAt time.Time
	// Guarded by Bridge.mu. Filled by identify() right after connecting (the plugin
	// answers get_metadata), and refreshed by Files(refresh=true) to catch renames.
	fileName    string
	currentPage string
}

// Bridge manages the WebSocket connections from the Figma plugin — one per open file
// running it — and matches responses to pending requests via request IDs.
//
// Before multi-file support a new connection REPLACED the previous one, so two files
// could never be driven at once. Now every connection is kept and each request is
// routed to one file (see resolve): by connection id, exact file name or a unique
// substring of it. With several files connected and no target the request fails
// instead of guessing, so an agent never writes into a file it did not choose.
type Bridge struct {
	mu      sync.RWMutex
	conns   map[string]*pluginConn
	pending map[string]*pendingEntry
	counter atomic.Int64
	connSeq atomic.Int64
}

// NewBridge creates a ready-to-use Bridge.
func NewBridge() *Bridge {
	return &Bridge{
		conns:   make(map[string]*pluginConn),
		pending: make(map[string]*pendingEntry),
	}
}

// HandleUpgrade upgrades an HTTP request to a WebSocket connection and registers it
// as one more connected file.
func (b *Bridge) HandleUpgrade(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // plugin connects from localhost
	})
	if err != nil {
		bridgeLogger.Printf("upgrade error: %v", err)
		return
	}

	// Raise the read limit to 100 MB — Figma documents can be large.
	// Default is 32 KiB which causes "read limited at 32769 bytes" disconnects.
	conn.SetReadLimit(100 * 1024 * 1024)

	seq := b.connSeq.Add(1)
	pc := &pluginConn{id: "c" + strconv.FormatInt(seq, 10), seq: seq, ws: conn, connectedAt: time.Now()}

	b.mu.Lock()
	b.conns[pc.id] = pc
	total := len(b.conns)
	b.mu.Unlock()

	bridgeLogger.Printf("plugin connected id=%s from %s (%d file(s) connected)", pc.id, r.RemoteAddr, total)
	go b.readLoop(pc)
	// Works with any plugin version: get_metadata has always been there.
	go b.identify(context.Background(), pc)
}

// identify asks the plugin which file it runs in.
func (b *Bridge) identify(ctx context.Context, pc *pluginConn) {
	ctx, cancel := context.WithTimeout(ctx, identifyTimeout)
	defer cancel()

	resp, err := b.sendTo(ctx, pc, "get_metadata", nil, nil)
	if err != nil || resp.Error != "" {
		bridgeLogger.Printf("identify %s failed: err=%v plugin=%s", pc.id, err, resp.Error)
		return
	}

	m, _ := resp.Data.(map[string]interface{})
	name, _ := m["fileName"].(string)
	page, _ := m["currentPageName"].(string)

	b.mu.Lock()
	if name != "" {
		pc.fileName = name
	}
	pc.currentPage = page
	b.mu.Unlock()
	bridgeLogger.Printf("identified %s as %q (page %q)", pc.id, name, page)
}

// readLoop reads messages from one plugin connection and resolves its pending requests.
func (b *Bridge) readLoop(pc *pluginConn) {
	defer func() {
		b.mu.Lock()
		delete(b.conns, pc.id)
		var orphaned []*pendingEntry
		for id, entry := range b.pending {
			if entry.connID == pc.id {
				delete(b.pending, id)
				orphaned = append(orphaned, entry)
			}
		}
		total := len(b.conns)
		name := pc.fileName
		b.mu.Unlock()

		// Fail fast instead of waiting for the 30 s timeout of a file that is gone.
		for _, entry := range orphaned {
			entry.timer.Stop()
			entry.ch <- BridgeResponse{Error: "plugin disconnected before answering (file closed or plugin stopped)"}
		}
		bridgeLogger.Printf("plugin disconnected id=%s %q (%d file(s) connected, %d request(s) failed)",
			pc.id, name, total, len(orphaned))
	}()

	ctx := context.Background()
	for {
		var resp BridgeResponse
		if err := wsjson.Read(ctx, pc.ws, &resp); err != nil {
			if !errors.Is(err, context.Canceled) {
				bridgeLogger.Printf("read error id=%s: %v", pc.id, err)
			}
			return
		}

		// Handle progress updates — extend timeout, do not resolve.
		if resp.Progress > 0 && resp.RequestID != "" {
			b.mu.RLock()
			entry, ok := b.pending[resp.RequestID]
			b.mu.RUnlock()
			if ok {
				entry.timer.Reset(progressTimeout)
				bridgeLogger.Printf("progress %s: %d%% %s", resp.RequestID, resp.Progress, resp.Message)
			} else {
				bridgeLogger.Printf("progress %s: %d%% %s (no pending entry — already resolved or timed out)", resp.RequestID, resp.Progress, resp.Message)
			}
			continue
		}

		if resp.RequestID == "" {
			bridgeLogger.Printf("received message with empty requestID from %s — ignored", pc.id)
			continue
		}

		b.mu.Lock()
		entry, ok := b.pending[resp.RequestID]
		if ok {
			delete(b.pending, resp.RequestID)
		}
		b.mu.Unlock()

		if ok {
			if resp.Error != "" {
				bridgeLogger.Printf("← %s %s error: %s", pc.id, resp.RequestID, resp.Error)
			} else {
				bridgeLogger.Printf("← %s %s ok", pc.id, resp.RequestID)
			}
			entry.timer.Stop()
			entry.ch <- resp
		} else {
			bridgeLogger.Printf("← %s %s received but no pending entry (timed out?)", pc.id, resp.RequestID)
		}
	}
}

// Send routes a request to the file selected by target (see resolve) and waits for the response.
func (b *Bridge) Send(ctx context.Context, target, requestType string, nodeIDs []string, params map[string]interface{}) (BridgeResponse, error) {
	pc, err := b.resolve(ctx, target)
	if err != nil {
		return BridgeResponse{}, err
	}
	return b.sendTo(ctx, pc, requestType, nodeIDs, params)
}

// sendTo sends a request to one plugin connection and waits for the response.
func (b *Bridge) sendTo(ctx context.Context, pc *pluginConn, requestType string, nodeIDs []string, params map[string]interface{}) (BridgeResponse, error) {
	requestID := b.nextID()
	req := BridgeRequest{
		Type:      requestType,
		RequestID: requestID,
		NodeIDs:   nodeIDs,
		Params:    params,
	}

	ch := make(chan BridgeResponse, 1)
	entry := &pendingEntry{ch: ch, connID: pc.id}

	// Register before sending to avoid a race where the response
	// arrives before we store the channel.
	entry.timer = time.AfterFunc(requestTimeout, func() {
		b.mu.Lock()
		_, owned := b.pending[requestID]
		delete(b.pending, requestID)
		b.mu.Unlock()
		if owned {
			bridgeLogger.Printf("→ %s %s %s timed out", pc.id, requestID, requestType)
			close(ch)
		}
	})

	b.mu.Lock()
	b.pending[requestID] = entry
	b.mu.Unlock()

	bridgeLogger.Printf("→ %s %s %s nodeIDs=%v", pc.id, requestID, requestType, nodeIDs)
	start := time.Now()

	if err := wsjson.Write(ctx, pc.ws, req); err != nil {
		entry.timer.Stop()
		b.mu.Lock()
		delete(b.pending, requestID)
		b.mu.Unlock()
		bridgeLogger.Printf("→ %s %s %s write error: %v", pc.id, requestID, requestType, err)
		return BridgeResponse{}, fmt.Errorf("send: %w", err)
	}

	select {
	case resp, ok := <-ch:
		if !ok {
			return BridgeResponse{}, errors.New("request timed out")
		}
		bridgeLogger.Printf("→ %s %s %s completed in %dms", pc.id, requestID, requestType, time.Since(start).Milliseconds())
		return resp, nil
	case <-ctx.Done():
		entry.timer.Stop()
		b.mu.Lock()
		delete(b.pending, requestID)
		b.mu.Unlock()
		bridgeLogger.Printf("→ %s %s %s context cancelled: %v", pc.id, requestID, requestType, ctx.Err())
		return BridgeResponse{}, ctx.Err()
	}
}

// resolve picks the connection a request goes to.
//
//   - empty target: the only connected file; with several it is an error.
//   - a connection id ("c3").
//   - an exact file name (case-insensitive) or, failing that, a unique substring of one.
func (b *Bridge) resolve(ctx context.Context, target string) (*pluginConn, error) {
	target = strings.TrimSpace(target)
	files := b.list()
	if len(files) == 0 {
		return nil, errors.New("plugin not connected: open a Figma file and run the figma-mcp-go plugin in it")
	}

	if target == "" {
		if len(files) == 1 {
			return b.conn(files[0].ID)
		}
		return nil, fmt.Errorf("%d Figma files are connected (%s): pass `file` (connection id or file name) or call select_file first",
			len(files), describe(files))
	}

	for _, f := range files {
		if f.ID == target {
			return b.conn(f.ID)
		}
	}

	// A connection that just arrived may not be named yet.
	for _, f := range files {
		if f.FileName == "" {
			if pc, err := b.conn(f.ID); err == nil {
				b.identify(ctx, pc)
			}
		}
	}
	files = b.list()

	matches := matchFiles(files, target)
	switch len(matches) {
	case 1:
		return b.conn(matches[0].ID)
	case 0:
		return nil, fmt.Errorf("no connected Figma file matches %q; connected: %s", target, describe(files))
	default:
		return nil, fmt.Errorf("%q matches %d connected files (%s): use the connection id", target, len(matches), describe(matches))
	}
}

// matchFiles returns the exact (case-insensitive) name matches or, if none, the substring ones.
func matchFiles(files []FileInfo, target string) []FileInfo {
	want := strings.ToLower(target)
	var exact, partial []FileInfo
	for _, f := range files {
		name := strings.ToLower(f.FileName)
		switch {
		case name == want:
			exact = append(exact, f)
		case name != "" && strings.Contains(name, want):
			partial = append(partial, f)
		}
	}
	if len(exact) > 0 {
		return exact
	}
	return partial
}

func describe(files []FileInfo) string {
	parts := make([]string, 0, len(files))
	for _, f := range files {
		name := f.FileName
		if name == "" {
			name = "(identifying…)"
		}
		parts = append(parts, fmt.Sprintf("%s %q", f.ID, name))
	}
	return strings.Join(parts, ", ")
}

func (b *Bridge) conn(id string) (*pluginConn, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	pc, ok := b.conns[id]
	if !ok {
		return nil, fmt.Errorf("connection %s is gone", id)
	}
	return pc, nil
}

// list snapshots the connections, oldest first.
func (b *Bridge) list() []FileInfo {
	b.mu.RLock()
	defer b.mu.RUnlock()

	pending := map[string]int{}
	for _, entry := range b.pending {
		pending[entry.connID]++
	}

	conns := make([]*pluginConn, 0, len(b.conns))
	for _, pc := range b.conns {
		conns = append(conns, pc)
	}
	sort.Slice(conns, func(i, j int) bool { return conns[i].seq < conns[j].seq })

	files := make([]FileInfo, 0, len(conns))
	for _, pc := range conns {
		files = append(files, FileInfo{
			ID:          pc.id,
			FileName:    pc.fileName,
			CurrentPage: pc.currentPage,
			ConnectedAt: pc.connectedAt.Format(time.RFC3339),
			Pending:     pending[pc.id],
		})
	}
	return files
}

// Files lists the connected files. refresh re-asks every plugin for its file name and
// current page first (a file renamed after connecting shows its new name).
func (b *Bridge) Files(ctx context.Context, refresh bool) []FileInfo {
	if refresh {
		b.mu.RLock()
		conns := make([]*pluginConn, 0, len(b.conns))
		for _, pc := range b.conns {
			conns = append(conns, pc)
		}
		b.mu.RUnlock()

		var wg sync.WaitGroup
		for _, pc := range conns {
			wg.Add(1)
			go func(pc *pluginConn) {
				defer wg.Done()
				b.identify(ctx, pc)
			}(pc)
		}
		wg.Wait()
	}
	return b.list()
}

// Close shuts down the bridge, rejecting all pending requests.
func (b *Bridge) Close() {
	b.mu.Lock()
	for id, entry := range b.pending {
		entry.timer.Stop()
		close(entry.ch)
		delete(b.pending, id)
	}
	conns := make([]*pluginConn, 0, len(b.conns))
	for id, pc := range b.conns {
		conns = append(conns, pc)
		delete(b.conns, id)
	}
	b.mu.Unlock()

	// Outside the lock: the close handshake can take a moment, and each read loop
	// takes the lock on its way out.
	for _, pc := range conns {
		pc.ws.Close(websocket.StatusNormalClosure, "bridge closed")
	}
}

// nextID generates a request ID in the format req-HHMMSS-N.
func (b *Bridge) nextID() string {
	n := b.counter.Add(1)
	now := time.Now()
	return fmt.Sprintf("req-%02d%02d%02d-%d",
		now.Hour(), now.Minute(), now.Second(), n)
}

// IsConnected reports whether at least one plugin is connected.
func (b *Bridge) IsConnected() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.conns) > 0
}

// MarshalJSON is used when logging — avoid printing full conn objects.
func (b *Bridge) MarshalJSON() ([]byte, error) {
	b.mu.RLock()
	connected := len(b.conns)
	pending := len(b.pending)
	b.mu.RUnlock()
	return json.Marshal(map[string]interface{}{
		"connected": connected,
		"pending":   pending,
	})
}
