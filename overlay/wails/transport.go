// transport.go  -  the overlay's JS<->Lua channel, active when the addon
// launches the exe with --pid <inst>.
//
// Lua side is a file mailbox: this process writes in/q-*.json requests,
// the addon consumes them and batches outbound messages into
// out/m-*.jsonl (watched via ReadDirectoryChangesW). Both directions
// carry the same message protocol as xport.lua:
//
//	page -> Lua   {t:'req', id, method, path, body}
//	              {t:'sub'}                     subscribe + snapshot
//	Lua -> page   {t:'res', id, status, ctype, body, enc?}
//	              {t:'sse', e, d}               pushed events
//	              {t:'ping'}                    mailbox keepalive
//
// Page side has two faces: the Assets handler answers /api/* by relaying
// to the backend (native <img>/fetch loads need a completed response
// anyway) and serves addon ui/ for everything else — plus a real
// ws://127.0.0.1:0 socket that carries {t:'sse'} frames and accepts
// 'req'/'sub' frames, because SSE can't stream through the assetserver's
// buffered writer. The bridge worker discovers it at /api/xport/info.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/coder/websocket"
)

// --------------------------------------------------------------- args

type xportArgs struct {
	inst string // instance key  -  the mailbox dir is keyed on it.
	// The addon sends the game pid when ffi is present, otherwise
	// 'p<bound_port>'  -  either way it's unique per game instance.
	ui string // addon ui/ dir for the asset handler (default: <exe>/../ui)
}

func xportArgsFrom(args []string) xportArgs {
	var xa xportArgs
	for i := 0; i < len(args); i++ {
		a := args[i]
		take := func() string {
			if j := strings.IndexByte(a, '='); j >= 0 {
				return a[j+1:]
			}
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch {
		case a == "--pid" || strings.HasPrefix(a, "--pid="),
			a == "--inst" || strings.HasPrefix(a, "--inst="):
			xa.inst = take()
		case a == "--ui" || strings.HasPrefix(a, "--ui="):
			xa.ui = take()
		}
	}
	return xa
}

// ------------------------------------------------------- shared plumbing

type xMsg = map[string]interface{}

// xp is the active backend  -  nil when the exe was launched without
// --pid (plain browser/probed mode), so every path below stays inert.
var xp xport

type xport interface {
	send(m xMsg) error          // enqueue an outbound message
	recv() <-chan xMsg          // inbound messages (res/sse/ping)
	alive() bool                // Lua attached recently
}

var (
	xpReqSeq  atomic.Int64
	xpPending sync.Map // int64 -> func(xMsg)  -  response sink per in-flight req
)

// xpDispatch fans inbound messages out: res → the waiting request's
// sink (an http waiter or a websocket conn), sse → every events socket.
func xpDispatch(recv <-chan xMsg) {
	for m := range recv {
		switch m["t"] {
		case "res":
			id, _ := m["id"].(float64)
			if fn, ok := xpPending.LoadAndDelete(int64(id)); ok {
				fn.(func(xMsg))(m)
			} else {
				// late/duplicate reply — worth seeing: the first sign of
				// a mailbox eat is res messages with no waiter
				log.Printf("xport: res id=%d with no waiter", int64(id))
			}
		case "sse":
			wsBroadcast(m)
		}
	}
}

// xpCall is one request/response round-trip through the backend  - 
// the message-protocol equivalent of a fetch.
func xpCall(method, target string, body []byte) (xMsg, error) {
	id := xpReqSeq.Add(1)
	ch := make(chan xMsg, 1)
	xpPending.Store(id, func(m xMsg) {
		select {
		case ch <- m:
		default:
		}
	})
	defer xpPending.Delete(id)
	m := xMsg{"t": "req", "id": id, "method": method, "path": target}
	if len(body) > 0 {
		m["body"] = string(body)
	}
	if err := xp.send(m); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		return r, nil
	case <-time.After(30 * time.Second):
		log.Printf("xport: req timeout %s %s", method, target)
		return nil, errors.New("xport: request timeout")
	}
}

// resBody decodes a res message  -  hex flag marks binary payloads
// (icons, map DATs) that can't ride inside a JSON string.
func resBody(m xMsg) ([]byte, error) {
	s, _ := m["body"].(string)
	if m["enc"] == "hex" {
		return hex.DecodeString(s)
	}
	return []byte(s), nil
}

// xpGet fetches an API path over the backend  -  used by watchBackend in
// non-http modes (status/spawn polling works through the same routes).
// A dead backend fails fast so the misses counter still works.
func xpGet(p string) ([]byte, error) {
	if xp == nil || !xp.alive() {
		return nil, errors.New("xport: backend down")
	}
	m, err := xpCall("GET", "/"+strings.TrimPrefix(p, "/"), nil)
	if err != nil {
		return nil, err
	}
	if st, _ := m["status"].(float64); st != 200 {
		b, _ := resBody(m)
		return nil, fmt.Errorf("xport %s: %d %s", p, int(st), b)
	}
	return resBody(m)
}

var (
	pCreateFileW           = kernel32.NewProc("CreateFileW")
	pReadDirectoryChangesW = kernel32.NewProc("ReadDirectoryChangesW")
	pCreateMutexW          = kernel32.NewProc("CreateMutexW")
)

// xportClaim takes an inst-scoped named mutex and reports whether THIS
// process now owns the backend. Every relaunch (//xicompanion overlay,
// panel autospawn, addon reload) runs main() up to app.Run before the
// Wails SingleInstance check kills it — an always-on backend let a
// doomed second instance drainOut() and DELETE out/ files that were
// addressed to the surviving process, silently eating res/sse messages.
// With the mutex, only the first process per inst starts the backend;
// losers skip it and die on the app lock moments later.
var xportMutex uintptr

func xportClaim(inst string) bool {
	name, err := syscall.UTF16PtrFromString(`Local\xicompanion-xport-` + inst)
	if err != nil {
		return true
	}
	h, _, errno := pCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return true // mutex failed — don't take the backend down over it
	}
	if errno == syscall.ERROR_ALREADY_EXISTS {
		pCloseHandle.Call(h)
		return false
	}
	xportMutex = h
	return true
}

// ------------------------------------------------------- mailbox backend
//
// data/ipc/<pid>/in:  q-*.json request files we write (tmp+rename)
// data/ipc/<pid>/out: m-*.jsonl message batches the addon writes

type mailboxBackend struct {
	base     string // .../data/ipc/<pid>
	sendC    chan xMsg
	recvC    chan xMsg
	lastSeen atomic.Int64
	seq      atomic.Uint64
	boot     time.Time
	mu       sync.Mutex // serialize in/ file writes
}

func newMailboxBackend(inst string, dataDir string) *mailboxBackend {
	return &mailboxBackend{
		base:  filepath.Join(dataDir, "ipc", inst),
		sendC: make(chan xMsg, 512),
		recvC: make(chan xMsg, 512),
		boot:  time.Now(),
	}
}

func (b *mailboxBackend) in() string  { return filepath.Join(b.base, "in") }
func (b *mailboxBackend) out() string { return filepath.Join(b.base, "out") }

func (b *mailboxBackend) send(m xMsg) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	seq := b.seq.Add(1)
	tmp := filepath.Join(b.in(), fmt.Sprintf("q-%08d.tmp", seq))
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp,
		filepath.Join(b.in(), fmt.Sprintf("q-%08d.json", seq))); err != nil {
		return err
	}
	log.Printf("mailbox: in q-%08d t=%v id=%v", seq, m["t"], m["id"])
	return nil
}
func (b *mailboxBackend) recv() <-chan xMsg { return b.recvC }
// no session to hold  -  "alive" is recent outbound files. First minute
// is a grace period so the addon's startup silence doesn't read as dead.
func (b *mailboxBackend) alive() bool {
	ls := b.lastSeen.Load()
	if ls == 0 {
		return time.Since(b.boot) < time.Minute
	}
	return time.Now().Unix()-ls < 30
}

// drainOut consumes every batch file the addon wrote, oldest first.
// Writers rename tmp->jsonl so a listed file is always complete.
func (b *mailboxBackend) drainOut() {
	ents, err := os.ReadDir(b.out())
	if err != nil {
		return
	}
	for _, e := range ents {
		name := e.Name()
		if !strings.HasPrefix(name, "m-") ||
			!(strings.HasSuffix(name, ".jsonl") ||
				strings.HasSuffix(name, ".json")) {
			continue
		}
		full := filepath.Join(b.out(), name)
		body, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		os.Remove(full)
		b.lastSeen.Store(time.Now().Unix())
		n := 0
		for _, line := range bytes.Split(body, []byte("\n")) {
			if len(line) == 0 {
				continue
			}
			var m xMsg
			if json.Unmarshal(line, &m) == nil {
				b.recvC <- m
				n++
			}
		}
		// every drained file is a delete — log it, since a stray
		// second instance draining here is what eats messages
		log.Printf("mailbox: out/%s -> %d msgs", name, n)
	}
}

// watchLoop blocks on ReadDirectoryChangesW (kernel delivers file
// events  -  no scan interval), with a slow periodic sweep covering the
// (rare) notification-buffer overflow case.
func (b *mailboxBackend) watchLoop() {
	b.drainOut()
	go func() {
		for range time.Tick(2 * time.Second) {
			b.drainOut()
		}
	}()
	d16, err := syscall.UTF16PtrFromString(b.out())
	if err != nil {
		return
	}
	h, _, _ := pCreateFileW.Call(
		uintptr(unsafe.Pointer(d16)),
		0x1,                    // FILE_LIST_DIRECTORY
		0x7,                    // SHARE_READ|WRITE|DELETE
		0, 3 /*OPEN_EXISTING*/,
		0x02000000, // FILE_FLAG_BACKUP_SEMANTICS
		0)
	if h == ^uintptr(0) || h == 0 {
		log.Printf("mailbox: dir watch failed on %s", b.out())
		return
	}
	defer pCloseHandle.Call(h)
	buf := make([]byte, 8192)
	for {
		var n uint32
		r, _, _ := pReadDirectoryChangesW.Call(h,
			uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)),
			0, 0x1F, // all FILE_NOTIFY_CHANGE_* filters
			uintptr(unsafe.Pointer(&n)), 0, 0)
		if r == 0 {
			return // dir gone  -  addon stopped
		}
		b.drainOut()
	}
}

func (b *mailboxBackend) start() {
	for _, d := range []string{b.base, b.in(), b.out()} {
		os.MkdirAll(d, 0o755)
	}
	go b.watchLoop()
}

// ------------------------------------------------- http handler (Assets)
//
// Serves the addon ui/ directory plus a /api proxy over the backend  - 
// same surface the Lua socket server exposes, so the frontend can't
// tell which transport is underneath.

type xpSharedCall struct {
	done chan struct{}
	m    xMsg
	err  error
}

var xpInflight sync.Map // GET path -> *xpSharedCall (dedupe like bridge.worker)

func apiHandler(uiDir string) http.Handler {
	fs := http.FileServer(http.Dir(uiDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case p == "/api/xport/info":
			// capability probe — the bridge worker learns the events
			// socket here. A plain completed GET, so the assetserver's
			// buffered writer is fine.
			if wsAddr == "" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"events":"ws://`+wsAddr+`/events"}`)
		case p == "/api/xport/log":
			// page-side debug logging — lands in overlay.log next to the
			// Go traces (the SharedWorker has no chrome.webview, so this
			// is its only channel). Completed POST — assetserver-safe.
			body, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
			log.Printf("page: %s", strings.TrimSpace(string(body)))
			w.WriteHeader(http.StatusNoContent)
		case strings.HasPrefix(p, "/api/"):
			xpProxy(w, r)
		default:
			// SPA fallback  -  client routes (/tracker, /journal) serve
			// index.html; real files pass through to the fs
			if !strings.Contains(path.Base(p), ".") {
				r2 := new(http.Request)
				*r2 = *r
				r2.URL = new(url.URL)
				*r2.URL = *r.URL
				r2.URL.Path = "/"
				fs.ServeHTTP(w, r2)
				return
			}
			fs.ServeHTTP(w, r)
		}
	})
}

func xpProxy(w http.ResponseWriter, r *http.Request) {
	target := r.URL.RequestURI()
	// identical in-flight GETs share one backend call  -  the bridge
	// worker did this for multi-window requests (itemmeta is ~1MB)
	if r.Method == http.MethodGet {
		v, loaded := xpInflight.LoadOrStore(target,
			&xpSharedCall{done: make(chan struct{})})
		sc := v.(*xpSharedCall)
		if loaded {
			<-sc.done
			writeRes(w, sc.m, sc.err)
			return
		}
		defer xpInflight.Delete(target)
		defer close(sc.done)
		body, _ := io.ReadAll(r.Body)
		sc.m, sc.err = xpCall(r.Method, target, body)
		writeRes(w, sc.m, sc.err)
		return
	}
	body, _ := io.ReadAll(r.Body)
	m, err := xpCall(r.Method, target, body)
	writeRes(w, m, err)
}

func writeRes(w http.ResponseWriter, m xMsg, err error) {
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	body, err := resBody(m)
	if err != nil {
		http.Error(w, "bad body encoding", http.StatusBadGateway)
		return
	}
	if ct, ok := m["ctype"].(string); ok && ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	st, _ := m["status"].(float64)
	if st == 0 {
		st = 200
	}
	w.WriteHeader(int(st))
	w.Write(body)
}

// ------------------------------------------------- websocket events socket
//
// SSE cannot stream through the assetserver on Windows: the response
// writer buffers the whole body and only hands it to WebView2 when the
// handler returns, so a held /api/events delivers zero bytes forever.
// A real ws://127.0.0.1 socket is outside the assetserver entirely —
// no port to pick either, since :0 lets the kernel choose. Frames are
// the backend's sse messages verbatim ({t:'sse',e,d}) — the bridge
// worker's existing dispatch consumes them unchanged.

var (
	wsAddr   string
	wsConns  = map[*websocket.Conn]struct{}{}
	wsConnsM sync.Mutex
)

func wsStart() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	wsAddr = ln.Addr().String()
	mux := http.NewServeMux()
	mux.HandleFunc("/events", wsEvents)
	go func() { _ = http.Serve(ln, mux) }()
	return nil
}

func wsEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		// CORS-RFC1918 (private-network-access) preflight — Chromium may
		// send one before a ws:// upgrade when the page origin isn't an
		// ip literal; answering it keeps ws://127.0.0.1 reachable from
		// the wails.localhost assetserver origin
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	log.Printf("ws: upgrade %s %s origin=%q upgrade=%q",
		r.Method, r.URL, r.Header.Get("Origin"), r.Header.Get("Upgrade"))
	// localhost-bound like the Lua socket server (whose CORS is *), so
	// no origin gate — a hostile page could already hit 17890 the same way
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("ws: accept failed: %v", err)
		return
	}
	defer c.CloseNow()
	wsConnsM.Lock()
	wsConns[c] = struct{}{}
	nconns := len(wsConns)
	wsConnsM.Unlock()
	log.Printf("ws: conn open (%d total)", nconns)
	defer func() {
		wsConnsM.Lock()
		delete(wsConns, c)
		nconns := len(wsConns)
		wsConnsM.Unlock()
		log.Printf("ws: conn closed (%d left)", nconns)
	}()
	// a fresh conn gets the snapshot replay, same as /api/events did
	if xp != nil {
		_ = xp.send(xMsg{"t": "sub"})
	}
	// inbound frames: {t:'sub'} asks for another snapshot; {t:'req'}
	// rides the same backend dispatch as an assetserver /api call. The
	// client's id is remapped into backend id space so its res routes
	// back to THIS conn — a bare passthrough would collide with ids
	// xpReqSeq hands to http requests.
	for {
		_, data, err := c.Read(r.Context())
		if err != nil {
			log.Printf("ws: read ended: %v", err)
			return
		}
		var m xMsg
		if json.Unmarshal(data, &m) != nil {
			log.Printf("ws: unparseable frame (%d bytes)", len(data))
			continue
		}
		switch m["t"] {
		case "sub":
			log.Printf("ws: sub")
			if xp != nil {
				_ = xp.send(m)
			}
		case "req":
			wid := m["id"]
			id := xpReqSeq.Add(1)
			m["id"] = float64(id)
			log.Printf("ws: req %v %v (wid=%v -> id=%d)",
				m["method"], m["path"], wid, id)
			xpPending.Store(id, func(r xMsg) {
				r["id"] = wid
				out, err := json.Marshal(r)
				if err != nil {
					return
				}
				ctx, cancel := context.WithTimeout(
					context.Background(), 5*time.Second)
				defer cancel()
				_ = c.Write(ctx, websocket.MessageText, out)
			})
			if xp != nil {
				_ = xp.send(m)
			}
		}
	}
}

// wsBroadcast writes one backend message to every open conn. xpDispatch
// is the only caller (single goroutine), so per-conn writes stay
// serialized. A wedged conn eats at most one 5s write deadline before
// being dropped — it must not stall 'res' routing for everyone else.
func wsBroadcast(m xMsg) {
	data, err := json.Marshal(m)
	if err != nil {
		return
	}
	wsConnsM.Lock()
	defer wsConnsM.Unlock()
	for c := range wsConns {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := c.Write(ctx, websocket.MessageText, data)
		cancel()
		if err != nil {
			log.Printf("ws: broadcast write failed, dropping conn: %v", err)
			c.CloseNow()
			delete(wsConns, c)
		}
	}
}
