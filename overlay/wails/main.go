// xic-overlay — Wails v3 (WebView2) shell for the XI Companion addon.
//
// Thin window wrapper: the Lua addon's HTTP server stays the backend, this
// process just finds it (probing 127.0.0.1:17890..17899 for /api/status,
// or $GSUI_PORT if set) and shows it in a frameless always-on-top window.
//
// The window has two modes:
//
//	fab  — a small always-on-top floating button (--fab starts this way).
//	       The addon spawns it on load; it survives //xic hide/close/Esc.
//	full — the whole XI Companion UI.
//
// The page itself decides what to render from the viewport size, and talks
// to the shell through Wails' raw message channel — "wails:drag" /
// "wails:resize:<cursor>" are routed from any main-frame origin, while
// "xic:expand|collapse|quit" land in RawMessageHandler.
//
// Build:
//
//	go build -tags production -ldflags "-s -w -H windowsgui" \
//	    -o ../../addon/xic/overlay/xic-overlay.exe .
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const windowTitle = "XI Companion"

const (
	// the fab is a 2×2 cluster of four 48px buttons + gaps
	fabW, fabH    = 112, 112
	fullW, fullH  = 1100, 760
	minW, minH    = 860, 520
	fabEdgeMargin = 24
)

// ---------------------------------------------------------------- win32

var (
	user32  = syscall.NewLazyDLL("user32.dll")
	shell32 = syscall.NewLazyDLL("shell32.dll")

	pShellExecute = shell32.NewProc("ShellExecuteW")

	pIsWindowVisible     = user32.NewProc("IsWindowVisible")
	pIsIconic            = user32.NewProc("IsIconic")
	pShowWindow          = user32.NewProc("ShowWindow")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	pSetWindowPos        = user32.NewProc("SetWindowPos")
	pGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	pGetWindowLongPtr    = user32.NewProc("GetWindowLongPtrW")
	pSetWindowLongPtr    = user32.NewProc("SetWindowLongPtrW")
	pPostMessage         = user32.NewProc("PostMessageW")
	pReleaseCapture      = user32.NewProc("ReleaseCapture")
	pGetAsyncKeyState    = user32.NewProc("GetAsyncKeyState")

	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	pFindWindowW               = user32.NewProc("FindWindowW")
	pEnumWindows               = user32.NewProc("EnumWindows")
	pGetWindowThreadProcessId  = user32.NewProc("GetWindowThreadProcessId")
	pAttachThreadInput         = user32.NewProc("AttachThreadInput")
	pGetCurrentThreadId        = kernel32.NewProc("GetCurrentThreadId")
	pOpenProcess               = kernel32.NewProc("OpenProcess")
	pCloseHandle               = kernel32.NewProc("CloseHandle")
	pQueryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
)

const (
	swRestore     = 9
	hwndTopmost   = ^uintptr(0) // (HWND)-1
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010
	swpFrameChg   = 0x0020
	swpShowWindow = 0x0040

	gwlExStyle      = ^uint32(19) // GWL_EXSTYLE (-20)
	gwlpOwner       = ^uint32(7)  // GWLP_HWNDPARENT (-8)
	wsExLayered     = 0x00080000
	wsExNoActivate  = 0x08000000
	wsExTransparent = 0x00000020

	wmNcLButtonDown = 0x00A1
	vkLButton       = 0x01
	htCaption       = 2
)

// edge hit-test codes for WM_NCLBUTTONDOWN (same map Wails uses internally)
var edgeHT = map[string]uintptr{
	"n-resize":  12, // HTTOP
	"ne-resize": 14, // HTTOPRIGHT
	"e-resize":  11, // HTRIGHT
	"se-resize": 17, // HTBOTTOMRIGHT
	"s-resize":  15, // HTBOTTOM
	"sw-resize": 16, // HTBOTTOMLEFT
	"w-resize":  10, // HTLEFT
	"nw-resize": 13, // HTTOPLEFT
}

// hwnd of the overlay window once NativeWindow() reports it
var windowHwnd atomic.Uintptr

// -------------------------------------------------- game focus return

// findFFXIWindow locates the game window: pol.exe registers its frame as
// the "FFXiClass" window class, with a pol.exe image-name scan as the
// fallback (multiple clients → first hit wins).
func findFFXIWindow() uintptr {
	cls, err := syscall.UTF16PtrFromString("FFXiClass")
	if err == nil {
		if h, _, _ := pFindWindowW.Call(uintptr(unsafe.Pointer(cls)), 0); h != 0 {
			return h
		}
		log.Print("refocus: FFXiClass lookup failed, scanning for pol.exe")
	}
	var found uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		if found != 0 {
			return 0
		}
		if v, _, _ := pIsWindowVisible.Call(hwnd); v == 0 {
			return 1
		}
		var pid uint32
		pGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid == 0 {
			return 1
		}
		h, _, _ := pOpenProcess.Call(0x1000 /* QUERY_LIMITED_INFORMATION */, 0, uintptr(pid))
		if h == 0 {
			return 1
		}
		defer pCloseHandle.Call(h)
		var buf [260]uint16
		n := uint32(len(buf))
		if r, _, _ := pQueryFullProcessImageName.Call(h, 0,
			uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r == 0 {
			return 1
		}
		if strings.EqualFold(filepath.Base(syscall.UTF16ToString(buf[:n])), "pol.exe") {
			found = hwnd
			return 0
		}
		return 1
	})
	pEnumWindows.Call(cb, 0)
	if found == 0 {
		log.Print("refocus: no pol.exe window found either")
	}
	return found
}

// ourHwnd reports whether hwnd is one of this process's overlay windows —
// main, tooltip, or a spawned tab.
func ourHwnd(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	if hwnd == windowHwnd.Load() || hwnd == tooltipHwnd.Load() {
		return true
	}
	spawnMu.Lock()
	defer spawnMu.Unlock()
	for _, sw := range spawned {
		if sw.NativeWindow() != nil && hwndOf(sw) == hwnd {
			return true
		}
	}
	return false
}

// refocusGame hands keyboard focus back to FFXI after an overlay
// interaction — only when an overlay window actually holds foreground,
// so a hide event while the user is in another app steals nothing.
// The click already made our window foreground, which grants us
// SetForegroundWindow rights — AttachThreadInput to the game's thread
// widens that grant for the borderline cases.
func refocusGame() {
	hwnd := findFFXIWindow()
	if hwnd == 0 {
		return
	}
	fg, _, _ := pGetForegroundWindow.Call()
	if fg == hwnd {
		return
	}
	if !ourHwnd(fg) {
		log.Printf("refocus: fg=%#x isn't an overlay window, skipping", fg)
		return
	}
	// attach to the FOREGROUND window's thread (not the game's) — that
	// inherits its SetForegroundWindow rights for this call
	cur, _, _ := pGetCurrentThreadId.Call()
	var pid uint32
	fgTid, _, _ := pGetWindowThreadProcessId.Call(fg, uintptr(unsafe.Pointer(&pid)))
	pAttachThreadInput.Call(cur, fgTid, 1)
	r, _, _ := pSetForegroundWindow.Call(hwnd)
	pAttachThreadInput.Call(cur, fgTid, 0)
	log.Printf("refocus: fg=%#x ffxi=%#x setfg=%v", fg, hwnd, r != 0)
}

// refocusAfterActivate covers window creation/activation — Windows hands
// a new/shown window foreground, which drops the game's keyboard focus.
// Spawn bursts (login: fab + tracker + macrobar + cooldowns) activate
// several windows a second or more apart — a WebView2's activation lands
// well after its NewWithOptions returns — so a single per-call poll can
// fire before the *last* window grabs focus. Calls instead share one
// watcher: every call extends its deadline, and the watcher hands focus
// back on EVERY overlay activation until the burst settles.
var (
	fgWatchUntil atomic.Int64 // UnixNano deadline
	fgWatcherOn  atomic.Bool
)

func refocusAfterActivate() {
	fgWatchUntil.Store(time.Now().Add(3 * time.Second).UnixNano())
	if fgWatcherOn.CompareAndSwap(false, true) {
		go func() {
			defer fgWatcherOn.Store(false)
			for time.Now().UnixNano() < fgWatchUntil.Load() {
				fg, _, _ := pGetForegroundWindow.Call()
				if fg != 0 && ourHwnd(fg) {
					refocusGame()
				}
				time.Sleep(60 * time.Millisecond)
			}
		}()
	}
}

// openURL hands a page-requested link to the system browser — the
// webview itself must never navigate off the addon origin.
func openURL(raw string) {
	if !strings.HasPrefix(raw, "https://") && !strings.HasPrefix(raw, "http://") {
		log.Printf("open: rejected %q", raw)
		return
	}
	url, err1 := syscall.UTF16PtrFromString(raw)
	verb, err2 := syscall.UTF16PtrFromString("open")
	if err1 != nil || err2 != nil {
		return
	}
	pShellExecute.Call(0, uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(url)), 0, 0, 5 /* SW_SHOW */)
}

// startMoveLoop posts WM_NCLBUTTONDOWN to enter the native move/size
// modal loop — the same thing Wails' wails:drag/resize handler does, but
// gated on the physical button: the page posts on mousedown and a click
// can release before this goroutine runs; posting the message with the
// button already up parks the window in the modal loop holding global
// mouse capture, which eats every click until Esc cancels it.
//
// The work must run on the UI thread via InvokeSync (same as Wails'
// HandleMessage → InvokeSync → startDrag): ReleaseCapture only releases
// capture owned by the *calling* thread, and the webview child's mouse
// capture lives on the UI thread. Called off-thread it's a silent no-op —
// the posted WM_NCLBUTTONDOWN then hits DefWindowProc while the child
// still holds capture and the modal move loop never takes over.
// RawMessageHandler is invoked on a goroutine, so InvokeSync from here
// cannot deadlock.
func startMoveLoop(hwnd uintptr, hitTest uintptr) {
	if hwnd == 0 || hitTest == 0 {
		return
	}
	application.InvokeSync(func() {
		v, _, _ := pGetAsyncKeyState.Call(vkLButton)
		if v&0x8000 == 0 {
			return // click, not a drag — nothing to track
		}
		pReleaseCapture.Call()
		pPostMessage.Call(hwnd, wmNcLButtonDown, hitTest, 0)
		go watchDragEnd()
	})
}

// watchDragEnd waits out the modal move/size loop — the button going up
// is the loop's exit — then returns focus to the game. A DOM mouseup
// never reaches the page during the modal loop, so this is the only
// drag-end signal the shell can act on.
func watchDragEnd() {
	for i := 0; i < 2400; i++ { // ~2min cap so an odd state can't leak it
		if v, _, _ := pGetAsyncKeyState.Call(vkLButton); v&0x8000 == 0 {
			refocusGame()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// setClickable toggles WS_EX_TRANSPARENT: off (peek) the tooltip window
// lets clicks fall through to whatever's beneath it, on (pinned) the
// action buttons and drag region receive input. WS_EX_NOACTIVATE is
// held either way so the tooltip can never steal foreground.
func setClickable(hwnd uintptr, clickable bool) {
	if hwnd == 0 {
		return
	}
	// GWL_EXSTYLE is -20 as a signed int32 — the API only reads the low
	// 32 bits, so the pre-inverted uint32 constant carries it fine
	exIdx := uintptr(gwlExStyle)
	cur, _, _ := pGetWindowLongPtr.Call(hwnd, exIdx)
	next := cur | wsExNoActivate | wsExLayered
	if clickable {
		next &^= wsExTransparent
	} else {
		next |= wsExTransparent
	}
	if next != cur {
		pSetWindowLongPtr.Call(hwnd, exIdx, next)
		pSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0,
			swpNoMove|swpNoSize|swpNoActivate|swpNoZOrder|swpFrameChg)
	}
}

func isIconic(hwnd uintptr) bool {
	r, _, _ := pIsIconic.Call(hwnd)
	return r != 0
}

func isVisible(hwnd uintptr) bool {
	r, _, _ := pIsWindowVisible.Call(hwnd)
	return r != 0
}

func foreground() uintptr {
	r, _, _ := pGetForegroundWindow.Call()
	return r
}

func screenSize() (int, int) {
	cx, _, _ := pGetSystemMetrics.Call(0) // SM_CXSCREEN
	cy, _, _ := pGetSystemMetrics.Call(1) // SM_CYSCREEN
	return int(cx), int(cy)
}

// keepPinned re-asserts topmost z-order and un-minimizes — frameless
// tool windows get buried by the game asserting its own topmost, and
// auto-minimized when the game takes focus. Skips re-pinning while our
// window is foreground so window-level popups keep their activation.
// store receives the hwnd (main window & tooltip need it for
// SetForegroundWindow / exstyle flips); spawned windows pass nil.
// Exits when the window is destroyed.
func keepPinned(w *application.WebviewWindow, store *atomic.Uintptr) {
	var hwnd uintptr
	for tries := 0; hwnd == 0; tries++ {
		if p := w.NativeWindow(); p != nil {
			hwnd = uintptr(p)
		}
		if tries > 100 {
			return // window never materialized (failed spawn)
		}
		time.Sleep(150 * time.Millisecond)
	}
	if store != nil {
		store.Store(hwnd)
	}

	for {
		if w.NativeWindow() == nil {
			return // destroyed
		}
		time.Sleep(2 * time.Second)
		if !isVisible(hwnd) {
			continue
		}
		if isIconic(hwnd) {
			pShowWindow.Call(hwnd, swRestore)
			continue
		}
		if foreground() == hwnd {
			continue
		}
		pSetWindowPos.Call(hwnd, hwndTopmost, 0, 0, 0, 0,
			swpNoMove|swpNoSize|swpNoActivate|swpShowWindow)
	}
}

// --------------------------------------------------------- geometry state

type rect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

type geometry struct {
	Fab  *rect `json:"fab,omitempty"`
	Full *rect `json:"full,omitempty"`
	// per-detached-tab bounds, keyed by route path ("/chat" etc.)
	Windows map[string]*rect `json:"windows,omitempty"`
}

var (
	geom     geometry
	geomPath string
	// geom, fabMode and the win.Position/Size reads below are touched by the
	// tracker goroutine and the expand/collapse/quit handlers alike.
	geomMu sync.Mutex
)

func loadGeometry() {
	b, err := os.ReadFile(geomPath)
	if err == nil {
		json.Unmarshal(b, &geom)
	}
	// drop zero-size rects persisted by mid-teardown polls (older builds
	// could write {0,0,0,0} over a closing window's real bounds)
	for k, r := range geom.Windows {
		if r == nil || r.W <= 0 || r.H <= 0 {
			delete(geom.Windows, k)
		}
	}
}

func saveGeometry() {
	geomMu.Lock()
	b, err := json.Marshal(geom)
	geomMu.Unlock()
	if err == nil {
		os.WriteFile(geomPath, b, 0o644)
	}
}

func geomSnapshot() geometry {
	geomMu.Lock()
	defer geomMu.Unlock()
	return geom
}

func setFabGeom(r rect) {
	geomMu.Lock()
	geom.Fab = &r
	geomMu.Unlock()
}

func setFullGeom(r rect) {
	geomMu.Lock()
	geom.Full = &r
	geomMu.Unlock()
}

func setWindowGeom(key string, r rect) {
	geomMu.Lock()
	if geom.Windows == nil {
		geom.Windows = map[string]*rect{}
	}
	geom.Windows[key] = &r
	geomMu.Unlock()
}

// defaultFabPos parks the button in the bottom-right corner of the
// primary monitor.
func defaultFabPos() (int, int) {
	cx, cy := screenSize()
	return cx - fabW - fabEdgeMargin, cy - fabH - fabEdgeMargin
}

// ---------------------------------------------------------- port probing

// probeTarget blocks until the addon server answers /api/status on one of
// the candidate ports (the addon binds the first free port in a range).
func probeTarget() string {
	if p := os.Getenv("GSUI_PORT"); p != "" {
		return fmt.Sprintf("http://127.0.0.1:%s/", p)
	}
	client := &http.Client{Timeout: 400 * time.Millisecond}
	for {
		for port := 17890; port <= 17899; port++ {
			resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/status", port))
			if err != nil {
				continue
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return fmt.Sprintf("http://127.0.0.1:%d/", port)
			}
		}
		time.Sleep(time.Second)
	}
}

// ------------------------------------------------------------ splash page

// Shown until SetURL navigates to the addon server once it's found.
const splashHTML = `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{background:#020617;color:#94a3b8;height:100%;margin:0;
    font:14px system-ui;display:grid;place-items:center}
  .spin{color:#38bdf8}
</style>
<p>connecting<span class="spin">…</span></p>
`

func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	d := filepath.Join(base, "xic")
	os.MkdirAll(d, 0o755)
	return d
}

// --------------------------------------------------------------- modes

var (
	win     *application.WebviewWindow
	app     *application.App
	fabMode bool
)

// expand grows the fab back into the full window, restoring the bounds it
// had when it collapsed (or a centered default the first time).
func expand() {
	if !fabMode {
		return
	}
	log.Printf("expand: fab=%v", geomSnapshot().Fab)
	x, y := win.Position()
	setFabGeom(rect{X: x, Y: y, W: fabW, H: fabH})
	fabMode = false

	win.SetResizable(true)
	if r := geomSnapshot().Full; r != nil && r.W >= minW && r.H >= minH {
		win.SetSize(r.W, r.H)
		win.SetPosition(r.X, r.Y)
	} else {
		win.SetSize(fullW, fullH)
		win.Center()
	}
	win.SetMinSize(minW, minH)
	win.Show()
	win.Focus()
	saveGeometry()
}

// collapse shrinks the window back to the fab, remembering the full
// bounds so expand can restore them.
func collapse() {
	if fabMode {
		return
	}
	fx, fy := win.Position()
	fw, fh := win.Size()
	setFullGeom(rect{X: fx, Y: fy, W: fw, H: fh})
	fabMode = true

	win.SetMinSize(fabW, fabH)
	win.SetSize(fabW, fabH)
	win.SetResizable(false)
	if r := geomSnapshot().Fab; r != nil {
		win.SetPosition(r.X, r.Y)
	} else {
		x, y := defaultFabPos()
		win.SetPosition(x, y)
	}
	saveGeometry()
	// collapse means "back to the game" — hand focus over so the next
	// Esc/Enter goes to the client, not the shrunken fab
	refocusGame()
}

func quit() {
	// persist whichever geometry is live so the next launch restores it
	if fabMode {
		x, y := win.Position()
		setFabGeom(rect{X: x, Y: y, W: fabW, H: fabH})
	} else {
		fx, fy := win.Position()
		fw, fh := win.Size()
		setFullGeom(rect{X: fx, Y: fy, W: fw, H: fh})
	}
	saveGeometry()
	refocusGame()
	app.Quit()
}

// trackGeometry mirrors the live window bounds into geom and persists
// them once they've settled. The native drag loop gives no end-of-move
// callback, and //lua unload (or logout) taskkills the process before
// quit() can run — without this a dragged fab snaps back to wherever it
// was when it last expanded.
func trackGeometry() {
	for win.NativeWindow() == nil {
		time.Sleep(150 * time.Millisecond)
	}
	var last rect
	dirty := false
	for {
		time.Sleep(300 * time.Millisecond)
		x, y := win.Position()
		if x < -30000 || y < -30000 {
			continue // minimized windows park at -32000,-32000
		}
		cur := rect{X: x, Y: y, W: fabW, H: fabH}
		if !fabMode {
			cur.W, cur.H = win.Size()
			// 0-size mid-teardown must not clobber persisted bounds — a
			// saved zero-rect fails the restore min-size check and the
			// window silently respawns at the default position
			if cur.W <= 0 || cur.H <= 0 {
				continue
			}
		}
		if cur == last {
			if dirty {
				saveGeometry()
				dirty = false
			}
			continue
		}
		last = cur
		if fabMode {
			setFabGeom(cur)
		} else {
			setFullGeom(cur)
		}
		dirty = true
	}
}

// --------------------------------------------------------- spawned tabs

// Detached per-tab windows ("pop out" in the header posts xic:spawn:<path>).
// Each is its own frameless always-on-top Webview2 window navigated to the
// addon page with ?window=<path> — the app renders just that view plus a
// slim title bar. Bounds persist per route in window.json.
var (
	spawned       = map[string]*application.WebviewWindow{}
	spawnMu       sync.Mutex
	addonTarget   string      // probed addon base URL, set once found
	backendHidden atomic.Bool // zoning blackout / cutscene flag
)

// spawnKey normalizes a route path for use as a map/geometry key.
// Query strings are dropped first — a popped-out "/journal?g=x" is the
// same window/geometry slot as "/journal", not a new "?gx" key.
func spawnKey(route string) string {
	if i := strings.IndexByte(route, '?'); i >= 0 {
		route = route[:i]
	}
	var b strings.Builder
	for _, c := range route {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '/' || c == '-' || c == '_' {
			b.WriteRune(c)
		}
	}
	k := b.String()
	if len(k) > 64 || k == "" {
		return "/"
	}
	return k
}

// fabLayerSpawned reports whether a spawned route lives on the fab
// layer — always up alongside it, and hidden during the zoning
// blackout / cutscenes the same way the fab is.
func fabLayerSpawned(key string) bool {
	return key == "/tracker" || key == "/macrobar" || key == "/cooldowns" ||
		key == "/minimap"
}

// spawnArg extracts `--spawn <route>` / `--spawn=<route>` from a command
// line — the addon uses it to open a detached window (the tracker) from
// a //xic command without touching the main window.
func spawnArg(args []string) (string, bool) {
	for i, a := range args {
		var r string
		if a == "--spawn" && i+1 < len(args) {
			r = args[i+1]
		} else if strings.HasPrefix(a, "--spawn=") {
			r = strings.TrimPrefix(a, "--spawn=")
		} else {
			continue
		}
		if r = "/" + strings.Trim(r, "/"); len(r) > 1 {
			return r, true
		}
	}
	return "", false
}

func spawnWindow(route string) {
	key := spawnKey(route)
	spawnMu.Lock()
	if w, ok := spawned[key]; ok && w.NativeWindow() != nil {
		spawnMu.Unlock()
		go func() {
			w.Show()
			w.Focus()
		}()
		refocusAfterActivate()
		return
	}
	spawnMu.Unlock()

	const minSW, minSH = 280, 180
	// friendly window titles (task switcher / screen readers — the
	// frameless windows don't paint a titlebar)
	spawnTitles := map[string]string{
		"/tracker":   "Tracker",
		"/macrobar":  "Macro Bar",
		"/cooldowns": "Cooldowns",
		"/minimap":   "Minimap",
	}
	title, ok := spawnTitles[key]
	if !ok {
		title = strings.TrimPrefix(key, "/")
	}
	opts := application.WebviewWindowOptions{
		Title:            windowTitle + " — " + title,
		Frameless:        true,
		AlwaysOnTop:      true,
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGB(2, 6, 23),
		HTML:             splashHTML,
		Width:            560,
		Height:           420,
		MinWidth:         minSW,
		MinHeight:        minSH,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
		},
	}
	switch key {
	case "/tracker":
		// a narrow always-up column
		opts.Width, opts.Height = 320, 420
	case "/cooldowns":
		// same narrow column as the tracker, shorter — it's a plain list
		opts.Width, opts.Height = 320, 240
	case "/macrobar":
		// a wide, shallow bar — pickers row plus the Ctrl/Alt rows
		opts.Width, opts.Height = 600, 210
	case "/minimap":
		// a square radar panel — the map fills whatever space it gets
		opts.Width, opts.Height = 280, 280
	}
	if r := geomSnapshot().Windows[key]; r != nil && r.W >= minSW && r.H >= minSH {
		opts.Width, opts.Height = r.W, r.H
		opts.X, opts.Y = r.X, r.Y
		// InitialPosition's zero value is WindowCentered — without
		// WindowXY the shell re-centers after creation and the restored
		// X/Y are ignored (same trap as the main window)
		opts.InitialPosition = application.WindowXY
	}
	w := app.Window.NewWithOptions(opts)

	spawnMu.Lock()
	spawned[key] = w
	spawnMu.Unlock()

	w.OnWindowEvent(events.Common.WindowMinimise, func(e *application.WindowEvent) {
		w.Show()
	})

	go keepPinned(w, nil)
	go func() {
		for w.NativeWindow() == nil {
			time.Sleep(150 * time.Millisecond)
		}
		target := addonTarget
		if target == "" {
			target = probeTarget()
		}
		// a fab-layer window (the tracker) is owned by the main window —
		// owned windows always outrank their owner in z-order, so the
		// keepPinned topmost re-asserts on the main window can never
		// bounce it under the UI (same trick as the item tooltip). It
		// also follows the owner's hide during the blackout.
		if fabLayerSpawned(key) {
			for i := 0; i < 40 && windowHwnd.Load() == 0; i++ {
				time.Sleep(50 * time.Millisecond)
			}
			if owner := windowHwnd.Load(); owner != 0 {
				pSetWindowLongPtr.Call(
					uintptr(w.NativeWindow()), uintptr(gwlpOwner), owner)
			}
		}
		// navigate to the route itself (?window=1 flags detached chrome) so
		// nested routes like /profile/sets resolve normally
		path := strings.TrimPrefix(key, "/")
		w.SetURL(target + path + "?window=1")
		// a fab-layer window spawned mid-blackout starts hidden — the
		// watchBackend poll restores it when the world comes back
		if fabLayerSpawned(key) && backendHidden.Load() {
			w.Hide()
		}
	}()
	go trackSpawned(w, key)
	log.Printf("spawned window %q", key)
	// creation activated the window — hand focus back to the game once
	// the hwnd lands in the spawned map
	refocusAfterActivate()
}

// trackSpawned mirrors a spawned window's bounds into geom.Windows[key],
// saving once they settle, and drops it from the map when destroyed.
func trackSpawned(w *application.WebviewWindow, key string) {
	for w.NativeWindow() == nil {
		time.Sleep(150 * time.Millisecond)
	}
	var last rect
	dirty := false
	for w.NativeWindow() != nil {
		time.Sleep(300 * time.Millisecond)
		// a window mid-teardown reports 0-size/position while its hwnd
		// still resolves — never let that clobber the persisted bounds
		// (a saved zero-rect fails the restore min-size check and the
		// window silently respawns at the default position)
		ww, wh := w.Size()
		if ww <= 0 || wh <= 0 {
			continue
		}
		x, y := w.Position()
		if x < -30000 || y < -30000 {
			continue
		}
		cur := rect{X: x, Y: y, W: ww, H: wh}
		if cur == last {
			if dirty {
				saveGeometry()
				dirty = false
			}
			continue
		}
		last = cur
		setWindowGeom(key, cur)
		dirty = true
	}
	spawnMu.Lock()
	delete(spawned, key)
	spawnMu.Unlock()
	if dirty {
		saveGeometry()
	}
	log.Printf("window %q closed", key)
}

// geomReport pushes the persisted window bounds back to the requesting
// page — the settings tab renders its X/Y/W/H fields from this.
func geomReport(w application.Window) {
	b, err := json.Marshal(geomSnapshot())
	if err != nil {
		return
	}
	w.ExecJS("window.__xicGeom && window.__xicGeom(" + string(b) + ")")
}

// geomSet persists bounds for the fab ("fab") or a spawned route
// ("/tracker" etc.) and live-applies them when that window is up.
// Message form: xic:geom-set:<key>:<x>,<y>[,<w>,<h>]
func geomSet(arg string) {
	sep := strings.LastIndexByte(arg, ':')
	if sep < 0 {
		return
	}
	key, nums := arg[:sep], arg[sep+1:]
	if key != "fab" && key != "full" {
		key = spawnKey(key)
	}
	f := strings.Split(nums, ",")
	if len(f) < 2 {
		return
	}
	x, errX := strconv.Atoi(f[0])
	y, errY := strconv.Atoi(f[1])
	if errX != nil || errY != nil {
		return
	}
	r := rect{X: x, Y: y}
	if len(f) >= 4 {
		r.W, _ = strconv.Atoi(f[2])
		r.H, _ = strconv.Atoi(f[3])
	}
	// x,y-only updates keep the persisted/known size
	if r.W <= 0 || r.H <= 0 {
		var old *rect
		switch key {
		case "fab":
			old = geomSnapshot().Fab
		case "full":
			old = geomSnapshot().Full
		default:
			old = geomSnapshot().Windows[key]
		}
		if r.W <= 0 {
			if old != nil && old.W > 0 {
				r.W = old.W
			} else {
				r.W = fabW
			}
		}
		if r.H <= 0 {
			if old != nil && old.H > 0 {
				r.H = old.H
			} else {
				r.H = fabH
			}
		}
	}
	switch key {
	case "fab":
		setFabGeom(r)
	case "full":
		setFullGeom(r)
	default:
		setWindowGeom(key, r)
	}
	saveGeometry()

	// live-apply — these window methods InvokeSync internally, so this
	// stays on the caller's goroutine like the other handlers.
	if key == "fab" {
		if fabMode && win != nil && win.NativeWindow() != nil {
			win.SetPosition(r.X, r.Y)
			if r.W > 0 && r.H > 0 {
				win.SetSize(r.W, r.H)
			}
		}
		return
	}
	if key == "full" {
		if !fabMode && win != nil && win.NativeWindow() != nil {
			win.SetPosition(r.X, r.Y)
			if r.W > 0 && r.H > 0 {
				win.SetSize(r.W, r.H)
			}
		}
		return
	}
	spawnMu.Lock()
	w := spawned[key]
	spawnMu.Unlock()
	if w != nil && w.NativeWindow() != nil {
		w.SetPosition(r.X, r.Y)
		w.SetSize(r.W, r.H)
	}
}

// showInMain surfaces the main window on an app route — spawned
// windows (the quest tracker) deep-link into the journal this way.
// The shell's __xicNavigate hook navigates the router in-page so open
// views keep their state; detached windows are untouched — they live
// on the fab layer and stay up while the main UI is open.
func showInMain(path string) {
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") ||
		strings.ContainsAny(path, "'\"\\") {
		return
	}
	win.ExecJS(fmt.Sprintf(
		"window.__xicNavigate ? __xicNavigate(%s) : location.assign(%s)",
		strconv.Quote(path), strconv.Quote(path)))
	expand() // no-op unless the window is a fab
	win.Show()
	win.Focus()
	if hwnd := windowHwnd.Load(); hwnd != 0 {
		if isIconic(hwnd) {
			pShowWindow.Call(hwnd, swRestore)
		}
		pSetForegroundWindow.Call(hwnd)
	}
}

// closeFor routes xic:close from a page: a spawned window is destroyed,
// the tooltip hides, the main window collapses to the fab.
func closeFor(w application.Window) {
	if w == tooltipWin {
		tooltipHide()
		return
	}
	spawnMu.Lock()
	for _, sw := range spawned {
		if sw == w {
			spawnMu.Unlock()
			sw.Close()
			refocusGame()
			return
		}
	}
	spawnMu.Unlock()
	collapse()
}

// ------------------------------------------------------- item tooltip

// One shared frameless window floats next to the hovered item. Peek is
// click-through (WS_EX_TRANSPARENT) so the pin click lands on the item;
// pinning clears it so the card's actions/drag work. Content updates go
// through ExecJS — moving between items doesn't reload the page.
var (
	tooltipWin    *application.WebviewWindow
	tooltipHwnd   atomic.Uintptr
	tooltipPinned atomic.Bool
	tooltipMu     sync.Mutex
)

type tooltipMsg struct {
	Bag    int    `json:"bag"`
	Slot   int    `json:"slot"`
	ID     int    `json:"id"`
	Name   string `json:"name,omitempty"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Pinned bool   `json:"pinned"`
}

// setTooltipOwner parents the tooltip to the window that summoned it.
// An owned window ALWAYS sits above its owner in z-order — the periodic
// keepPinned re-asserts of HWND_TOPMOST on the main window can't bounce
// the tooltip underneath it, which is what caused the under/over flip.
// (Also dies with its owner, which is correct for a tooltip.)
func setTooltipOwner(ownerHwnd uintptr) {
	th := tooltipHwnd.Load()
	if th == 0 || ownerHwnd == 0 || th == ownerHwnd {
		return
	}
	pSetWindowLongPtr.Call(th, uintptr(gwlpOwner), ownerHwnd)
}

func hwndOf(w application.Window) uintptr {
	ww, ok := w.(*application.WebviewWindow)
	if !ok || ww == nil || ww.NativeWindow() == nil {
		return 0
	}
	return uintptr(ww.NativeWindow())
}

func tooltipShow(caller application.Window, raw string) {
	var m tooltipMsg
	if json.Unmarshal([]byte(raw), &m) != nil || m.ID == 0 {
		return
	}
	tooltipPinned.Store(m.Pinned)
	tooltipMu.Lock()
	w := tooltipWin
	tooltipMu.Unlock()
	if w == nil || w.NativeWindow() == nil {
		tooltipCreate(m, hwndOf(caller))
		return
	}
	setTooltipOwner(hwndOf(caller))
	setClickable(tooltipHwnd.Load(), m.Pinned)
	payload, _ := json.Marshal(m)
	w.ExecJS(fmt.Sprintf(
		"window.__xicTooltip&&window.__xicTooltip(%s)", payload))
	w.SetPosition(m.X, m.Y)
	w.Show()
}

func tooltipCreate(m tooltipMsg, ownerHwnd uintptr) {
	opts := application.WebviewWindowOptions{
		Title:            windowTitle + " — item",
		Frameless:        true,
		AlwaysOnTop:      true,
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGB(2, 6, 23),
		HTML:             splashHTML,
		Width:            320,
		Height:           440,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
		},
	}
	w := app.Window.NewWithOptions(opts)
	tooltipMu.Lock()
	tooltipWin = w
	tooltipMu.Unlock()

	w.OnWindowEvent(events.Common.WindowMinimise, func(e *application.WindowEvent) {
		w.Show()
	})

	go keepPinned(w, &tooltipHwnd)
	go func() {
		for i := 0; i < 100 && w.NativeWindow() == nil; i++ {
			time.Sleep(100 * time.Millisecond)
		}
		if w.NativeWindow() == nil {
			return // create failed — keepPinned exits on its own
		}
		for i := 0; i < 50 && tooltipHwnd.Load() == 0; i++ {
			time.Sleep(50 * time.Millisecond)
		}
		setTooltipOwner(ownerHwnd)
		setClickable(tooltipHwnd.Load(), m.Pinned)
		target := addonTarget
		if target == "" {
			target = probeTarget()
		}
		q := fmt.Sprintf("?tooltip=1&bag=%d&slot=%d&id=%d&pinned=%d",
			m.Bag, m.Slot, m.ID, btoi(m.Pinned))
		if m.Name != "" {
			q += "&name=" + url.QueryEscape(m.Name)
		}
		w.SetURL(target + q)
		w.SetPosition(m.X, m.Y)
	}()
	log.Printf("tooltip window created")
}

func tooltipHide() {
	tooltipPinned.Store(false)
	tooltipMu.Lock()
	w := tooltipWin
	tooltipMu.Unlock()
	if w != nil && w.NativeWindow() != nil {
		w.Hide()
	}
	// the pinned window's × lands here — the main window's pinned flag
	// lives in its own JS context, so nudge it over ExecJS
	if win != nil && win.NativeWindow() != nil {
		win.ExecJS("window.__xicTooltipUnpinned&&window.__xicTooltipUnpinned()")
	}
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

// watchBackend tracks the addon server every 2s. It quits the overlay
// when the server disappears — the addon taskkills us on unload/logout,
// but a game exit takes the Lua state down before that handler runs.
// It also hides the fab while the addon reports "hidden" (zoning
// blackout, cutscenes) — the same states in-render addons stop drawing
// for. Only the fab hides: the full UI and spawned windows stay up.
func watchBackend(target string) {
	client := &http.Client{Timeout: 2 * time.Second}
	misses := 0
	hidden := false        // currently applied fab-visibility, not the raw flag
	spawnedHidden := false // fab-layer spawned windows during the blackout
	for {
		time.Sleep(2 * time.Second)
		resp, err := client.Get(target + "api/status")
		if err != nil {
			misses++
			if misses >= 5 {
				log.Print("addon server unreachable, quitting")
				app.Quit()
				return
			}
			continue
		}
		misses = 0
		var st struct {
			Hidden bool `json:"hidden"`
		}
		json.NewDecoder(resp.Body).Decode(&st)
		resp.Body.Close()
		backendHidden.Store(st.Hidden)
		// recomputed every poll so mode transitions during a blackout
		// self-correct: collapse mid-cutscene hides the fab, expand
		// brings the full window back
		want := st.Hidden && fabMode
		if want != hidden {
			hidden = want
			log.Printf("fab hidden=%v", hidden)
			if hidden {
				win.Hide()
				refocusGame()
			} else {
				win.Show()
			}
		}
		// fab-layer spawned windows (the quest tracker) join the
		// blackout: hidden while zoning/in a cutscene, restored when
		// the world comes back — in-render addons behave the same
		if st.Hidden != spawnedHidden {
			spawnedHidden = st.Hidden
			spawnMu.Lock()
			var toggle []*application.WebviewWindow
			for key, sw := range spawned {
				if fabLayerSpawned(key) && sw.NativeWindow() != nil {
					toggle = append(toggle, sw)
				}
			}
			spawnMu.Unlock()
			for _, sw := range toggle {
				if spawnedHidden {
					sw.Hide()
					refocusGame()
				} else {
					sw.Show()
				}
			}
		}
	}
}

func main() {
	startFab := slices.Contains(os.Args[1:], "--fab")

	geomPath = filepath.Join(dataDir(), "window.json")
	loadGeometry()

	logf, err := os.OpenFile(filepath.Join(dataDir(), "overlay.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		log.SetOutput(logf)
		defer logf.Close()
	}

	app = application.New(application.Options{
		Name: "xic-overlay",
		// //xic overlay (and the addon's auto-fab spawn on load) can fire
		// repeatedly — surface the existing window instead of stacking.
		// A plain relaunch expands the UI; a --fab relaunch (addon reload)
		// just makes sure the button is visible.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.xic.overlay",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				log.Printf("second instance: args=%v", data.Args)
				if win == nil {
					return
				}
				// //xic tracker & friends — open just the detached window;
				// the main window stays in whatever mode it's in
				if route, ok := spawnArg(data.Args); ok {
					go spawnWindow(route)
					return
				}
				go func() {
					fabRelaunch := slices.Contains(data.Args, "--fab")
					if !fabRelaunch {
						expand()
					}
					// a --fab relaunch during the zoning blackout must
					// not flash the hidden fab back on screen
					if fabMode && backendHidden.Load() {
						return
					}
					win.Show()
					if fabRelaunch {
						// addon (re)load auto-spawning the fab — keep the
						// game's keyboard focus instead of stealing it
						refocusAfterActivate()
						return
					}
					win.Focus()
					if hwnd := windowHwnd.Load(); hwnd != 0 {
						if isIconic(hwnd) {
							pShowWindow.Call(hwnd, swRestore)
						}
						pSetForegroundWindow.Call(hwnd)
					}
				}()
			},
		},
		// the page is a foreign-origin document — Wails' own "wails:*"
		// messages reach HandleMessage directly, anything else lands here.
		// win methods go through InvokeSync internally, so they must run
		// off the main thread that invokes this handler — hence the gos.
		RawMessageHandler: func(w application.Window, message string, _ *application.OriginInfo) {
			log.Printf("page message: %q", message)
			switch {
			case message == "xic:expand":
				go expand()
			case message == "xic:collapse" || message == "xic:hide":
				go collapse()
			case message == "xic:quit":
				go quit()
			case message == "xic:close":
				go closeFor(w) // spawned window → destroy; main → collapse
			case strings.HasPrefix(message, "xic:spawn:"):
				go spawnWindow(strings.TrimPrefix(message, "xic:spawn:"))
			case strings.HasPrefix(message, "xic:main:"):
				go showInMain(strings.TrimPrefix(message, "xic:main:"))
			case message == "xic:geom":
				go geomReport(w)
			case strings.HasPrefix(message, "xic:geom-set:"):
				go geomSet(strings.TrimPrefix(message, "xic:geom-set:"))
			case message == "xic:refocus":
				// let the click finish dispatching first — the macro's
				// send_command / the tooltip's pin go out on this gesture
				go func() {
					time.Sleep(50 * time.Millisecond)
					refocusGame()
				}()
			case strings.HasPrefix(message, "xic:open:"):
				go openURL(strings.TrimPrefix(message, "xic:open:"))
			case strings.HasPrefix(message, "xic:show:"): // older pages
				go showInMain(strings.TrimPrefix(message, "xic:show:"))
			case message == "xic:tooltip-hide":
				go tooltipHide()
			case strings.HasPrefix(message, "xic:tooltip-size:"):
				// fixed-size window — ignore size reports from older pages
			case strings.HasPrefix(message, "xic:tooltip:"):
				go tooltipShow(w, strings.TrimPrefix(message, "xic:tooltip:"))
			case message == "xic:drag":
				go startMoveLoop(hwndOf(w), htCaption)
			case strings.HasPrefix(message, "xic:resize:"):
				go startMoveLoop(hwndOf(w), edgeHT[strings.TrimPrefix(message, "xic:resize:")])
			}
		},
		Windows: application.WindowsOptions{
			// own UDF so we never collide with another app's WebView2 profile
			WebviewUserDataPath: filepath.Join(dataDir(), "webview2"),
		},
	})

	opts := application.WebviewWindowOptions{
		Title:       windowTitle,
		Frameless:   true,
		AlwaysOnTop: true,
		// transparent so the fab's square window reads as a circle —
		// the full page paints its own opaque background
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGB(2, 6, 23), // --background #020617
		HTML:             splashHTML,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
		},
	}
	if startFab {
		fabMode = true
		x, y := defaultFabPos()
		if r := geomSnapshot().Fab; r != nil {
			x, y = r.X, r.Y
		}
		opts.Width, opts.Height = fabW, fabH
		opts.MinWidth, opts.MinHeight = fabW, fabH
		opts.X, opts.Y = x, y
		opts.DisableResize = true
	} else {
		opts.Width, opts.Height = fullW, fullH
		opts.MinWidth, opts.MinHeight = minW, minH
		if r := geomSnapshot().Full; r != nil && r.W >= minW && r.H >= minH {
			opts.Width, opts.Height = r.W, r.H
			opts.X, opts.Y = r.X, r.Y
		}
	}
	// InitialPosition's zero value is WindowCentered — without WindowXY
	// the shell centers the window after creation and X/Y are ignored.
	if opts.X != 0 || opts.Y != 0 {
		opts.InitialPosition = application.WindowXY
	}
	win = app.Window.NewWithOptions(opts)

	// frameless+tool windows auto-minimize when the game takes focus — undo it
	win.OnWindowEvent(events.Common.WindowMinimise, func(e *application.WindowEvent) {
		win.Show()
	})

	go keepPinned(win, &windowHwnd)
	go trackGeometry()
	go func() {
		// SetURL is a no-op until app.Run creates the window impl —
		// NativeWindow() reporting an hwnd means it's ready.
		for win.NativeWindow() == nil {
			time.Sleep(150 * time.Millisecond)
		}
		addonTarget = probeTarget()
		win.SetURL(addonTarget)
		// the addon auto-spawning the fab on (re)load steals foreground —
		// hand it back once our hwnd is registered; a user-invoked
		// //xic overlay (no --fab) keeps focus on purpose
		if startFab {
			refocusAfterActivate()
		}
		// cold start with --spawn (e.g. `//xic tracker` while the overlay
		// wasn't running) — open the detached window once the app is up
		if route, ok := spawnArg(os.Args[1:]); ok {
			spawnWindow(route)
		}
		go watchBackend(addonTarget)
	}()

	if err := app.Run(); err != nil {
		log.Printf("wails exited with error: %v", err)
	}
}
