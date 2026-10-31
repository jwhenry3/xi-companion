// xicompanion-overlay — Wails v3 (WebView2) shell for the XI Companion addon.
//
// Thin window wrapper: the Lua addon's HTTP server stays the backend, this
// process just finds it (probing 127.0.0.1:17890..17899 for /api/status,
// or $GSUI_PORT if set) and shows it in a frameless window owned by the
// game — an owned window always sits above its owner but is covered by
// foreign apps, so no always-on-top/z-order machinery is needed.
//
// The window has two modes:
//
//	fab  — a small floating button (--fab starts this way).
//	       The addon spawns it on load; it survives //xicompanion hide/close/Esc.
//	full — the whole XI Companion UI.
//
// The page itself decides what to render from the viewport size, and talks
// to the shell through Wails' raw message channel — "wails:drag" /
// "wails:resize:<cursor>" are routed from any main-frame origin, while
// "xicompanion:expand|collapse|quit" land in RawMessageHandler.
//
// Build:
//
//	go build -tags production -ldflags "-s -w -H windowsgui" \
//	    -o ../../addon/xicompanion/overlay/xicompanion-overlay.exe .
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
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
	// the fab is a one-row menu bar: twelve 40px buttons + gaps/separators
	fabW, fabH = 540, 56
	// the fab IS the main window — there is no full window

	fabEdgeMargin = 24
)

// ---------------------------------------------------------------- win32

var (
	user32  = syscall.NewLazyDLL("user32.dll")
	shell32 = syscall.NewLazyDLL("shell32.dll")
	dwmapi  = syscall.NewLazyDLL("dwmapi.dll")

	pShellExecute = shell32.NewProc("ShellExecuteW")

	pIsWindowVisible     = user32.NewProc("IsWindowVisible")
	pIsWindow            = user32.NewProc("IsWindow")
	pShowWindow          = user32.NewProc("ShowWindow")
	pGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pSetWindowPos        = user32.NewProc("SetWindowPos")
	pGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	pGetWindowLongPtr    = user32.NewProc("GetWindowLongPtrW")
	pSetWindowLongPtr    = user32.NewProc("SetWindowLongPtrW")
	pGetAsyncKeyState    = user32.NewProc("GetAsyncKeyState")
	pGetCursorPos        = user32.NewProc("GetCursorPos")
	pWindowFromPoint     = user32.NewProc("WindowFromPoint")
	pGetAncestor         = user32.NewProc("GetAncestor")

	pSetCursor           = user32.NewProc("SetCursor")
	pLoadImage           = user32.NewProc("LoadImageW")
	pGetWindowRect       = user32.NewProc("GetWindowRect")
	pSetClassLongPtr     = user32.NewProc("SetClassLongPtrW")
	pCallWindowProc      = user32.NewProc("CallWindowProcW")
	pDwmSetWindowAttr    = dwmapi.NewProc("DwmSetWindowAttribute")
	pDwmExtendFrame      = dwmapi.NewProc("DwmExtendFrameIntoClientArea")
	pDefWindowProc       = user32.NewProc("DefWindowProcW")
	pGetModuleHandle     = kernel32.NewProc("GetModuleHandleW")
	pBeginPaint          = user32.NewProc("BeginPaint")
	pEndPaint            = user32.NewProc("EndPaint")

	gdi32 = syscall.NewLazyDLL("gdi32.dll")

	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	pFindWindowW               = user32.NewProc("FindWindowW")
	pEnumWindows               = user32.NewProc("EnumWindows")
	pGetWindowThreadProcessId  = user32.NewProc("GetWindowThreadProcessId")
	pOpenProcess               = kernel32.NewProc("OpenProcess")
	pCloseHandle               = kernel32.NewProc("CloseHandle")
	pQueryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")
)

const (
	swHide        = 0
	swShowNA      = 8 // show without activating — restores must not steal fg
	hwndTop       = 0 // HWND_TOP — top of the normal (non-topmost) band
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010
	swpFrameChg   = 0x0020
	swpShowWindow = 0x0040 //nolint:unused — kept with the SWP_* family

	gwlExStyle      = ^uint32(19) // GWL_EXSTYLE (-20)
	gwlStyle        = ^uint32(15) // GWL_STYLE (-16)
	wsThickFrame    = 0x00040000  // WS_THICKFRAME
	gwlpOwner       = ^uint32(7)  // GWLP_HWNDPARENT (-8)
	gwHwndNext      = 2           //nolint:unused — kept with the GW_* family
	wsExLayered     = 0x00080000
	wsExTransparent = 0x00000020
	wsExNoActivate  = 0x08000000

	vkLButton = 0x01

	htCaption     = 2
	htLeft        = 10
	htRight       = 11
	htTop         = 12
	htTopLeft     = 13
	htTopRight    = 14
	htBottom      = 15
	htBottomLeft  = 16
	htBottomRight = 17
)

// edge hit-test codes (same values WM_NCHITTEST reports)
var edgeHT = map[string]uintptr{
	"n-resize":  htTop,
	"ne-resize": htTopRight,
	"e-resize":  htRight,
	"se-resize": htBottomRight,
	"s-resize":  htBottom,
	"sw-resize": htBottomLeft,
	"w-resize":  htLeft,
	"nw-resize": htTopLeft,
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
		log.Print("ffxi: FFXiClass lookup failed, scanning for pol.exe")
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
		log.Print("ffxi: no pol.exe window found either")
	}
	return found
}

// ourHwnd reports whether hwnd is one of this process's overlay windows —
// main, tooltip, fab menu, or a spawned tab.
func ourHwnd(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	if hwnd == windowHwnd.Load() || hwnd == tooltipHwnd.Load() ||
		hwnd == fabMenuHwnd.Load() {
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

// game ownership: every top-level overlay window is OWNED by the FFXI
// game window (GWLP_HWNDPARENT). An owned window always sits above its
// owner — it can never slide under the game — but is covered by any
// foreign app's windows, so the whole overlay family tracks the game's
// layering exactly, with no TOPMOST flag and no z-order polling. Owned
// windows also hide and are destroyed with their owner: game exit (or
// a recreated game frame) takes the family down with it.
var ffxiHwnd atomic.Uintptr

// isFFXIProcess: hwnd thuộc pol.exe? — so bằng process image thay vì hwnd
// tuyệt đối: FFXiClass có thể resolve sang top-level window khác của pol
// (boot frame vs game frame) khiến `fg == ffxi` trật dù game đang focus.
func isFFXIProcess(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	var pid uint32
	pGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return false
	}
	h, _, _ := pOpenProcess.Call(0x1000 /* QUERY_LIMITED_INFORMATION */, 0, uintptr(pid))
	if h == 0 {
		return false
	}
	defer pCloseHandle.Call(h)
	var buf [260]uint16
	n := uint32(len(buf))
	if r, _, _ := pQueryFullProcessImageName.Call(h, 0,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n))); r == 0 {
		return false
	}
	return strings.EqualFold(filepath.Base(syscall.UTF16ToString(buf[:n])), "pol.exe")
}

// gameHwnd resolves (and caches) the FFXI game window — the owner of
// every top-level overlay window. Only ever stores a live hwnd; a dead
// cache entry retries the lookup on the next call.
func gameHwnd() uintptr {
	if ffxi := ffxiHwnd.Load(); ffxi != 0 {
		return ffxi
	}
	ffxi := findFFXIWindow()
	ffxiHwnd.Store(ffxi)
	return ffxi
}

// ownToGame makes the game window this window's owner
// (GWLP_HWNDPARENT — the same trick the tooltip/fab-menu ownership
// uses; a window can't be owned by a window in its own chain, and the
// game is always the top of ours).
func ownToGame(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	if g := gameHwnd(); g != 0 {
		pSetWindowLongPtr.Call(hwnd, uintptr(gwlpOwner), g)
	}
}

// ownAllToGame catches windows spawned before the game hwnd resolved —
// the fab bar and the editor panels. Fab-layer panels and the fab menu
// stay owned by the bar, the tooltip by its summoner (those chains
// still top out at the game).
func ownAllToGame() {
	ownToGame(windowHwnd.Load())
	spawnMu.Lock()
	var list []*application.WebviewWindow
	for k, sw := range spawned {
		if !fabLayerSpawned(strings.SplitN(k, "?", 2)[0]) {
			list = append(list, sw)
		}
	}
	spawnMu.Unlock()
	for _, sw := range list {
		ownToGame(hwndOf(sw))
	}
}

// focusGameSoon hands keyboard focus to the game once a spawn burst
// settles — debounced so a burst triggers ONE hand-back ~2s after the
// last reveal. It only acts when a WS_EX_NOACTIVATE overlay window
// somehow holds foreground (the only illegitimate path left — a
// window can activate before its exstyle lands): editor focus earned
// by a real click is never taken, the game itself and foreign apps
// are never taken.
var (
	focusDeadline atomic.Int64
	focusWatchOn  atomic.Bool
)

func focusGameSoon() {
	focusDeadline.Store(time.Now().Add(2 * time.Second).UnixNano())
	if focusWatchOn.CompareAndSwap(false, true) {
		go func() {
			defer focusWatchOn.Store(false)
			for {
				rem := time.Until(time.Unix(0, focusDeadline.Load()))
				if rem <= 0 {
					break
				}
				time.Sleep(rem)
			}
			fg, _, _ := pGetForegroundWindow.Call()
			if fg == 0 || !ourHwnd(fg) {
				return
			}
			ex, _, _ := pGetWindowLongPtr.Call(fg, uintptr(gwlExStyle))
			if ex&wsExNoActivate == 0 {
				return // a real (clickable) window — leave its focus
			}
			if g := gameHwnd(); g != 0 {
				pSetForegroundWindow.Call(g)
			}
		}()
	}
}

// watchGameHwnd keeps the owner resolved: it picks up the game window
// when it appears late (overlay launched before login) and quits when
// it dies — Windows destroys owned windows with their owner out-of-band
// (no close path runs), so a dead owner means every overlay hwnd is
// already gone and the shell can only exit for a respawn.
func watchGameHwnd() {
	for range time.Tick(time.Second) {
		if ffxi := ffxiHwnd.Load(); ffxi != 0 {
			if r, _, _ := pIsWindow.Call(ffxi); r == 0 {
				log.Print("game window gone — owned windows went with it, quitting")
				app.Quit()
				return
			}
			gameScaleTick(ffxi)
			continue
		}
		if g := gameHwnd(); g != 0 {
			ownAllToGame()
		}
	}
}

// ---------------------------------------------------- game-follow scaling
// Resizing the FFXI window rescales every overlay window: bounds move
// proportionally with the game rect and content zooms to match. The game
// rect is read in raw screen px like the rest of the shell's geometry —
// window positions are Wails units, consistent with the existing code.
var (
	uiScale      = 1.0 // cumulative content zoom, persisted in window.json
	scaleMu      sync.Mutex
	lastGameHwnd uintptr
	lastGame     wRect
	dragCount    atomic.Int32 // startMoveLoop drags in flight
)

// gameScaleTick runs on the watchGameHwnd beat: anchor on the first valid
// game rect, then rescale whenever the rect's height changes (pure moves
// don't chase windows; minimized/degenerate rects are ignored).
func gameScaleTick(hwnd uintptr) {
	var cur wRect
	pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&cur)))
	if cur.bottom-cur.top < 100 || cur.right-cur.left < 100 {
		return // minimized or a boot flash — keep the last good anchor
	}
	if hwnd != lastGameHwnd {
		lastGameHwnd, lastGame = hwnd, cur
		return
	}
	old := lastGame
	lastGame = cur
	if old.bottom-old.top < 100 {
		return // first valid rect — becomes the anchor
	}
	if dragCount.Load() > 0 {
		lastGame = old // a user drag owns its window — replay the delta next tick
		return
	}
	k := float64(cur.bottom-cur.top) / float64(old.bottom-old.top)
	if math.Abs(k-1) < 0.01 {
		return
	}
	if scaleFollowOn() {
		rescaleWindows(k)
	}
}

func curScale() float64 {
	scaleMu.Lock()
	defer scaleMu.Unlock()
	return uiScale
}

// scaleFollowOn reports the settings toggle — off unless explicitly on.
// The /settings window itself never scales (bounds or zoom) so the
// control always stays readable.
func scaleFollowOn() bool {
	g := geomSnapshot()
	return g.ScaleFollow != nil && *g.ScaleFollow
}

// routes exempt from game-follow scaling — the settings window holds the
// toggle, so it must stay at 100% or a shrunken game could bury it
func scaleExempt(key string) bool {
	return key == "/settings"
}

// spawnZoom gives the creation-time Zoom for a route — exempt windows
// get 0 (no PutZoomFactor → native 100%)
func spawnZoom(key string) float64 {
	if scaleExempt(key) {
		return 0
	}
	return curScale()
}

// rescaleWindows applies a game-size delta: window SIZES and content
// zoom scale, but nothing ever moves — positions stay exactly where the
// user put them (top-left anchored, since SetSize grows from the origin
// corner anyway).
func rescaleWindows(k float64) {
	scaleMu.Lock()
	uiScale = math.Max(0.4, math.Min(3.0, uiScale*k))
	z := uiScale
	scaleMu.Unlock()

	spawnMu.Lock()
	ws := make([]*application.WebviewWindow, 0, len(spawned))
	for key, w := range spawned {
		if scaleExempt(key) {
			continue
		}
		ws = append(ws, w)
	}
	spawnMu.Unlock()
	for _, w := range ws {
		if w.NativeWindow() == nil {
			continue
		}
		ww, wh := w.Size()
		if ww <= 0 || wh <= 0 {
			continue
		}
		x, y := w.Position()
		if x < -30000 || y < -30000 {
			continue // minimized
		}
		w.SetSize(int(math.Round(float64(ww)*k)),
			int(math.Round(float64(wh)*k)))
		applyZoom(w, z)
	}
	if tooltipWin != nil && tooltipWin.NativeWindow() != nil {
		applyZoom(tooltipWin, z)
	}

	geomMu.Lock()
	geom.Scale = z
	geomMu.Unlock()
	saveGeometry()
	log.Printf("game resized %.0f%% — ui scale now %.2f", k*100, z)
}

// scaleFollowSet flips the settings toggle ("1"/"0"), persists it, and
// pushes the refreshed geometry snapshot back to the page. Disabling
// also resets every window's zoom to 100% so a mid-scaled session exits
// cleanly (bounds stay — they're just window geometry now).
func scaleFollowSet(arg string, w application.Window) {
	on := arg == "1"
	geomMu.Lock()
	geom.ScaleFollow = &on
	geomMu.Unlock()
	saveGeometry()
	if !on {
		scaleMu.Lock()
		uiScale = 1.0
		scaleMu.Unlock()
		geomMu.Lock()
		geom.Scale = 1.0
		geomMu.Unlock()
		spawnMu.Lock()
		ws := make([]*application.WebviewWindow, 0, len(spawned)+1)
		for _, sw := range spawned {
			ws = append(ws, sw)
		}
		spawnMu.Unlock()
		for _, sw := range ws {
			if sw.NativeWindow() != nil {
				applyZoom(sw, 1.0)
			}
		}
		saveGeometry()
	}
	go geomReport(w)
}

// winScaleSet applies a per-window scale pick (view-prefs cog): resizes
// the window's bounds by the delta against its last stored scale —
// content zoom is already handled page-side (body zoom × game-follow
// emulation). Persisted so bounds stay proportional across restarts.
func winScaleSet(arg string, w application.Window) {
	f, err := strconv.ParseFloat(strings.TrimSpace(arg), 64)
	if err != nil {
		return
	}
	f = math.Max(0.5, math.Min(4, f))
	spawnMu.Lock()
	key := ""
	for k, sw := range spawned {
		if sw == w {
			key = k
			break
		}
	}
	spawnMu.Unlock()
	if key == "" {
		return
	}
	geomMu.Lock()
	if geom.Scales == nil {
		geom.Scales = map[string]float64{}
	}
	old := geom.Scales[key]
	if old <= 0 {
		old = 1
	}
	if f == 1 {
		delete(geom.Scales, key)
	} else {
		geom.Scales[key] = f
	}
	geomMu.Unlock()
	saveGeometry()
	d := f / old
	if math.Abs(d-1) < 0.01 {
		return
	}
	ww, wh := w.Size()
	if ww <= 0 || wh <= 0 {
		return
	}
	w.SetSize(int(math.Round(float64(ww)*d)),
		int(math.Round(float64(wh)*d)))
}

// applyZoom scales a window's content: WebView2 ZoomFactor at ≥100%
// (real layout reflow) and a body-zoom emulation below it — the runtime
// SetZoom floors at 1.0 on Windows (only spawn-time opts.Zoom honors
// <1.0, which is why new windows get it via options instead).
func applyZoom(w *application.WebviewWindow, z float64) {
	if z >= 1.0 {
		w.SetZoom(z)
		w.ExecJS("window.__xicZoom&&window.__xicZoom(1)")
		return
	}
	w.SetZoom(1)
	w.ExecJS(fmt.Sprintf("window.__xicZoom&&window.__xicZoom(%g)", z))
}

// No focus manipulation anywhere: panels that must never take keyboard
// carry WS_EX_NOACTIVATE, everything else activates natively. Earlier
// builds fought activation with SetForegroundWindow hand-backs — a
// focus ping-pong that could wedge game input entirely.

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

type wPoint struct{ x, y int32 }
type wRect struct{ left, top, right, bottom int32 }

// startMoveLoop runs the move/size drag entirely in Go — polling the
// cursor and SetWindowPos at ~60Hz until the button releases. The old
// approach posted WM_NCLBUTTONDOWN to enter the native modal loop; if
// the post landed after the button was already up, the modal loop
// parked holding GLOBAL mouse capture — every click and keystroke fed
// a hidden drag until Esc happened to cancel it ("can only type in
// chat"). Polling instead has no capture at all: the loop can never
// outlive the button, and it doesn't care which thread it runs on.
// Caller goroutines it — it blocks for the drag's lifetime.
func startMoveLoop(hwnd uintptr, hitTest uintptr) {
	if hwnd == 0 || hitTest == 0 {
		return
	}
	// the page posts on mousedown; a click can release before this
	// goroutine is scheduled — don't start a drag for a button up
	if v, _, _ := pGetAsyncKeyState.Call(vkLButton); v&0x8000 == 0 {
		return
	}
	// a live drag owns the window's rect — the game-follow scaler must
	// not move it out from under the cursor
	dragCount.Add(1)
	defer dragCount.Add(-1)
	var p0 wPoint
	pGetCursorPos.Call(uintptr(unsafe.Pointer(&p0)))
	var r0 wRect
	pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r0)))
	x0, y0 := r0.left, r0.top
	w0, h0 := r0.right-r0.left, r0.bottom-r0.top
	log.Printf("drag: start hwnd=%x hit=%d rect=%d,%d %dx%d",
		hwnd, hitTest, x0, y0, w0, h0)
	lEdge := hitTest == htLeft || hitTest == htTopLeft || hitTest == htBottomLeft
	rEdge := hitTest == htRight || hitTest == htTopRight || hitTest == htBottomRight
	tEdge := hitTest == htTop || hitTest == htTopLeft || hitTest == htTopRight
	bEdge := hitTest == htBottom || hitTest == htBottomLeft || hitTest == htBottomRight

	// live grid: the dragged rect snaps to 8px while the cursor roams
	// free (same rounding the drop-snap applies below)
	snap := func(v int32) int32 { return (v + 4) &^ 7 }
	l, t, r, b := x0, y0, x0+w0, y0+h0
	for {
		time.Sleep(15 * time.Millisecond)
		if v, _, _ := pGetAsyncKeyState.Call(vkLButton); v&0x8000 == 0 {
			break
		}
		var p wPoint
		pGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
		dx, dy := p.x-p0.x, p.y-p0.y
		l, t, r, b = x0, y0, x0+w0, y0+h0
		if hitTest == htCaption {
			l, t = snap(x0+dx), snap(y0+dy)
			r, b = l+w0, t+h0
		} else {
			if lEdge {
				l = snap(x0 + dx)
			}
			if rEdge {
				r = snap(x0 + w0 + dx)
			}
			if tEdge {
				t = snap(y0 + dy)
			}
			if bEdge {
				b = snap(y0 + h0 + dy)
			}
		}
		// never collapse an edge past its opposite — pin whichever side
		// isn't the dragged one
		if r-l < 40 {
			if lEdge {
				l = r - 40
			} else {
				r = l + 40
			}
		}
		if b-t < 40 {
			if tEdge {
				t = b - 40
			} else {
				b = t + 40
			}
		}
		pSetWindowPos.Call(hwnd, 0,
			uintptr(int64(l)), uintptr(int64(t)),
			uintptr(int64(r-l)), uintptr(int64(b-t)),
			swpNoActivate|swpNoZOrder)
	}
	// drop-snap: pin the final rect to 8px intervals — edges AND size
	// (snapping both edges keeps the delta a multiple of 8)
	sl, st, sr, sb := snap(l), snap(t), snap(r), snap(b)
	log.Printf("drag: end %d,%d %dx%d -> %d,%d %dx%d",
		l, t, r-l, b-t, sl, st, sr-sl, sb-st)
	pSetWindowPos.Call(hwnd, 0,
		uintptr(int64(sl)), uintptr(int64(st)),
		uintptr(int64(sr-sl)), uintptr(int64(sb-st)),
		swpNoActivate|swpNoZOrder)
	// gesture done — hand keyboard focus back to the game (same
	// ourHwnd guard as the page's xicompanion:focus-game message:
	// NOACTIVATE panels never took it, foreign apps keep it)
	if fg, _, _ := pGetForegroundWindow.Call(); fg != 0 && ourHwnd(fg) {
		if g := gameHwnd(); g != 0 {
			pSetForegroundWindow.Call(g)
		}
	}
}


// ------------------------------------------------------ cursor subclass

// Non-client pixels (resize border, caption) get WM_SETCURSOR answered
// by DefWindowProc — system sizing arrows/arrow that race the game's XI
// assertion at mouse-message rate. Swallow the message for non-HTCLIENT
// hit tests: leave whatever cursor is standing (the game's XI) alone.
const (
	wmSetCursor = 0x0020
	htClient    = 1
	gwlpWndProc = ^uint32(3) // GWLP_WNDPROC (-4)
)

var (
	origWndProc sync.Map // hwnd -> previous WNDPROC
	xiWndProcCb = syscall.NewCallback(func(hwnd, msg, wparam, lparam uintptr) uintptr {
		if msg == wmSetCursor && lparam&0xFFFF != htClient {
			return 1
		}
		if orig, ok := origWndProc.Load(hwnd); ok {
			r, _, _ := pCallWindowProc.Call(orig.(uintptr), hwnd, msg, wparam, lparam)
			return r
		}
		r, _, _ := pDefWindowProc.Call(hwnd, msg, wparam, lparam)
		return r
	})
)

func subclassWindow(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	if _, loaded := origWndProc.Load(hwnd); loaded {
		return
	}
	if orig, _, _ := pSetWindowLongPtr.Call(hwnd, uintptr(gwlpWndProc), xiWndProcCb); orig != 0 {
		origWndProc.Store(hwnd, orig)
	}
}

// setClassCursor gives a top-level window the XI cursor as its class
// cursor (GCLP_HCURSOR) — the same mechanism FFXI's own window uses:
// Windows itself then asserts XI on every client/caption WM_SETCURSOR,
// no polling, no race, identical to game pixels.
func setClassCursor(hwnd uintptr) {
	if hwnd != 0 {
		pSetClassLongPtr.Call(hwnd, ^uintptr(13), xiCursor())
	}
}

// ------------------------------------------------------ cursor assert

// Mirrors the game's own hardware-cursor behavior: it SetCursors its XI
// cursor every frame whenever the pointer's position is inside its
// window rect — positionally, ignoring what's stacked on top. We do the
// same for our rects with the same image, so our windows behave
// cursor-identical to game pixels. Rect containment (not WindowFromPoint)
// is the right test because it's the game's test.
var (
	xiCur     atomic.Uintptr
	xiCurOnce sync.Once
)

// xiCursor loads the XI cursor shipped beside the UI (public/ → ui/) —
// mousenor.ani first (the animated resource the game actually uses in
// hardware-mouse mode), mousenor.cur as a static fallback.
func xiCursor() uintptr {
	xiCurOnce.Do(func() {
		exe, err := os.Executable()
		if err != nil {
			return
		}
		dir := filepath.Join(filepath.Dir(exe), "..", "ui")
		for _, name := range []string{"mousenor.ani", "mousenor.cur"} {
			full, _ := syscall.UTF16PtrFromString(filepath.Join(dir, name))
			if h, _, _ := pLoadImage.Call(0, uintptr(unsafe.Pointer(full)),
				2, 0, 0, 0x10|0x8000, // IMAGE_CURSOR, LR_LOADFROMFILE|LR_SHARED
			); h != 0 {
				xiCur.Store(h)
				return
			}
		}
	})
	return xiCur.Load()
}

// thickFrame gives the window a real WS_THICKFRAME so the non-client
// resize border lives OUTSIDE the client rect — an invisible margin
// (frameless decorations still hide it) instead of the outer ~8px of
// content pixels the native hit-test was borrowing. The webview insets
// automatically; the edge zone stops overlapping content.
func thickFrame(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	cur, _, _ := pGetWindowLongPtr.Call(hwnd, uintptr(gwlStyle))
	if cur == 0 || cur&wsThickFrame != 0 {
		return
	}
	pSetWindowLongPtr.Call(hwnd, uintptr(gwlStyle), cur|wsThickFrame)
	pSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoZOrder|swpNoActivate|swpFrameChg)
}

// setStyleFlag flips a GWL_EXSTYLE bit and nudges the frame to apply.
// WS_EX_NOACTIVATE lets a window receive clicks without ever taking
// foreground — used on the fab and the fab-layer panels so interacting
// with them (or accidentally clicking their transparent margins) can't
// steal the game's keyboard.
func setStyleFlag(hwnd, flag uintptr, on bool) {
	if hwnd == 0 {
		return
	}
	exIdx := uintptr(gwlExStyle)
	cur, _, _ := pGetWindowLongPtr.Call(hwnd, exIdx)
	var next uintptr
	if on {
		next = cur | flag
	} else {
		next = cur &^ flag
	}
	if next != cur {
		pSetWindowLongPtr.Call(hwnd, exIdx, next)
		pSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0,
			swpNoMove|swpNoSize|swpNoActivate|swpNoZOrder|swpFrameChg)
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

type wndClassEx struct {
	CbSize, Style                    uint32
	LpfnWndProc                      uintptr
	CbClsExtra, CbWndExtra           int32
	HInstance, HIcon, HCursor, HbrBg uintptr
	LpszMenuName, LpszClassName      *uint16
	HIconSm                          uintptr
}
type bitmapInfoHeader struct {
	Size          uint32
	Width, Height int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPels, YPels  int32
	ClrUsed       uint32
	ClrImportant  uint32
}

func isVisible(hwnd uintptr) bool {
	r, _, _ := pIsWindowVisible.Call(hwnd)
	return r != 0
}

func screenSize() (int, int) {
	cx, _, _ := pGetSystemMetrics.Call(0) // SM_CXSCREEN
	cy, _, _ := pGetSystemMetrics.Call(1) // SM_CYSCREEN
	return int(cx), int(cy)
}

// resolveHwnd waits for the window's native hwnd and stores it — the
// caller's store feeds SetForegroundWindow / exstyle flips / ownership
// (spawned windows pass nil; their hwnd is only needed for the one-shot
// ownership apply at spawn time). Stacking needs no periodic asserts —
// game ownership does the layering; xicompanion:raise handles
// user-initiated lifts.
func resolveHwnd(w *application.WebviewWindow, store *atomic.Uintptr) {
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
}

// --------------------------------------------------------- geometry state

type rect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

type geometry struct {
	Fab *rect `json:"fab,omitempty"`
	// per-detached-tab bounds, keyed by route path ("/chat" etc.)
	Windows map[string]*rect `json:"windows,omitempty"`
	// which spawned routes were open — respawned on overlay relaunch so a
	// window the user left up comes back (close marks it false)
	Open map[string]bool `json:"open,omitempty"`
	// collapse-all toggle — persists so a reload can't strand the UI
	// hidden with no way back (a //xicompanion relaunch uncollapses)
	Collapsed bool `json:"collapsed,omitempty"`
	// cumulative content zoom from game-follow scaling — applied to every
	// window's opts.Zoom at spawn so a relaunch keeps the current scale
	Scale float64 `json:"scale,omitempty"`
	// game-follow scaling toggle from settings — nil = on (default)
	ScaleFollow *bool `json:"scaleFollow,omitempty"`
	// per-window scale picks (view-prefs cog, 0.5–4) — lets a rescale
	// compute bounds deltas and a relaunch restore each window's zoom
	Scales map[string]float64 `json:"scales,omitempty"`
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
	if geom.Scale >= 0.4 && geom.Scale <= 3.0 {
		uiScale = geom.Scale
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

func setWindowGeom(key string, r rect) {
	geomMu.Lock()
	if geom.Windows == nil {
		geom.Windows = map[string]*rect{}
	}
	geom.Windows[key] = &r
	geomMu.Unlock()
}

func setWindowOpen(key string, open bool) {
	geomMu.Lock()
	if geom.Open == nil {
		geom.Open = map[string]bool{}
	}
	geom.Open[key] = open
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
	d := filepath.Join(base, "xicompanion")
	os.MkdirAll(d, 0o755)
	return d
}

// --------------------------------------------------------------- modes

var (
	win *application.WebviewWindow
	app *application.App
)

// the fab IS the main window — "expand" just re-shows the bar inertly
func expand() {
	if win != nil && win.NativeWindow() != nil {
		go pShowWindow.Call(hwndOf(win), swShowNA)
	}
}

// "collapse" means hide — the fab is the only top-level window, so
// xic:collapse|hide simply takes it off screen
func collapse() {
	if win != nil && win.NativeWindow() != nil {
		pShowWindow.Call(hwndOf(win), swHide)
	}
}

// fabMenu grows the fab window to host an in-page dropdown: a positive
// arg adds height below the bar, a negative arg adds it above (the page
// picks the side with screen room). "0" restores the bar size. While a
// menu is open the fab's tracked geometry stays the plain bar rect so a
// mid-menu quit doesn't persist a stretched window.
var (
	fabMenuExtra int
	fabMenuPrevY int
)

func fabMenu(arg string) {
	extra, err := strconv.Atoi(strings.TrimSpace(arg))
	if err != nil {
		return
	}
	// closing (or opening a different size): undo the current grow first
	if fabMenuExtra != 0 {
		x, y := win.Position()
		if fabMenuExtra < 0 {
			y = fabMenuPrevY
		}
		win.SetSize(fabW, fabH)
		win.SetPosition(x, y)
		fabMenuExtra = 0
	}
	if extra == 0 {
		return
	}
	x, y := win.Position()
	fabMenuPrevY = y
	fabMenuExtra = extra
	if extra < 0 {
		win.SetPosition(x, y+extra)
		win.SetSize(fabW, fabH-extra)
	} else {
		win.SetSize(fabW, fabH+extra)
	}
}

func quit() {
	x, y := win.Position()
	setFabGeom(rect{X: x, Y: y, W: fabW, H: fabH})
	saveGeometry()
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
		if cur == last {
			if dirty {
				saveGeometry()
				dirty = false
			}
			continue
		}
		last = cur
		setFabGeom(cur)
		dirty = true
	}
}

// --------------------------------------------------------- spawned tabs

// Detached per-tab windows ("pop out" in the header posts xicompanion:spawn:<path>).
// Each is its own frameless game-owned Webview2 window navigated to the
// addon page with ?window=<path> — the app renders just that view plus a
// slim title bar. Bounds persist per route in window.json.
var (
	spawned = map[string]*application.WebviewWindow{}
	// spawns in flight (checked under spawnMu) — spawned[] only fills
	// once the window exists, so concurrent spawnWindow calls for the
	// same route (restore + dedicated spawn racing) made two windows
	spawnInFlight = map[string]bool{}
	spawnMu       sync.Mutex
	addonTarget   string      // probed addon base URL, set once found
	backendHidden atomic.Bool // zoning blackout / cutscene flag
	collapsed     atomic.Bool // user collapse-all toggle (fab button)
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
	// instanced routes ("/macrobar?n=2") collapse to their base —
	// additional bars join the blackout like the first
	key = strings.SplitN(key, "?", 2)[0]
	return key == "/tracker" || key == "/macrobar" || key == "/cooldowns" ||
		key == "/minimap" || key == "/party" || key == "/target" ||
		key == "/skillchain" || key == "/meter" || key == "/entities"
}

// spawnArg extracts `--spawn <route>` / `--spawn=<route>` from a command
// line — the addon uses it to open a detached window (the tracker) from
// a //xicompanion command without touching the main window.
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

// navURL appends a per-navigation cache-bust — the UDF's HTTP cache can
// serve a stale index.html when the addon restarts between the probe and
// the navigation, loading a page bundle built for a different exe (the
// "old fab page in a new-size window" breakage). A unique query never
// matches a prior cache entry.
func navURL(base string) string {
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	return fmt.Sprintf("%s%s_=%d", base, sep, time.Now().UnixNano())
}

// pageLoaded carries each window's "the app page booted" report — the
// page posts xicompanion:loaded at the end of bootstrap and RawMessageHandler
// signals the channel keyed by the source window.
var pageLoaded sync.Map // map[application.Window]chan struct{}

// armLoadRetry re-issues SetURL until the page itself posts xicompanion:loaded
// (bounded at 8 tries). A NavigationCompleted alone can't confirm the
// app landed: connection-refused error pages fire it too, which is how
// a wedged first navigation still counted as "landed" and stranded the
// window until a manual respawn. The initial grace lets a navigation
// that JUST completed (URL passed at creation) finish booting and post
// its hello instead of being pointlessly reloaded.
func armLoadRetry(w *application.WebviewWindow, url func() string) {
	loaded := make(chan struct{}, 1)
	pageLoaded.Store(w, loaded)
	go func() {
		defer pageLoaded.Delete(w)
		u := url()
		select {
		case <-loaded:
			return
		case <-time.After(1200 * time.Millisecond):
		}
		for i := 0; i < 8; i++ {
			select {
			case <-loaded:
				return
			default:
			}
			w.SetURL(u)
			select {
			case <-loaded:
				return
			case <-time.After(2500 * time.Millisecond):
			}
		}
	}()
}

// navigateWhenReady waits for a splash-page window's WebView2 core to
// come up before navigating — the fallback for spawns that happen
// before the addon URL is known (SetURL in the hwnd-yes/core-not-yet
// gap is dropped, which stranded windows on the dark splash). The
// splash's own NavigationCompleted is the ready signal; a timer covers
// the event never arriving. URL-at-creation spawns skip this entirely
// and arm the retry loop directly.
func navigateWhenReady(w *application.WebviewWindow, url func() string) {
	var started atomic.Bool
	start := func() {
		if !started.CompareAndSwap(false, true) {
			return
		}
		armLoadRetry(w, url)
	}
	w.OnWindowEvent(events.Windows.WebViewNavigationCompleted,
		func(e *application.WindowEvent) { start() })
	time.AfterFunc(3*time.Second, start)
}

func spawnWindow(route string) {
	// /visibility is retired — a stale persisted open-state must not
	// respawn a window on a dead route
	if spawnKey(route) == "/visibility" {
		return
	}
	// route may carry a deep-link query (/journal?g=&s=&id=) — the key
	// is the bare path, the query rides into the spawned window's url
	query := ""
	if i := strings.IndexByte(route, '?'); i >= 0 {
		query = route[i+1:]
	}
	key := spawnKey(route)
	// /macrobar is multi-instance: ?n=<id> gives each bar its own window,
	// geometry slot and persisted open-state; key stays the bare path for
	// route lookups (titles, fab layer, spawnPath), instKey for maps
	instKey := key
	if key == "/macrobar" && query != "" {
		if qv, err := url.ParseQuery(query); err == nil && qv.Get("n") != "" {
			instKey = key + "?n=" + qv.Get("n")
		}
	}
	spawnMu.Lock()
	if w, ok := spawned[instKey]; ok && w.NativeWindow() != nil {
		spawnMu.Unlock()
		if query != "" {
			// deep-link into the already-open window — same in-page
			// router hook the old main-window navigation used
			nav := key + "?window=1&" + query
			w.ExecJS(fmt.Sprintf(
				"window.__xicNavigate ? __xicNavigate(%s) : location.assign(%s)",
				strconv.Quote(nav), strconv.Quote(nav)))
		}
		// never activate on re-show — the user focuses a panel by
		// clicking it
		go func() { pShowWindow.Call(hwndOf(w), swShowNA) }()
		return
	}
	spawnMu.Unlock()

	// race guard: a sibling spawnWindow for this route is already
	// creating its window — only the first caller proceeds
	spawnMu.Lock()
	if spawnInFlight[instKey] {
		spawnMu.Unlock()
		return
	}
	spawnInFlight[instKey] = true
	spawnMu.Unlock()

	const minSW, minSH = 280, 180
	// friendly window titles (task switcher / screen readers — the
	// frameless windows don't paint a titlebar)
	spawnTitles := map[string]string{
		"/tracker":    "Tracker",
		"/macrobar":   "Macro Bar",
		"/cooldowns":  "Cooldowns",
		"/minimap":    "Minimap",
		"/party":      "Party",
		"/target":     "Target",
		"/skillchain": "Skillchains",
		"/meter":      "Meter",
		"/entities":   "Nearby",
	}
	title, ok := spawnTitles[key]
	if !ok {
		title = strings.TrimPrefix(key, "/")
	}
	// per-route minimums — HUD strips like /target and /party would be
	// clamped to the generic 280×180 floor (mostly dead space) and their
	// saved bounds discarded by the restore check below; the editors
	// (/macros, /journal, /profile) get the opposite treatment so the
	// floor can't squeeze their panes into mush
	mw, mh := minSW, minSH
	switch key {
	case "/target":
		mw, mh = 200, 52
	case "/party":
		mw, mh = 200, 140
	case "/meter":
		mw, mh = 240, 100
	case "/macrobar":
		// fixed-size strip — exactly the two cell rows + title bar;
		// not resizable (DisableResize below), so no border floor
		mw, mh = 584, 118
	case "/macros":
		// book sidebar + page grid + line editor
		mw, mh = 520, 340
	case "/journal":
		// group sidebar + entry list + detail pane
		mw, mh = 640, 400
	case "/profile":
		// gearswap sets: file list + icon grid + bindings panel
		mw, mh = 620, 380
	}
	opts := application.WebviewWindowOptions{
		Title:            windowTitle + " · " + title,
		Frameless:        true,
		Hidden:           true,
		BackgroundType:   application.BackgroundTypeTranslucent,
		BackgroundColour: application.NewRGB(2, 6, 23),
		Width:            560,
		Height:           420,
		MinWidth:         mw,
		MinHeight:        mh,
		Zoom:             spawnZoom(key),
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
			WebView2CompositionHosting:         true,
			NonClientRegionSupport:            true,
		},
	}
	// URL at creation skips the splash hop entirely — Wails navigates the
	// moment the webview core is up. Splash is only the fallback for the
	// (rare) spawn before the addon URL is known.
	spawnPath := strings.TrimPrefix(key, "/") + "?window=1"
	if query != "" {
		spawnPath += "&" + query
	}
	if addonTarget != "" {
		opts.URL = navURL(addonTarget + spawnPath)
	} else {
		opts.HTML = splashHTML
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
	case "/party":
		// member rows with bars + buff chips — narrow column
		opts.Width, opts.Height = 220, 300
	case "/target":
		// a slim name + HP + cast strip
		opts.Width, opts.Height = 220, 64
	case "/skillchain":
		// three columns — chains+ws | burst spells | recent
		opts.Width, opts.Height = 560, 280
	case "/meter":
		// ranked damage rows — a party-list-ish strip
		opts.Width, opts.Height = 340, 200
	case "/entities":
		// narrow entity list — same column shape as the party panel
		opts.Width, opts.Height = 240, 300
	}
	if r := geomSnapshot().Windows[instKey]; r != nil && r.W >= mw && r.H >= mh {
		opts.Width, opts.Height = r.W, r.H
		opts.X, opts.Y = r.X, r.Y
		// InitialPosition's zero value is WindowCentered — without
		// WindowXY the shell re-centers after creation and the restored
		// X/Y are ignored (same trap as the main window)
		opts.InitialPosition = application.WindowXY
	}
	if key == "/macrobar" {
		// content-sized, fixed — no resize strip on the native border.
		// Overrides the restore above too: a size saved while the bar
		// was still resizable snaps back to the content fit.
		opts.DisableResize = true
		opts.Width, opts.Height = mw, mh
		opts.MaxWidth, opts.MaxHeight = mw, mh
	}
	w := app.Window.NewWithOptions(opts)

	spawnMu.Lock()
	spawned[instKey] = w
	delete(spawnInFlight, instKey)
	spawnMu.Unlock()
	// async — ExecJS waits on the main window's dispatcher; a synchronous
	// call here would stall the navigation goroutines below (window
	// stuck on splash) if the dispatcher ever backs up
	go windowsReport()

	w.OnWindowEvent(events.Common.WindowMinimise, func(e *application.WindowEvent) {
		// restore without activation — an activating Show() here loops:
		// game takes fg → we auto-minimize → Show() activates → the fg
		// watcher hands focus back → auto-minimize again, ~1s cycle
		pShowWindow.Call(hwndOf(w), swShowNA)
	})

	go func() {
		// created Hidden — apply flags/ownership, THEN reveal with
		// SW_SHOWNA: no path to foreground exists. (A window that lands
		// fg before its NOACTIVATE exstyle is applied keeps it — that
		// race locked the game's keyboard.)
		for i := 0; i < 60 && w.NativeWindow() == nil; i++ {
			time.Sleep(50 * time.Millisecond)
		}
		hwnd := hwndOf(w)
		if hwnd == 0 {
			return
		}
		setClassCursor(hwnd)
		subclassWindow(hwnd)
		thickFrame(hwnd)
		if fabLayerSpawned(key) {
			// keeps the panel (and its transparent margins) from ever
			// stealing the game's keyboard
			setStyleFlag(hwnd, wsExNoActivate, true)
			// a fab-layer window is owned by the main window — owned
			// windows always outrank their owner in z-order, so it can
			// never slide under the UI (same trick as the item
			// tooltip). It also follows the owner's hide during the
			// blackout.
			for i := 0; i < 40 && windowHwnd.Load() == 0; i++ {
				time.Sleep(50 * time.Millisecond)
			}
			if owner := windowHwnd.Load(); owner != 0 {
				pSetWindowLongPtr.Call(hwnd, uintptr(gwlpOwner), owner)
			}
		} else {
			// editor panels own straight to the game — always above it,
			// always under foreign apps, and they die with the owner.
			// NOACTIVATE is held through the reveal (SW_SHOW can't
			// activate a NOACTIVATE window) then cleared so the panel
			// activates normally on user clicks — never on its own.
			setStyleFlag(hwnd, wsExNoActivate, true)
			ownToGame(hwnd)
		}
		// FIRST reveal goes through w.Show() — it wakes the WebView2
		// controller a Hidden-created window starts without; every
		// later hide/show stays raw swHide/swShowNA so the controller
		// never re-hides (a raw reshow after w.Hide() paints nothing)
		w.Show()
		if !fabLayerSpawned(key) {
			setStyleFlag(hwnd, wsExNoActivate, false)
		}
		// spawned while collapsed or mid-blackout (zoning) goes straight
		// back down — the watchers restore it when the world comes back
		if collapsed.Load() ||
			(fabLayerSpawned(key) && backendHidden.Load()) {
			pShowWindow.Call(hwnd, swHide)
		}
	}()
	if addonTarget != "" {
		armLoadRetry(w, func() string { return opts.URL })
	} else {
		navigateWhenReady(w, func() string {
			target := addonTarget
			if target == "" {
				target = probeTarget()
			}
			// navigate to the route itself (?window=1 flags detached
			// chrome) so nested routes like /profile/sets resolve normally
			return navURL(target + spawnPath)
		})
	}
	go trackSpawned(w, instKey)
	setWindowOpen(instKey, true)
	saveGeometry()
	// stamp the current collapse-all state — queued ExecJS flushes
	// once the page finishes loading
	w.ExecJS(fmt.Sprintf(
		"window.__xicCollapsed&&window.__xicCollapsed(%v)", collapsed.Load()))
	log.Printf("spawned window %q", key)
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
	setWindowOpen(key, false)
	saveGeometry()
	go windowsReport()
	if dirty {
		saveGeometry()
	}
	log.Printf("window %q closed", key)
}

// toggleWindow opens a detached window when its route isn't up and
// closes it when it is — the fab's menu-bar buttons are toggles.
func toggleWindow(route string) {
	key := spawnKey(route)
	spawnMu.Lock()
	w, ok := spawned[key]
	spawnMu.Unlock()
	if ok {
		unownTooltip(hwndOf(w)) // owned windows die with the owner
		w.Close()               // trackSpawned's teardown drops it + reports
		return
	}
	spawnWindow(route)
}

// windowsReport pushes the list of open spawned routes to the main
// window — the fab's menu bar marks the ones that are up. Called on
// every spawn/close; the page also asks (xicompanion:windows) on load.
func windowsReport() {
	if win == nil || win.NativeWindow() == nil {
		return
	}
	spawnMu.Lock()
	keys := make([]string, 0, len(spawned))
	seen := map[string]bool{}
	for k := range spawned {
		// instanced routes ("/macrobar?n=x") collapse to their base
		// path — the menu only marks whether a panel kind is open
		k = strings.SplitN(k, "?", 2)[0]
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	spawnMu.Unlock()
	slices.Sort(keys)
	b, err := json.Marshal(keys)
	if err != nil {
		return
	}
	win.ExecJS("window.__xicWindows && window.__xicWindows(" + string(b) + ")")
	// the shared menu window marks open rows with the same list
	fabMenuMu.Lock()
	mw := fabMenuWin
	fabMenuMu.Unlock()
	if mw != nil && mw.NativeWindow() != nil {
		mw.ExecJS("window.__xicWindows && window.__xicWindows(" + string(b) + ")")
	}
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
// Message form: xicompanion:geom-set:<key>:<x>,<y>[,<w>,<h>]
func geomSet(arg string) {
	sep := strings.LastIndexByte(arg, ':')
	if sep < 0 {
		return
	}
	key, nums := arg[:sep], arg[sep+1:]
	if key != "fab" {
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
		old := geomSnapshot().Windows[key]
		if key == "fab" {
			old = geomSnapshot().Fab
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
	if key == "fab" {
		// the bar is fixed-size — only position is persisted/applied;
		// a W/H in the message (or a stale saved one) can't inflate it
		r.W, r.H = fabW, fabH
		setFabGeom(r)
	} else {
		setWindowGeom(key, r)
	}
	saveGeometry()

	// live-apply — these window methods InvokeSync internally, so this
	// stays on the caller's goroutine like the other handlers.
	if key == "fab" {
		if win != nil && win.NativeWindow() != nil {
			win.SetPosition(r.X, r.Y)
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
	// no main window anymore — open the route as a detached window,
	// deep-link query preserved (/journal?g=&s=&id= selects the entry)
	spawnWindow(path)
}

// closeFor routes xicompanion:close from a page: a spawned window is destroyed,
// the tooltip and fab menu hide, the main window collapses to the fab.
func closeFor(w application.Window) {
	if w == tooltipWin {
		tooltipHide()
		return
	}
	fabMenuMu.Lock()
	mw := fabMenuWin
	fabMenuMu.Unlock()
	if w == mw {
		fabMenuHide()
		return
	}
	spawnMu.Lock()
	for _, sw := range spawned {
		if sw == w {
			spawnMu.Unlock()
			unownTooltip(hwndOf(sw)) // owned windows die with the owner
			sw.Close()
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
	tooltipOwner  atomic.Uintptr
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
// An owned window ALWAYS sits above its owner in z-order — the tooltip
// can't slide underneath the window that summoned it.
// (Also dies with its owner, which is correct for a tooltip.) A zero
// ownerHwnd detaches — see unownTooltip for why that must happen first.
func setTooltipOwner(ownerHwnd uintptr) {
	th := tooltipHwnd.Load()
	if th == 0 || th == ownerHwnd {
		return
	}
	pSetWindowLongPtr.Call(th, uintptr(gwlpOwner), ownerHwnd)
	tooltipOwner.Store(ownerHwnd)
}

// unownTooltip detaches the tooltip before its owner is destroyed.
// Windows kills owned windows with their owner WITHOUT running our
// close path — the WebviewWindow keeps a stale live-looking handle,
// and every later tooltipShow would ExecJS/Show into a dead hwnd
// instead of recreating. Skip this and the tooltip can never open
// again once its summoning window has closed.
func unownTooltip(ownerHwnd uintptr) {
	if ownerHwnd != 0 && tooltipOwner.Load() == ownerHwnd {
		setTooltipOwner(0)
	}
}

// isWindow asks the OS whether the hwnd still exists — owned windows
// die silently with their owner, so a non-zero stored hwnd isn't
// proof of life (the Wails window object isn't told either)
func isWindow(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	r, _, _ := pIsWindow.Call(hwnd)
	return r != 0
}

// applyCollapsed hides or restores the whole overlay family on the
// user's collapse-all toggle — same mechanics as the old fg-hidden
// path, but only fires on an explicit command. Restores go through
// SW_SHOWNA so focus stays with the game.
func applyCollapsed(hide bool) {
	if !collapsed.CompareAndSwap(!hide, hide) {
		return
	}
	log.Printf("collapsed=%v", hide)
	// persist so the toggle survives an overlay relaunch — a hidden
	// restore loop runs on startup when it was left on
	geomMu.Lock()
	geom.Collapsed = hide
	geomMu.Unlock()
	saveGeometry()
	op := uintptr(swHide)
	if !hide {
		op = swShowNA
	}
	apply := func(w application.Window) {
		if w == nil {
			return
		}
		if hwnd := hwndOf(w); hwnd != 0 {
			pShowWindow.Call(hwnd, op)
		}
	}
	// the fab is part of the overlay family — it hides too. Restore comes
	// via //xicompanion (relaunch → OnSecondInstanceLaunch uncollapses).
	if hide || !backendHidden.Load() {
		apply(win)
	}
	spawnMu.Lock()
	var list []*application.WebviewWindow
	keys := map[*application.WebviewWindow]string{}
	for k, sw := range spawned {
		list = append(list, sw)
		keys[sw] = k
	}
	spawnMu.Unlock()
	for _, sw := range list {
		if !hide && backendHidden.Load() && fabLayerSpawned(keys[sw]) {
			continue
		}
		apply(sw)
	}
	tooltipMu.Lock()
	tw := tooltipWin
	tooltipMu.Unlock()
	if tw != nil {
		apply(tw)
	}
	// keep every page's collapsed flag in sync — pages stash it for
	// their own chrome decisions
	b := fmt.Sprintf(
		"window.__xicCollapsed&&window.__xicCollapsed(%v)", hide)
	win.ExecJS(b)
	for _, sw := range list {
		sw.ExecJS(b)
	}
}

func hwndOf(w application.Window) uintptr {
	// NativeWindow is on the Window interface — no cast needed. The
	// handler's w comes from the app's window map as the interface type,
	// so asserting *WebviewWindow returned 0 for every page message
	if w == nil || w.NativeWindow() == nil {
		return 0
	}
	return uintptr(w.NativeWindow())
}

func tooltipShow(caller application.Window, raw string) {
	var m tooltipMsg
	if json.Unmarshal([]byte(raw), &m) != nil || m.ID == 0 {
		return
	}
	tooltipPinned.Store(m.Pinned)
	tipShownAt = time.Now()
	if m.Pinned {
		tipWatchGen.Add(1)
		go tipClickWatch(tipWatchGen.Load())
	}
	tooltipMu.Lock()
	w := tooltipWin
	tooltipMu.Unlock()
	th := tooltipHwnd.Load()
	if w == nil || w.NativeWindow() == nil || (th != 0 && !isWindow(th)) {
		// a dead hwnd means the tooltip went down with its owner —
		// drop the zombie references and build a fresh window
		tooltipMu.Lock()
		tooltipWin = nil
		tooltipMu.Unlock()
		tooltipHwnd.Store(0)
		tooltipCreate(m, hwndOf(caller))
		return
	}
	setTooltipOwner(hwndOf(caller))
	setClassCursor(tooltipHwnd.Load())
	subclassWindow(tooltipHwnd.Load())
	setClickable(tooltipHwnd.Load(), m.Pinned)
	payload, _ := json.Marshal(m)
	w.ExecJS(fmt.Sprintf(
		"window.__xicTooltip&&window.__xicTooltip(%s)", payload))
	// snap the OS window to card dims every show — Wails SetSize can
	// miss hidden-created windows, the raw call can't
	var r wRect
	pGetWindowRect.Call(tooltipHwnd.Load(), uintptr(unsafe.Pointer(&r)))
	ws, wh := w.Size()
	log.Printf("tooltip: hwnd=%x wails-size=%dx%d os-rect=%d,%d %dx%d want=%dx%d",
		tooltipHwnd.Load(), ws, wh, r.left, r.top,
		int(r.right-r.left), int(r.bottom-r.top), tipW, tipH)
	if int(r.right-r.left) != tipW || int(r.bottom-r.top) != tipH {
		pSetWindowPos.Call(tooltipHwnd.Load(), 0, 0, 0,
			uintptr(tipW), uintptr(tipH), swpNoMove|swpNoActivate)
	}
	// retargeting while visible must leave the card where the user
	// put it — only a fresh show re-anchors to the clicked element
	if r, _, _ := pIsWindowVisible.Call(tooltipHwnd.Load()); r == 0 {
		w.SetPosition(m.X, m.Y)
	}
	pShowWindow.Call(tooltipHwnd.Load(), swShowNA)
}

const (
	tipW = 320
	tipH = 440
)

func tooltipCreate(m tooltipMsg, ownerHwnd uintptr) {
	opts := application.WebviewWindowOptions{
		// fresh identity — whatever cached the old window's fullscreen
		// bounds keys off the name/title, so this build can't restore it
		Name:             "xic-itemtip",
		Title:            windowTitle + " · item",
		Frameless:        true,
		Hidden:           true,
		BackgroundType:   application.BackgroundTypeTransparent,
		BackgroundColour: application.NewRGB(2, 6, 23),
		Width:            tipW,
		Height:           tipH,
		MaxWidth:         tipW,
		Zoom:             curScale(),
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
			WebView2CompositionHosting:         true,
			NonClientRegionSupport:            true,
		},
	}
	// URL at creation skips the splash hop (see spawnWindow)
	tipPath := fmt.Sprintf("?tooltip=1&bag=%d&slot=%d&id=%d&pinned=%d",
		m.Bag, m.Slot, m.ID, btoi(m.Pinned))
	if m.Name != "" {
		tipPath += "&name=" + url.QueryEscape(m.Name)
	}
	if addonTarget != "" {
		opts.URL = navURL(addonTarget + tipPath)
	} else {
		opts.HTML = splashHTML
	}
	w := app.Window.NewWithOptions(opts)
	tooltipMu.Lock()
	tooltipWin = w
	tooltipMu.Unlock()

	w.OnWindowEvent(events.Common.WindowMinimise, func(e *application.WindowEvent) {
		pShowWindow.Call(hwndOf(w), swShowNA)
	})

	go resolveHwnd(w, &tooltipHwnd)
	go func() {
		for i := 0; i < 100 && w.NativeWindow() == nil; i++ {
			time.Sleep(100 * time.Millisecond)
		}
		if w.NativeWindow() == nil {
			return // create failed
		}
		for i := 0; i < 50 && tooltipHwnd.Load() == 0; i++ {
			time.Sleep(50 * time.Millisecond)
		}
		setTooltipOwner(ownerHwnd)
		setClickable(tooltipHwnd.Load(), m.Pinned)
		// hidden-created windows can come up at the screen rect — the
		// controller is awake here so bounds actually apply
		w.SetSize(tipW, tipH)
		w.SetPosition(m.X, m.Y)
		// first reveal must be w.Show() — wakes the WebView2 controller
		// Hidden-created windows start without; NOACTIVATE (set by
		// setClickable) already holds so it can't activate
		w.Show()
	}()
	if addonTarget != "" {
		armLoadRetry(w, func() string { return opts.URL })
	} else {
		navigateWhenReady(w, func() string {
			target := addonTarget
			if target == "" {
				target = probeTarget()
			}
			return navURL(target + tipPath)
		})
	}
	log.Printf("tooltip window created")
}

func tooltipHide() {
	tooltipPinned.Store(false)
	tipWatchGen.Add(1)
	tooltipMu.Lock()
	w := tooltipWin
	tooltipMu.Unlock()
	if w != nil && w.NativeWindow() != nil {
		pShowWindow.Call(hwndOf(w), swHide)
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

// -------------------------------------------------------- fab menu

// The fab's group dropdowns live in one shared hidden window — the bar
// itself stays 540x56 instead of growing to host a menu. The fab page
// passes the group key + screen rect; retargets swap content over
// ExecJS (__xicMenu) like the tooltip's __xicTooltip.
var (
	fabMenuWin  *application.WebviewWindow
	fabMenuHwnd atomic.Uintptr
	fabMenuMu   sync.Mutex
	// menuKind tracks what the shared menu window currently renders:
	// "g" = fab group menu, "j" = a page-spec'd dropdown (group "j:<json>"
	// pushed by pickMenu). Same-kind retargets stay on ExecJS; kind
	// flips force a SetURL so the right component mounts.
	menuKind      string
	menuRequester application.Window // spec-menu owner — picks relay here
	menuWatchGen  atomic.Int32       // click-watcher generation (per show)
	// stamp of the last tooltip show — a dismiss racing a fresh
	// show (click → raise → tooltip: on the same window) must lose
	tipShownAt  time.Time
	tipWatchGen atomic.Int32 // click-watcher generation (per show)
	// a show deferred until the new page reports loaded — kills the
	// stale-content flash when a retarget reloads the menu window
	menuPendingShow bool
	// when the last show was requested — passive dismiss paths (outside
	// clicks, interaction messages) can't close a menu younger than
	// this, which guarantees a hide can never outrun its show
	menuShownAt time.Time
	// the requested screen rect — the page reports its real card size
	// (menu-size) and the window snaps to it; up menus bottom-anchor
	menuScrX, menuScrY, menuScrH int
	menuUp                     bool
)

// virtualScreen is the union of all monitors — the shared menu window
// spans it transparently so backdrop clicks land inside our own window
// (dismiss) instead of passing through to the game
func virtualScreen() (x, y, w, h int) {
	x1, _, _ := pGetSystemMetrics.Call(76) // SM_XVIRTUALSCREEN
	y1, _, _ := pGetSystemMetrics.Call(77) // SM_YVIRTUALSCREEN
	w1, _, _ := pGetSystemMetrics.Call(78) // SM_CXVIRTUALSCREEN
	h1, _, _ := pGetSystemMetrics.Call(79) // SM_CYVIRTUALSCREEN
	return int(int32(x1)), int(int32(y1)), int(w1), int(h1)
}


// interaction on ANY other window dismisses the shared menu — every
// overlay window is WS_EX_NOACTIVATE so clicks never move OS focus;
// these messages are the only "focus changed" signal that exists
func menuDismissable(m string) bool {
	return strings.HasPrefix(m, "xicompanion:raise") ||
		strings.HasPrefix(m, "xicompanion:drag") ||
		strings.HasPrefix(m, "xicompanion:resize:") ||
		strings.HasPrefix(m, "xicompanion:geom-set:") ||
		strings.HasPrefix(m, "xicompanion:spawn:") ||
		strings.HasPrefix(m, "xicompanion:toggle:") ||
		strings.HasPrefix(m, "xicompanion:main:")
}

// xicompanion:fabmenu-show:<group>:<x>,<y>,<w>,<h>[,<up>] — x/y/w/h are
// screen px; the optional up flag (default 1) tells the menu whether it
// opened above the bar so it bottom-anchors flush to the buttons
func fabMenuShow(arg string, req application.Window) {
	sep := strings.LastIndexByte(arg, ':')
	if sep < 0 {
		return
	}
	group, nums := arg[:sep], arg[sep+1:]
	f := strings.Split(nums, ",")
	if (len(f) != 4 && len(f) != 5) || group == "" {
		return
	}
	var v [4]int
	for i, s := range f[:4] {
		n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			return
		}
		v[i] = int(math.Round(n))
	}
	x, y, w, h := v[0], v[1], v[2], v[3]
	if w <= 0 || h <= 0 {
		return
	}
	up := true
	if len(f) == 5 {
		up = strings.TrimSpace(f[4]) != "0"
	}
	kind := "g"
	if strings.HasPrefix(group, "j:") {
		kind = "j"
		// spec payloads arrive URL-encoded (JSON colons/commas would
		// break the <group>:<nums> split) — decode once here so the
		// URL/ExecJS paths downstream carry plain "j:{...}"
		if d, err := url.QueryUnescape(group); err == nil {
			group = d
		}
		// spec menus post CLIENT coords (viewport px of the requesting
		// window — screenX/Y misreport on NOACTIVATE webviews) — shift
		// to screen px via the requester's own window position
		if req != nil {
			wx, wy := req.Position()
			x += wx
			y += wy
		}
	}
	// the menu window hugs the requested rect — the page reports its
	// real card size via menu-size and we snap to it (no backdrop:
	// clicks land on the game/our windows and dismiss through their
	// own signals)
	menuScrX, menuScrY, menuScrH, menuUp = x, y, h, up
	// arm the outside-click watcher — clicks on the game (or any other
	// app) never reach the message channel, so the only way to catch
	// them is polling the button + WindowFromPoint while the menu's up
	menuWatchGen.Add(1)
	go menuClickWatch(menuWatchGen.Load())
	fabMenuMu.Lock()
	menuShownAt = time.Now()
	menuRequester = nil
	if kind == "j" {
		menuRequester = req
	}
	mw := fabMenuWin
	fabMenuMu.Unlock()
	mh := fabMenuHwnd.Load()
	if mw == nil || mw.NativeWindow() == nil || (mh != 0 && !isWindow(mh)) {
		// dead hwnd → drop the zombie refs and rebuild (same pattern
		// as the tooltip's owner-death recovery)
		fabMenuMu.Lock()
		fabMenuWin = nil
		fabMenuMu.Unlock()
		fabMenuHwnd.Store(0)
		fabMenuCreate(group, x, y, w, h, up)
		return
	}
	if kind != menuKind {
		// different content type than what's mounted — reload it via
		// the URL so the right component boots (ExecJS would target a
		// handler the other kind doesn't define)
		menuKind = kind
		if addonTarget != "" {
			mp := fmt.Sprintf("fabmenu?window=1&g=%s&w=%d&h=%d",
				url.QueryEscape(group), w, h)
			if !up {
				mp += "&up=0"
			}
			// hide the stale page first — SetURL reloads and the old
			// content would flash at fullscreen until the new one
			// commits; reveal when it reports loaded
			if hwnd := hwndOf(mw); hwnd != 0 {
				pShowWindow.Call(hwnd, swHide)
			}
			mw.SetURL(navURL(addonTarget + mp))
			fabMenuMu.Lock()
			menuPendingShow = true
			fabMenuMu.Unlock()
		}
	} else {
		mw.ExecJS(fmt.Sprintf(
			"window.__xicMenu&&window.__xicMenu(%s,%v,%d,%d,%d,%d)",
			strconv.Quote(group), up, 0, 0, w, h))
	}
	mw.SetPosition(x, y)
	mw.SetSize(w, h)
	fabMenuMu.Lock()
	pending := menuPendingShow
	fabMenuMu.Unlock()
	if pending {
		return // reveal on xicompanion:loaded
	}
	// w.Show() (not a raw reshow) — the window was created Hidden so
	// its WebView2 controller needs waking; NOACTIVATE holds so the
	// SW_SHOW inside can't activate it
	mw.Show()
	// lift to the top of the band — the requesting panel can otherwise
	// cover the menu and it reads as a flash-on-then-off
	pSetWindowPos.Call(hwndOf(mw), hwndTop, 0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoActivate)
	// refresh the ● open marks — a freshly-created menu's ExecJS queue
	// flushes on page load, so this covers the create path too
	go windowsReport()
}

func fabMenuCreate(group string, x, y, w, h int, up bool) {
	// transparent host at the requested rect — the page measures its
	// card and menu-size snaps the window to it
	opts := application.WebviewWindowOptions{
		Title:            windowTitle + " · menu",
		Frameless:        true,
		Hidden:           true,
		DisableResize:    true,
		BackgroundType:   application.BackgroundTypeTranslucent,
		BackgroundColour: application.NewRGB(2, 6, 23),
		Width:            w,
		Height:           h,
		MinWidth:         100,
		MinHeight:        40,
		Zoom:             curScale(),
		X:                x,
		Y:                y,
		InitialPosition:  application.WindowXY,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
			WebView2CompositionHosting:         true,
			NonClientRegionSupport:            true,
		},
	}
	// the card fills the window — no anchor params needed
	menuPath := fmt.Sprintf("fabmenu?window=1&g=%s&w=%d&h=%d",
		url.QueryEscape(group), w, h)
	if !up {
		menuPath += "&up=0"
	}
	if addonTarget != "" {
		opts.URL = navURL(addonTarget + menuPath)
	} else {
		opts.HTML = splashHTML
	}
	mw := app.Window.NewWithOptions(opts)
	fabMenuMu.Lock()
	fabMenuWin = mw
	if strings.HasPrefix(group, "j:") {
		menuKind = "j"
	} else {
		menuKind = "g"
	}
	// reveal only once the page boots — showing the splash-sized
	// window first flashed stale/blank content at fullscreen
	menuPendingShow = true
	fabMenuMu.Unlock()

	mw.OnWindowEvent(events.Common.WindowMinimise, func(e *application.WindowEvent) {
		pShowWindow.Call(hwndOf(mw), swShowNA)
	})

	go resolveHwnd(mw, &fabMenuHwnd)
	go func() {
		// NOACTIVATE + owned-by-main — same fab-layer treatment as the
		// tracker panels: no keyboard steal, always above the bar, and
		// follows the fab's hide during blackout
		for i := 0; i < 60 && mw.NativeWindow() == nil; i++ {
			time.Sleep(50 * time.Millisecond)
		}
		if mw.NativeWindow() == nil {
			return
		}
		hwnd := uintptr(mw.NativeWindow())
		setClassCursor(hwnd)
		subclassWindow(hwnd)
		setStyleFlag(hwnd, wsExNoActivate, true)
		for i := 0; i < 40 && windowHwnd.Load() == 0; i++ {
			time.Sleep(50 * time.Millisecond)
		}
		if owner := windowHwnd.Load(); owner != 0 {
			pSetWindowLongPtr.Call(hwnd, uintptr(gwlpOwner), owner)
		}
	}()
	if addonTarget != "" {
		armLoadRetry(mw, func() string { return opts.URL })
	} else {
		navigateWhenReady(mw, func() string {
			target := addonTarget
			if target == "" {
				target = probeTarget()
			}
			return navURL(target + menuPath)
		})
	}
	// the ExecJS queue flushes once the page boots — lands the open
	// window list (● marks) without waiting for a spawn/close event
	go windowsReport()
	log.Printf("fab menu window created")
}

// menuClickWatch dismisses the shared menu when a click lands outside
// it — runs only while the menu is visible. Generation guards against
// stacking: a retarget bumps the gen and the previous watcher exits.
func menuClickWatch(gen int32) {
	// let the click that opened the menu release before arming — it
	// lands on the cog/bar itself and would instantly close it
	for i := 0; i < 60; i++ {
		if v, _, _ := pGetAsyncKeyState.Call(vkLButton); v&0x8000 == 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	for menuWatchGen.Load() == gen {
		mh := fabMenuHwnd.Load()
		if mh == 0 {
			// hwnd not resolved yet (fresh create) — give it a moment
			time.Sleep(200 * time.Millisecond)
			if fabMenuHwnd.Load() == 0 {
				return
			}
			continue
		}
		if r, _, _ := pIsWindowVisible.Call(mh); r == 0 {
			return // hidden — done
		}
		if v, _, _ := pGetAsyncKeyState.Call(vkLButton); v&0x8000 != 0 {
			var pt wPoint
			pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
			// clicks inside the card's rect keep it — compare against
			// the real OS rect, not hwnd identity (invisible frame
			// overhang would otherwise swallow the dismiss)
			var tr wRect
			pGetWindowRect.Call(mh, uintptr(unsafe.Pointer(&tr)))
			if pt.x >= tr.left && pt.x < tr.right &&
				pt.y >= tr.top && pt.y < tr.bottom {
				time.Sleep(40 * time.Millisecond)
				continue
			}
			if time.Since(menuShownAt) > 300*time.Millisecond {
				fabMenuHide()
			}
			return
		}
		time.Sleep(40 * time.Millisecond)
	}
}

// tipClickWatch dismisses a pinned tooltip when a click lands outside
// it — identical poll to the menu watcher: our windows are all
// NOACTIVATE so clicks on the game or other apps produce no focus
// event; button + WindowFromPoint is the only outside signal
func tipClickWatch(gen int32) {
	// let the click that opened the tip release before arming
	for i := 0; i < 60; i++ {
		if v, _, _ := pGetAsyncKeyState.Call(vkLButton); v&0x8000 == 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	for tipWatchGen.Load() == gen {
		th := tooltipHwnd.Load()
		if th == 0 {
			time.Sleep(200 * time.Millisecond)
			if tooltipHwnd.Load() == 0 {
				return
			}
			continue
		}
		if r, _, _ := pIsWindowVisible.Call(th); r == 0 {
			return // hidden — done
		}
		if v, _, _ := pGetAsyncKeyState.Call(vkLButton); v&0x8000 != 0 {
			var pt wPoint
			pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
			// click inside the card's rect — keep watching (WindowFromPoint
			// can't be trusted: the frame's invisible overhang would
			// report our own hwnd for clicks beside the card)
			var tr wRect
			pGetWindowRect.Call(th, uintptr(unsafe.Pointer(&tr)))
			if pt.x >= tr.left && pt.x < tr.right &&
				pt.y >= tr.top && pt.y < tr.bottom {
				time.Sleep(40 * time.Millisecond)
				continue
			}
			if time.Since(tipShownAt) > 300*time.Millisecond {
				tooltipHide()
			}
			return
		}
		time.Sleep(40 * time.Millisecond)
	}
}

func fabMenuHide() {
	fabMenuMu.Lock()
	w := fabMenuWin
	// a dismiss also cancels a deferred reveal — hiding between the
	// SetURL and the loaded event must not spring back open
	menuPendingShow = false
	fabMenuMu.Unlock()
	// nil pointer boxed into the Window interface isn't == nil inside
	// hwndOf — bail early or a hide with no menu up panics on it
	if w == nil {
		return
	}
	// raw SW_HIDE — w.Hide() also drops the WebView2 controller's
	// IsVisible, which our swShowNA reshow never restores (the menu
	// would "open" as an invisible frame). Raw hide/show pairs match
	// what applyCollapsed does for every window.
	if hwnd := hwndOf(w); hwnd != 0 {
		pShowWindow.Call(hwnd, swHide)
	}
	// the bar's open-state lives in its own JS context — nudge it so
	// the group button's glow clears on menu-side closes too
	if win != nil && win.NativeWindow() != nil {
		win.ExecJS("window.__xicMenuClosed&&window.__xicMenuClosed()")
	}
}

// watchBackend tracks the addon server every 2s. It quits the overlay
// when the server disappears — the addon taskkills us on unload/logout,
// but a game exit takes the Lua state down before that handler runs.
// It also hides the fab while the addon reports "hidden" (zoning
// blackout, cutscenes) — the same states in-render addons stop drawing
// for. Only the fab hides: the full UI and spawned windows stay up.
// httpGet adapts watchBackend's polls to plain fetch — xport builds
// the same shape over the active backend (xpGet in transport.go).
func httpGet(base string) func(string) ([]byte, error) {
	client := &http.Client{Timeout: 2 * time.Second}
	return func(p string) ([]byte, error) {
		resp, err := client.Get(base + p)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		return io.ReadAll(resp.Body)
	}
}

func watchBackend(get func(string) ([]byte, error)) {
	misses := 0
	lastBoot := 0          // addon reload marker from /api/status
	hidden := false        // currently applied fab-visibility, not the raw flag
	spawnedHidden := false // fab-layer spawned windows during the blackout
	for {
		time.Sleep(2 * time.Second)
		body, err := get("api/status")
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
			Boot   int  `json:"boot"`
		}
		json.Unmarshal(body, &st)
		// addon reload: the server only blips for a second — too short
		// for the misses counter — but it comes back with a new boot
		// marker. Quit so the fresh deploy (and its fixes) launches.
		if st.Boot != 0 && lastBoot != 0 && st.Boot != lastBoot {
			log.Print("addon reloaded, quitting")
			app.Quit()
			return
		}
		if st.Boot != 0 {
			lastBoot = st.Boot
		}
		backendHidden.Store(st.Hidden)
		// recomputed every poll so mode transitions during a blackout
		// self-correct: hide during a cutscene, restore after
		want := st.Hidden
		if want != hidden {
			hidden = want
			log.Printf("fab hidden=%v", hidden)
			if hidden {
				pShowWindow.Call(hwndOf(win), swHide)
			} else {
				pShowWindow.Call(hwndOf(win), swShowNA)
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
					pShowWindow.Call(hwndOf(sw), swHide)
				} else {
					pShowWindow.Call(hwndOf(sw), swShowNA)
				}
			}
		}
		// drain the addon's spawn queue — routes it wants opened as
		// detached windows, '!show' surfaces the bar. Enqueued spawns
		// avoid relaunching the exe per panel (every launch flashed a
		// taskbar entry)
		if sbody, serr := get("api/spawn"); serr == nil {
			var sq struct {
				Routes []string `json:"routes"`
			}
			json.Unmarshal(sbody, &sq)
			for _, r := range sq.Routes {
				if r == "!show" {
					applyCollapsed(false)
					if hwnd := hwndOf(win); hwnd != 0 {
						pShowWindow.Call(hwnd, swShowNA)
					}
				} else {
					go spawnWindow(r)
				}
			}
			if len(sq.Routes) > 0 {
				focusGameSoon()
			}
		}
	}
}

func main() {

	geomPath = filepath.Join(dataDir(), "window.json")
	loadGeometry()

	logf, err := os.OpenFile(filepath.Join(dataDir(), "overlay.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		log.SetOutput(logf)
		// every relaunch appends to the same file — tag lines with pid so
		// a doomed second instance's traces can't masquerade as ours
		log.SetPrefix(fmt.Sprintf("[pid %d] ", os.Getpid()))
		defer logf.Close()
	}

	appOpts := application.Options{
		Name: "xicompanion-overlay",
		// //xicompanion overlay (and the addon's auto-fab spawn on load) can fire
		// repeatedly — surface the existing window instead of stacking.
		// A plain relaunch expands the UI; a --fab relaunch (addon reload)
		// just makes sure the button is visible.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.xicompanion.overlay",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				log.Printf("second instance: args=%v", data.Args)
				if win == nil {
					return
				}
				// //xicompanion tracker & friends — open just the detached window;
				// the main window stays in whatever mode it's in
				if route, ok := spawnArg(data.Args); ok {
					go spawnWindow(route)
					return
				}
				go func() {
					// a --fab relaunch during the zoning blackout must
					// not flash the hidden fab back on screen
					if backendHidden.Load() {
						return
					}
					// any //xicompanion command is an un-collapse too —
					// bring the whole family back (fab included). Show
					// only — no focus stealing from the game.
					applyCollapsed(false)
					pShowWindow.Call(hwndOf(win), swShowNA)
				}()
			},
		},
		// the page is a foreign-origin document — Wails' own "wails:*"
		// messages reach HandleMessage directly, anything else lands here.
		// win methods go through InvokeSync internally, so they must run
		// off the main thread that invokes this handler — hence the gos.
		RawMessageHandler: func(w application.Window, message string, _ *application.OriginInfo) {
			// clicks on any other window dismiss the shared menu —
			// NOACTIVATE windows never take OS focus, so interaction
			// messages are the only "focus moved" signal available.
			// Debounced: a raise always precedes a cog's pickMenu on the
			// same window, and the show bumps the gen — the stale hide
			// must not land after it
			if fabMenuWin != nil && w != fabMenuWin && menuDismissable(message) {
				gen := menuWatchGen.Load()
				go func() {
					time.Sleep(100 * time.Millisecond)
					// gen guards a same-channel show; the age guard is
					// the backstop — nothing that predates the menu may
					// close it, whatever path it took
					if menuWatchGen.Load() == gen &&
						time.Since(menuShownAt) > 300*time.Millisecond {
						fabMenuHide()
					}
				}()
			}
			// clicking any other overlay window dismisses the item
			// tooltip — same debounce+age guard as the menu so a
			// raise that precedes a fresh tooltip can't close it
			if tooltipWin != nil && w != tooltipWin && menuDismissable(message) {
				go func() {
					time.Sleep(100 * time.Millisecond)
					if time.Since(tipShownAt) > 300*time.Millisecond {
						tooltipHide()
					}
				}()
			}
			log.Printf("page message: %q", message)
			switch {
			case message == "xicompanion:expand":
				go expand()
			case message == "xicompanion:collapse" || message == "xicompanion:hide":
				go collapse()
			case message == "xicompanion:collapseall":
				// fab's collapse-all button — hides every overlay window
				// (including the fab bar) until pressed again
				go applyCollapsed(!collapsed.Load())
			case message == "xicompanion:quit":
				go quit()
			case message == "xicompanion:close":
				go func() {
					// give the game focus BEFORE the destroy — if we
					// close while our window still holds it, Windows
					// picks the next topmost window (which can be a
					// foreign app) before we can correct it
					if g := gameHwnd(); g != 0 {
						pSetForegroundWindow.Call(g)
						time.Sleep(50 * time.Millisecond)
					}
					closeFor(w) // spawned window → destroy; main → collapse
				}()
			case strings.HasPrefix(message, "xicompanion:spawn:"):
				go spawnWindow(strings.TrimPrefix(message, "xicompanion:spawn:"))
			case strings.HasPrefix(message, "xicompanion:toggle:"):
				go toggleWindow(strings.TrimPrefix(message, "xicompanion:toggle:"))
			case message == "xicompanion:focus-game":
				// a completed page click hands keyboard focus back to
				// the game — the page skips presses that began a
				// drag/resize or landed in an editable element. Guard
				// on an overlay window actually holding foreground:
				// NOACTIVATE panels never take it, and we must not
				// yank a foreign app's focus either
				go func() {
					fg, _, _ := pGetForegroundWindow.Call()
					if fg == 0 || !ourHwnd(fg) {
						return
					}
					if g := gameHwnd(); g != 0 {
						pSetForegroundWindow.Call(g)
					}
				}()
			case message == "xicompanion:loaded":
				// the page finished booting — releases the window's
				// navigateWhenReady retry loop (no-op once it exits)
				if ch, ok := pageLoaded.Load(w); ok {
					select {
					case ch.(chan struct{}) <- struct{}{}:
					default:
					}
				}
				// a menu swapped/created hidden reveals here — the new
				// page is up, so no stale-content flash. Only the menu
				// window's own loaded may consume the flag — any other
				// window's load would silently cancel the reveal
				if w == fabMenuWin {
					fabMenuMu.Lock()
					pending := menuPendingShow
					menuPendingShow = false
					fabMenuMu.Unlock()
					if pending {
						go func() {
							w.Show()
							pSetWindowPos.Call(hwndOf(w), hwndTop, 0, 0, 0, 0,
								swpNoMove|swpNoSize|swpNoActivate)
						}()
					}
				}
			case message == "xicompanion:windows":
				go windowsReport()
			case strings.HasPrefix(message, "xicompanion:fabmenu:"):
				go fabMenu(strings.TrimPrefix(message, "xicompanion:fabmenu:"))
			case strings.HasPrefix(message, "xicompanion:fabmenu-show:"):
				// bump synchronously at message time — the channel
				// orders this after the cog's raise, so the debounced
				// hide cancels no matter when the goroutine runs
				menuWatchGen.Add(1)
				go fabMenuShow(strings.TrimPrefix(message, "xicompanion:fabmenu-show:"), w)
			case strings.HasPrefix(message, "xicompanion:menu-pick:"):
				// spec-menu item click — relay the id to the window
				// that requested it. The menu STAYS OPEN: multi-pick
				// menus (view prefs) can take several choices; the
				// requester, backdrop, or Esc decides when to close.
				go func() {
					fabMenuMu.Lock()
					rw := menuRequester
					fabMenuMu.Unlock()
					if wv, ok := rw.(*application.WebviewWindow); ok && wv != nil {
						wv.ExecJS(fmt.Sprintf(
							"window.__xicMenuPick&&window.__xicMenuPick(%s)",
							strconv.Quote(strings.TrimPrefix(message, "xicompanion:menu-pick:"))))
					}
				}()
			case strings.HasPrefix(message, "xicompanion:menu-size:"):
				f := strings.Split(strings.TrimPrefix(message, "xicompanion:menu-size:"), ",")
				if len(f) == 2 {
					if mw, err1 := strconv.Atoi(f[0]); err1 == nil {
						if mh2, err2 := strconv.Atoi(f[1]); err2 == nil {
							mh3 := fabMenuHwnd.Load()
							if mh3 != 0 && mw > 0 && mh2 > 0 {
								// fit content, but never past the box
								// the requester gave us — the columns
								// scroll inside the window beyond it
								if mh2 > menuScrH {
									mh2 = menuScrH
								}
								py := menuScrY
								if menuUp {
									py = menuScrY + menuScrH - mh2
								}
								pSetWindowPos.Call(mh3, 0,
									uintptr(int32(menuScrX)), uintptr(int32(py)),
									uintptr(mw), uintptr(mh2), swpNoActivate)
							}
						}
					}
				}
			case message == "xicompanion:fabmenu-hide":
				go fabMenuHide()
			case strings.HasPrefix(message, "xicompanion:main:"):
				go showInMain(strings.TrimPrefix(message, "xicompanion:main:"))
			case message == "xicompanion:geom":
				go geomReport(w)
			case strings.HasPrefix(message, "xicompanion:geom-set:"):
				go geomSet(strings.TrimPrefix(message, "xicompanion:geom-set:"))
			case strings.HasPrefix(message, "xicompanion:scale-follow:"):
				go scaleFollowSet(strings.TrimPrefix(message, "xicompanion:scale-follow:"), w)
			case strings.HasPrefix(message, "xicompanion:winscale:"):
				go winScaleSet(strings.TrimPrefix(message, "xicompanion:winscale:"), w)
			case message == "xicompanion:raise":
				// panels are NOACTIVATE — clicking can't raise them
				// naturally, so the page asks on mousedown. HWND_TOP
				// lifts the window to the top of the normal band —
				// gated on the game family holding foreground: under a
				// foreign app the raise would pop the panel over it.
				go func() {
					fg, _, _ := pGetForegroundWindow.Call()
					if fg == 0 || (fg != ffxiHwnd.Load() &&
						!ourHwnd(fg) && !isFFXIProcess(fg)) {
						return
					}
					pSetWindowPos.Call(hwndOf(w), hwndTop, 0, 0, 0, 0,
						swpNoMove|swpNoSize|swpNoActivate)
				}()
			case strings.HasPrefix(message, "xicompanion:open:"):
				go openURL(strings.TrimPrefix(message, "xicompanion:open:"))
			case strings.HasPrefix(message, "xicompanion:show:"): // older pages
				go showInMain(strings.TrimPrefix(message, "xicompanion:show:"))
			case message == "xicompanion:tooltip-hide":
				go tooltipHide()
			case strings.HasPrefix(message, "xicompanion:tooltip-size:"):
				// fixed-size window — ignore size reports from older pages
			case strings.HasPrefix(message, "xicompanion:tooltip:"):
				go tooltipShow(w, strings.TrimPrefix(message, "xicompanion:tooltip:"))
			case message == "xicompanion:drag":
				go startMoveLoop(hwndOf(w), htCaption)
			case strings.HasPrefix(message, "xicompanion:resize:"):
				go startMoveLoop(hwndOf(w), edgeHT[strings.TrimPrefix(message, "xicompanion:resize:")])
			}
		},
		Windows: application.WindowsOptions{
			// own UDF so we never collide with another app's WebView2 profile
			WebviewUserDataPath: filepath.Join(dataDir(), "webview2"),
		},
	}

	// addon-launched mode (--pid <inst>): the file mailbox replaces the
	// socket server as the page's backend, and a ws://127.0.0.1 socket
	// carries events/requests — SSE can't stream through the assetserver.
	// The Assets handler serves ui/ + proxies /api/* over the backend, so
	// the page sees the same http://wails.localhost surface either way.
	xa := xportArgsFrom(os.Args[1:])
	if xa.inst != "" {
		exe, _ := os.Executable()
		exeDir := filepath.Dir(exe)
		if xa.ui == "" {
			xa.ui = filepath.Join(exeDir, "..", "ui")
		}
		dataDir := filepath.Join(exeDir, "..", "data")
		addonTarget = "http://wails.localhost/"
		appOpts.Assets = application.AssetOptions{Handler: apiHandler(xa.ui)}
		if !xportClaim(xa.inst) {
			// a relaunched copy — Wails' SingleInstance check quits us in
			// app.Run. Starting the backend here would let this doomed
			// process drainOut() and delete out/ files addressed to the
			// survivor; skipping it keeps the mailbox safe.
			log.Printf("xport: inst %s already owned — backend skipped (second instance)", xa.inst)
		} else {
			b := newMailboxBackend(xa.inst, dataDir)
			b.start()
			xp = b
			go xpDispatch(xp.recv())
			if err := wsStart(); err != nil {
				log.Printf("xport: events socket failed: %v", err)
			} else {
				log.Printf("xport: events ws on ws://%s/events", wsAddr)
			}
			log.Printf("xport: mailbox backend for inst %s (ui %s)", xa.inst, xa.ui)
		}
	}
	app = application.New(appOpts)

	opts := application.WebviewWindowOptions{
		Title:     windowTitle,
		Frameless: true,
		Hidden:    true,
		// translucent: the fab's square window still reads as a circle,
		// and glass can frost its backdrop via DWMSBT_TRANSIENTWINDOW
		BackgroundType:   application.BackgroundTypeTranslucent,
		BackgroundColour: application.NewRGB(0, 0, 0), // --background #020617
		HTML:             splashHTML,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
			WebView2CompositionHosting:         true,
			NonClientRegionSupport:            true,
		},
	}
	// the fab IS the main window — always a fixed bar; every feature
	// opens as a detached window
	x, y := defaultFabPos()
	if r := geomSnapshot().Fab; r != nil {
		x, y = r.X, r.Y
	}
	opts.Width, opts.Height = fabW, fabH
	opts.MinWidth, opts.MinHeight = fabW, fabH
	opts.MaxWidth, opts.MaxHeight = fabW, fabH
	opts.X, opts.Y = x, y
	opts.DisableResize = true
	// InitialPosition's zero value is WindowCentered — without WindowXY
	// the shell centers the window after creation and X/Y are ignored.
	if opts.X != 0 || opts.Y != 0 {
		opts.InitialPosition = application.WindowXY
	}
	win = app.Window.NewWithOptions(opts)

	// frameless+tool windows auto-minimize when the game takes focus —
	// undo it WITHOUT activating (Show() here fights the fg watcher)
	win.OnWindowEvent(events.Common.WindowMinimise, func(e *application.WindowEvent) {
		pShowWindow.Call(hwndOf(win), swShowNA)
	})

	go func() {
		// created Hidden — the bar gets NOACTIVATE + game-ownership
		// BEFORE the first SW_SHOWNA, so nothing it does ever takes
		// foreground
		for i := 0; i < 60 && win.NativeWindow() == nil; i++ {
			time.Sleep(50 * time.Millisecond)
		}
		hwnd := hwndOf(win)
		if hwnd == 0 {
			return
		}
		windowHwnd.Store(hwnd)
		setClassCursor(hwnd)
		subclassWindow(hwnd)
		setStyleFlag(hwnd, wsExNoActivate, true)
		ownToGame(hwnd)
		// first reveal must be w.Show() — it wakes the WebView2
		// controller a Hidden-created window starts without (a raw
		// reshow paints an empty frame); NOACTIVATE already holds so
		// it can't activate
		win.Show()
		if collapsed.Load() || backendHidden.Load() {
			pShowWindow.Call(hwnd, swHide)
		}
		// guarantee: the burst ends with the game holding focus —
		// fires only if a NOACTIVATE window still illegally has it
		focusGameSoon()
	}()
	go trackGeometry()
	go watchGameHwnd()
	navigateWhenReady(win, func() string {
		// preset in xport mode — probing is an http-mode concern
		if addonTarget == "" {
			addonTarget = probeTarget()
		}
		// restore windows the user left open — same persistence path as
		// bounds, but for visibility state (spawn/close writes geom.Open)
		snap := geomSnapshot()
		if snap.Collapsed {
			collapsed.Store(true)
		}
		for key, open := range snap.Open {
			if open {
				go spawnWindow(key)
			}
		}
		if snap.Collapsed {
			// the fab + windows spawned before the flag landed need a
			// manual hide — applyCollapsed can't run (CompareAndSwap
			// already reads true) so hide what's already up
			if hwnd := hwndOf(win); hwnd != 0 {
				pShowWindow.Call(hwnd, swHide)
			}
		}
		// the bar's NOACTIVATE/ownership were applied at hwnd time —
		// nothing left to do here
		go func() {
			// cold start with --spawn (e.g. `//xicompanion tracker` while the
			// overlay wasn't running) — open the detached window once
			// the app is up
			if route, ok := spawnArg(os.Args[1:]); ok {
				spawnWindow(route)
			}
		}()
		// status/spawn polling rides whichever backend is active
		var apiGet func(string) ([]byte, error)
		if xp != nil {
			apiGet = xpGet
		} else {
			apiGet = httpGet(addonTarget)
		}
		go watchBackend(apiGet)
		// foreign-foreground hiding removed — windows stay up when the
		// game loses focus; the zoning/cutscene blackout still applies
		return navURL(addonTarget)
	})

	if err := app.Run(); err != nil {
		log.Printf("wails exited with error: %v", err)
	}
}
