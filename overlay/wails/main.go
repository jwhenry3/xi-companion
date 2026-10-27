// xicompanion-overlay — Wails v3 (WebView2) shell for the XI Companion addon.
//
// Thin window wrapper: the Lua addon's HTTP server stays the backend, this
// process just finds it (probing 127.0.0.1:17890..17899 for /api/status,
// or $GSUI_PORT if set) and shows it in a frameless always-on-top window.
//
// The window has two modes:
//
//	fab  — a small always-on-top floating button (--fab starts this way).
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
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
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
	pIsIconic            = user32.NewProc("IsIconic")
	pShowWindow          = user32.NewProc("ShowWindow")
	pSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	pGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	pSetWindowPos        = user32.NewProc("SetWindowPos")
	pGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	pGetWindowLongPtr    = user32.NewProc("GetWindowLongPtrW")
	pSetWindowLongPtr    = user32.NewProc("SetWindowLongPtrW")
	pGetAsyncKeyState    = user32.NewProc("GetAsyncKeyState")
	pGetCursorPos        = user32.NewProc("GetCursorPos")
	pGetWindowRect       = user32.NewProc("GetWindowRect")
	pDwmSetWindowAttr    = dwmapi.NewProc("DwmSetWindowAttribute")
	pDwmExtendFrame      = dwmapi.NewProc("DwmExtendFrameIntoClientArea")
	pDefWindowProc       = user32.NewProc("DefWindowProcW")
	pGetModuleHandle     = kernel32.NewProc("GetModuleHandleW")
	pGetMessage          = user32.NewProc("GetMessageW")
	pSetWinEventHook     = user32.NewProc("SetWinEventHook")
	pUnhookWinEvent      = user32.NewProc("UnhookWinEvent")
	pTranslateMsg        = user32.NewProc("TranslateMessage")
	pDispatchMsg         = user32.NewProc("DispatchMessageW")
	pBeginPaint          = user32.NewProc("BeginPaint")
	pEndPaint            = user32.NewProc("EndPaint")

	gdi32               = syscall.NewLazyDLL("gdi32.dll")

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
	swHide        = 0
	swShowNA      = 8 // show without activating — restores must not steal fg
	swRestore     = 9
	hwndTopmost   = ^uintptr(0) // (HWND)-1
	hwndNoTopmost = ^uintptr(1) // (HWND)-2
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010
	swpFrameChg   = 0x0020
	swpShowWindow = 0x0040 //nolint:unused — kept with the SWP_* family

	gwlExStyle      = ^uint32(19) // GWL_EXSTYLE (-20)
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

	wsExTopmost    = 0x00000008
	// out of the BitBlt so only real desktop content frosts

	// EVENT_OBJECT_LOCATIONCHANGE + out-of-context queue delivery —
	// the backing follows overlay moves at event speed instead of the
	// 16ms paint cadence (kills drag jitter)

	// EVENT_SYSTEM_FOREGROUND — instant topmost refresh on focus flips
	// (the 300ms poll stays as a drift fallback, but the flicker window
	// was its latency)
	evtForeground  = 0x0003
	wineventSkipOwn = 0x0002
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

// focus-topmost: the windows hold always-on-top only while the game (or
// one of our own windows — interacting with the overlay counts) is
// foreground; a foreign app getting focus drops every window back to
// normal z-order so it can't float over other apps. A ~300ms poll flips
// each tracked hwnd's TOPMOST bit to match — spawned windows pick the
// current state up within a tick of being born.
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

func applyFocusTopmost(hwnd uintptr, want bool) {
	if hwnd == 0 {
		return
	}
	cur, _, _ := pGetWindowLongPtr.Call(hwnd, uintptr(gwlExStyle))
	if (cur&wsExTopmost != 0) == want {
		return // already in the desired state
	}
	pos := hwndNoTopmost
	if want {
		pos = hwndTopmost
	}
	pSetWindowPos.Call(hwnd, pos, 0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoActivate)
}

func refreshTopmost() {
	fg, _, _ := pGetForegroundWindow.Call()
	ffxi := ffxiHwnd.Load()
	if r, _, _ := pIsWindow.Call(ffxi); ffxi == 0 || r == 0 {
		ffxi = findFFXIWindow()
		ffxiHwnd.Store(ffxi)
	}
	want := fg != 0 && (fg == ffxi || ourHwnd(fg) || isFFXIProcess(fg))
	// Snapshot our hwnds first — TryLock like the old loop: this runs
	// inside the WinEvent callback where blocking on spawnMu can stall
	// the hook thread (a held spawn lock + hook-thread wait = the
	// focus path freezing and game keys dying).
	ours := map[uintptr]bool{
		windowHwnd.Load(): true,
		tooltipHwnd.Load(): true,
		fabMenuHwnd.Load(): true,
	}
	if spawnMu.TryLock() {
		for _, sw := range spawned {
			if sw.NativeWindow() != nil {
				ours[hwndOf(sw)] = true
			}
		}
		spawnMu.Unlock()
	}
	// Re-asserting TOPMOST moves a window to the top of the topmost
	// band — iterating spawn order let the last entry (e.g. skillchain)
	// jump over windows the user just raised. EnumWindows walks the
	// desktop in z-order; filtering to ours and applying bottom→top
	// keeps the user's stacking through the transition.
	var order []uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		if ours[hwnd] {
			order = append(order, hwnd)
		}
		return 1
	})
	pEnumWindows.Call(cb, 0)
	for i := len(order) - 1; i >= 0; i-- {
		applyFocusTopmost(order[i], want)
	}
}

func focusTopmostLoop() {
	// the WinEvent hook reacts to foreground changes instantly — this
	// stays as a low-rate safety net for drift the events don't cover
	for range time.Tick(500 * time.Millisecond) {
		refreshTopmost()
	}
}

// fires on EVENT_SYSTEM_FOREGROUND — out-of-context queue delivery like
// the location hook; refreshes topmost at event speed instead of poll
// cadence, which is what made the on-top flip visibly flicker
var foregroundHookProc = syscall.NewCallback(
	func(hook, event, hwnd, idObject, idChild, tid, ms uintptr) uintptr {
		refreshTopmost()
		return 0
	})

func topmostHookThread() {
	runtime.LockOSThread()
	// no SKIPOWNPROCESS — an event from our own windows (fab menu
	// activating, a panel stealing focus mid-drag) is exactly the
	// refresh we need; recomputing want is cheap anyway
	pSetWinEventHook.Call(evtForeground, evtForeground, 0,
		foregroundHookProc, 0, 0, 0)
	var msg struct {
		Hwnd uintptr
		Msg  uint32
		W, L uintptr
		Time uint32
		X, Y int32
	}
	for {
		r, _, _ := pGetMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		pTranslateMsg.Call(uintptr(unsafe.Pointer(&msg)))
		pDispatchMsg.Call(uintptr(unsafe.Pointer(&msg)))
	}
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
	r := setForeground(hwnd)
	log.Printf("refocus: fg=%#x ffxi=%#x setfg=%v", fg, hwnd, r)
}

// setForeground performs the AttachThreadInput-assisted
// SetForegroundWindow — attaching the calling thread to the current
// foreground window's thread inherits its foreground-grant, which is
// what makes the call work both directions (game ← overlay and
// overlay ← game, e.g. expanding the NOACTIVATE fab).
func setForeground(target uintptr) bool {
	fg, _, _ := pGetForegroundWindow.Call()
	if fg == target {
		return true
	}
	cur, _, _ := pGetCurrentThreadId.Call()
	var pid uint32
	fgTid, _, _ := pGetWindowThreadProcessId.Call(fg, uintptr(unsafe.Pointer(&pid)))
	pAttachThreadInput.Call(cur, fgTid, 1)
	r, _, _ := pSetForegroundWindow.Call(target)
	pAttachThreadInput.Call(cur, fgTid, 0)
	return r != 0
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
	var p0 wPoint
	pGetCursorPos.Call(uintptr(unsafe.Pointer(&p0)))
	var r0 wRect
	pGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r0)))
	x0, y0 := r0.left, r0.top
	w0, h0 := r0.right-r0.left, r0.bottom-r0.top
	lEdge := hitTest == htLeft || hitTest == htTopLeft || hitTest == htBottomLeft
	rEdge := hitTest == htRight || hitTest == htTopRight || hitTest == htBottomRight
	tEdge := hitTest == htTop || hitTest == htTopLeft || hitTest == htTopRight
	bEdge := hitTest == htBottom || hitTest == htBottomLeft || hitTest == htBottomRight

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
			l, t = x0+dx, y0+dy
			r, b = l+w0, t+h0
		} else {
			if lEdge {
				l = x0 + dx
			}
			if rEdge {
				r = x0 + w0 + dx
			}
			if tEdge {
				t = y0 + dy
			}
			if bEdge {
				b = y0 + h0 + dy
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
	// drop-snap: pin the final rect to 4px intervals — edges AND size
	// (snapping both edges keeps the delta a multiple of 4)
	snap := func(v int32) int32 { return (v + 2) &^ 3 }
	sl, st, sr, sb := snap(l), snap(t), snap(r), snap(b)
	pSetWindowPos.Call(hwnd, 0,
		uintptr(int64(sl)), uintptr(int64(st)),
		uintptr(int64(sr-sl)), uintptr(int64(sb-st)),
		swpNoActivate|swpNoZOrder)
	refocusGame()
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












func isIconic(hwnd uintptr) bool {
	r, _, _ := pIsIconic.Call(hwnd)
	return r != 0
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
// caller's store feeds SetForegroundWindow / exstyle flips / tooltip
// ownership (spawned windows pass nil; their hwnd is only needed for
// one-shot style flips at spawn time). No periodic z-order asserts:
// polling re-asserts caused visible flicker as windows popped to
// band-top and back, so stacking is left to Windows + xicompanion:raise.
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
	// hidden with no way back (the visibility window still surfaces)
	Collapsed bool `json:"collapsed,omitempty"`
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
		win.Hide()
		refocusGame()
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
// Each is its own frameless always-on-top Webview2 window navigated to the
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
	fgHidden      atomic.Bool // unused — foreign foreground no longer hides
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
	return key == "/tracker" || key == "/macrobar" || key == "/cooldowns" ||
		key == "/minimap" || key == "/party" || key == "/target" ||
		key == "/skillchain" || key == "/visibility"
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
	// route may carry a deep-link query (/journal?g=&s=&id=) — the key
	// is the bare path, the query rides into the spawned window's url
	query := ""
	if i := strings.IndexByte(route, '?'); i >= 0 {
		query = route[i+1:]
	}
	key := spawnKey(route)
	spawnMu.Lock()
	if w, ok := spawned[key]; ok && w.NativeWindow() != nil {
		spawnMu.Unlock()
		if query != "" {
			// deep-link into the already-open window — same in-page
			// router hook the old main-window navigation used
			nav := key + "?window=1&" + query
			w.ExecJS(fmt.Sprintf(
				"window.__xicNavigate ? __xicNavigate(%s) : location.assign(%s)",
				strconv.Quote(nav), strconv.Quote(nav)))
		}
		if fabLayerSpawned(key) {
			// NOACTIVATE panels can't hold keyboard focus — Focus() would
			// just bounce fg off the game and back; show them inertly
			go func() { pShowWindow.Call(hwndOf(w), swShowNA) }()
		} else {
			go func() {
				w.Show()
				w.Focus()
			}()
			refocusAfterActivate()
		}
		return
	}
	spawnMu.Unlock()

	// race guard: a sibling spawnWindow for this route is already
	// creating its window — only the first caller proceeds
	spawnMu.Lock()
	if spawnInFlight[key] {
		spawnMu.Unlock()
		return
	}
	spawnInFlight[key] = true
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
		"/visibility": "Visibility",
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
		Title:            windowTitle + " — " + title,
		Frameless:        true,
		AlwaysOnTop:      true,
		BackgroundType:   application.BackgroundTypeTranslucent,
		BackgroundColour: application.NewRGB(2, 6, 23),
		Width:            560,
		Height:           420,
		MinWidth:         mw,
		MinHeight:        mh,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
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
	case "/visibility":
		// tiny always-up toggle — survives collapse-all as the restore
		// handle; fixed-size bare button, nothing to resize
		opts.Width, opts.Height = 48, 48
		opts.DisableResize = true
		opts.MinWidth, opts.MinHeight = 48, 48
	case "/target":
		// a slim name + HP + cast strip
		opts.Width, opts.Height = 220, 64
	case "/skillchain":
		// three columns — chains+ws | burst spells | recent
		opts.Width, opts.Height = 560, 280
	}
	if r := geomSnapshot().Windows[key]; r != nil && r.W >= mw && r.H >= mh {
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
	delete(spawnInFlight, key)
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

	go resolveHwnd(w, nil)
	if fabLayerSpawned(key) {
		go func() {
			// set as soon as the hwnd exists — activation can land well
			// before the webview finishes initializing, and the flag is
			// what keeps the panel (and its transparent margins) from
			// ever stealing the game's keyboard
			for i := 0; i < 60 && w.NativeWindow() == nil; i++ {
				time.Sleep(50 * time.Millisecond)
			}
			if w.NativeWindow() == nil {
				return
			}
			hwnd := uintptr(w.NativeWindow())
			setStyleFlag(hwnd, wsExNoActivate, true)
			// a fab-layer window (the tracker) is owned by the main
			// window — owned windows always outrank their owner in
			// z-order, so it can never slide under the UI (same trick as
			// the item tooltip). It also follows the owner's hide during
			// the blackout.
			for i := 0; i < 40 && windowHwnd.Load() == 0; i++ {
				time.Sleep(50 * time.Millisecond)
			}
			if owner := windowHwnd.Load(); owner != 0 {
				pSetWindowLongPtr.Call(hwnd, uintptr(gwlpOwner), owner)
			}
		}()
	}
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
	// spawned mid-blackout (zoning or foreign-foreground) starts hidden —
	// the watchers restore it when the world/focus comes back
	if (collapsed.Load() && key != "/visibility") ||
		(fabLayerSpawned(key) && key != "/visibility" && backendHidden.Load()) {
		w.Hide()
	}
	go trackSpawned(w, key)
	setWindowOpen(key, true)
	saveGeometry()
	// stamp the current collapse-all state — queued ExecJS flushes
	// once the page finishes loading
	w.ExecJS(fmt.Sprintf(
		"window.__xicCollapsed&&window.__xicCollapsed(%v)", collapsed.Load()))
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
		refocusGame()
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
	for k := range spawned {
		keys = append(keys, k)
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

// sameProcess reports whether two hwnds belong to the same process —
// FFXI's own dialogs/IME surfaces still count as "game foreground".
func sameProcess(a, b uintptr) bool {
	if a == 0 || b == 0 {
		return false
	}
	var pa, pb uint32
	pGetWindowThreadProcessId.Call(a, uintptr(unsafe.Pointer(&pa)))
	pGetWindowThreadProcessId.Call(b, uintptr(unsafe.Pointer(&pb)))
	return pa != 0 && pa == pb
}

// applyFgHidden hides or restores the whole overlay family. Restores go
// through SW_SHOWNA on the hwnd — w.Show() activates, which would steal
// foreground right back from whatever the user switched to. The zoning
// blackout still wins over a restore: windows it wants hidden stay down.
func applyFgHidden(hide bool) {
	if !fgHidden.CompareAndSwap(!hide, hide) {
		return
	}
	log.Printf("fg-hidden=%v", hide)
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
	if hide || !backendHidden.Load() {
		apply(win) // blackout owns the fab — a restore must not resurface it
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
		if keys[sw] == "/visibility" {
			continue // the restore handle — never collapse it away
		}
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
	// keep every page's button state in sync — the visibility window
	// and the fab both render the toggle
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
		Width:            320,
		Height:           440,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
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
		w.Show()
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
		w.SetPosition(m.X, m.Y)
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

// -------------------------------------------------------- fab menu

// The fab's group dropdowns live in one shared hidden window — the bar
// itself stays 540x56 instead of growing to host a menu. The fab page
// passes the group key + screen rect; retargets swap content over
// ExecJS (__xicMenu) like the tooltip's __xicTooltip.
var (
	fabMenuWin  *application.WebviewWindow
	fabMenuHwnd atomic.Uintptr
	fabMenuMu   sync.Mutex
)

// xicompanion:fabmenu-show:<group>:<x>,<y>,<w>,<h> — x/y/w/h are screen px
func fabMenuShow(arg string) {
	sep := strings.LastIndexByte(arg, ':')
	if sep < 0 {
		return
	}
	group, nums := arg[:sep], arg[sep+1:]
	f := strings.Split(nums, ",")
	if len(f) != 4 || group == "" {
		return
	}
	var v [4]int
	for i, s := range f {
		n, err := strconv.Atoi(strings.TrimSpace(s))
		if err != nil {
			return
		}
		v[i] = n
	}
	x, y, w, h := v[0], v[1], v[2], v[3]
	if w <= 0 || h <= 0 {
		return
	}
	fabMenuMu.Lock()
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
		fabMenuCreate(group, x, y, w, h)
		return
	}
	mw.ExecJS(fmt.Sprintf(
		"window.__xicMenu&&window.__xicMenu(%s)", strconv.Quote(group)))
	mw.SetPosition(x, y)
	mw.SetSize(w, h)
	pShowWindow.Call(hwndOf(mw), swShowNA)
	// refresh the ● open marks — a freshly-created menu's ExecJS queue
	// flushes on page load, so this covers the create path too
	go windowsReport()
}

func fabMenuCreate(group string, x, y, w, h int) {
	opts := application.WebviewWindowOptions{
		Title:            windowTitle + " — menu",
		Frameless:        true,
		AlwaysOnTop:      true,
		BackgroundType:   application.BackgroundTypeTranslucent,
		BackgroundColour: application.NewRGB(2, 6, 23),
		Width:            w,
		Height:           h,
		MinWidth:         100,
		MinHeight:        40,
		X:                x,
		Y:                y,
		InitialPosition:  application.WindowXY,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
		},
	}
	// URL at creation skips the splash hop (see spawnWindow)
	menuPath := "fabmenu?window=1&g=" + url.QueryEscape(group)
	if addonTarget != "" {
		opts.URL = navURL(addonTarget + menuPath)
	} else {
		opts.HTML = splashHTML
	}
	mw := app.Window.NewWithOptions(opts)
	fabMenuMu.Lock()
	fabMenuWin = mw
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
	refocusAfterActivate()
	// the ExecJS queue flushes once the page boots — lands the open
	// window list (● marks) without waiting for a spawn/close event
	go windowsReport()
	log.Printf("fab menu window created")
}

func fabMenuHide() {
	fabMenuMu.Lock()
	w := fabMenuWin
	fabMenuMu.Unlock()
	// raw SW_HIDE — w.Hide() also drops the WebView2 controller's
	// IsVisible, which our swShowNA reshow never restores (the menu
	// would "open" as an invisible frame). Raw hide/show pairs match
	// what applyFgHidden does for every window.
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
func watchBackend(target string) {
	client := &http.Client{Timeout: 2 * time.Second}
	misses := 0
	lastBoot := 0 // addon reload marker from /api/status
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
			Boot   int  `json:"boot"`
		}
		json.NewDecoder(resp.Body).Decode(&st)
		resp.Body.Close()
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

	geomPath = filepath.Join(dataDir(), "window.json")
	loadGeometry()

	logf, err := os.OpenFile(filepath.Join(dataDir(), "overlay.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		log.SetOutput(logf)
		defer logf.Close()
	}

	app = application.New(application.Options{
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
					fabRelaunch := slices.Contains(data.Args, "--fab")
					if !fabRelaunch {
						expand()
					}
					// a --fab relaunch during the zoning blackout must
					// not flash the hidden fab back on screen
					if backendHidden.Load() {
						return
					}
					// any //xicompanion command is an un-collapse too —
					// bring the whole family back (fab included)
					applyCollapsed(false)
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
				go closeFor(w) // spawned window → destroy; main → collapse
			case strings.HasPrefix(message, "xicompanion:spawn:"):
				go spawnWindow(strings.TrimPrefix(message, "xicompanion:spawn:"))
			case strings.HasPrefix(message, "xicompanion:toggle:"):
				go toggleWindow(strings.TrimPrefix(message, "xicompanion:toggle:"))
			case message == "xicompanion:loaded":
				// the page finished booting — releases the window's
				// navigateWhenReady retry loop (no-op once it exits)
				if ch, ok := pageLoaded.Load(w); ok {
					select {
					case ch.(chan struct{}) <- struct{}{}:
					default:
					}
				}
			case message == "xicompanion:windows":
				go windowsReport()
			case strings.HasPrefix(message, "xicompanion:fabmenu:"):
				go fabMenu(strings.TrimPrefix(message, "xicompanion:fabmenu:"))
			case strings.HasPrefix(message, "xicompanion:fabmenu-show:"):
				go fabMenuShow(strings.TrimPrefix(message, "xicompanion:fabmenu-show:"))
			case message == "xicompanion:fabmenu-hide":
				go fabMenuHide()
			case strings.HasPrefix(message, "xicompanion:main:"):
				go showInMain(strings.TrimPrefix(message, "xicompanion:main:"))
			case message == "xicompanion:geom":
				go geomReport(w)
			case strings.HasPrefix(message, "xicompanion:geom-set:"):
				go geomSet(strings.TrimPrefix(message, "xicompanion:geom-set:"))
			case message == "xicompanion:raise":
				// panels are NOACTIVATE — clicking can't raise them
				// naturally, so the page asks on mousedown. Raising
				// needs no activation: the user's stacking order is
				// whichever window they touched last.
				go pSetWindowPos.Call(hwndOf(w), hwndTopmost, 0, 0, 0, 0,
					swpNoMove|swpNoSize|swpNoActivate)
			case message == "xicompanion:refocus":
				// let the click finish dispatching first — the macro's
				// send_command / the tooltip's pin go out on this gesture
				go func() {
					time.Sleep(50 * time.Millisecond)
					refocusGame()
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
	})

	opts := application.WebviewWindowOptions{
		Title:       windowTitle,
		Frameless:   true,
		AlwaysOnTop: true,
		// translucent: the fab's square window still reads as a circle,
		// and glass can frost its backdrop via DWMSBT_TRANSIENTWINDOW
		BackgroundType:   application.BackgroundTypeTranslucent,
		BackgroundColour: application.NewRGB(0, 0, 0), // --background #020617
		HTML:             splashHTML,
		Windows: application.WindowsWindow{
			HiddenOnTaskbar:                   true,
			DisableFramelessWindowDecorations: true,
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

	go resolveHwnd(win, &windowHwnd)
	go trackGeometry()
	go focusTopmostLoop()
	go topmostHookThread()
	navigateWhenReady(win, func() string {
		addonTarget = probeTarget()
		// restore windows the user left open — same persistence path as
		// bounds, but for visibility state (spawn/close writes geom.Open)
		snap := geomSnapshot()
		if snap.Collapsed {
			collapsed.Store(true)
		}
		for key, open := range snap.Open {
			// /visibility is excluded — the dedicated spawn below owns
			// it (a restore + dedicated spawn racing made two windows)
			if open && key != "/visibility" {
				go spawnWindow(key)
			}
		}
		// the visibility toggle is the collapse-all restore handle —
		// it always exists
		go spawnWindow("/visibility")
		if snap.Collapsed {
			// the fab + windows spawned before the flag landed need a
			// manual hide — applyCollapsed can't run (CompareAndSwap
			// already reads true) so hide what's already up
			if hwnd := hwndOf(win); hwnd != 0 {
				pShowWindow.Call(hwnd, swHide)
			}
		}
		// the addon auto-spawning the fab on (re)load steals foreground —
		// hand it back once our hwnd is registered; the bar stays
		// NOACTIVATE so clicks never steal the game
		setStyleFlag(hwndOf(win), wsExNoActivate, true)
		refocusAfterActivate()
		go func() {
			// cold start with --spawn (e.g. `//xicompanion tracker` while the
			// overlay wasn't running) — open the detached window once
			// the app is up
			if route, ok := spawnArg(os.Args[1:]); ok {
				spawnWindow(route)
			}
		}()
		go watchBackend(addonTarget)
		// foreign-foreground hiding removed — windows stay up when the
		// game loses focus; the zoning/cutscene blackout still applies
		return navURL(addonTarget)
	})

	if err := app.Run(); err != nil {
		log.Printf("wails exited with error: %v", err)
	}
}
