// Host-shell abstraction: the UI runs inside either the Wails v3 overlay
// (distributed build) or the Electron overlay (dev) / a plain browser.
//
// The overlay window has two modes — a tiny floating button ("fab") and
// the full UI. The page picks which to render from the viewport size
// (fabMode signal) and talks to the shell through WebView2's
// chrome.webview.postMessage with raw strings:
//
//   "xic:drag"                  → native caption move loop (button-gated
//   "xic:resize:<cursor>"       → native size loop in Go — NOT wails:*
//                                 messages, which bypass RawMessageHandler
//                                 and can't be gated on button state)
//   "xic:expand"               → fab → full window
//   "xic:collapse"             → full → fab (Esc/× both collapse now)
//   "xic:quit"                 → exit the overlay process
//   "xic:spawn:<route>"        → open/focus a detached per-tab window
//   "xic:close"                → destroy a detached window (main collapses)
//   "xic:refocus"              → hand keyboard focus back to the FFXI window
import { signal } from '@preact/signals';

interface Webview2Host {
  postMessage(msg: unknown): void;
}

declare global {
  interface Window {
    chrome?: { webview?: Webview2Host };
  }
}

// window.chrome.webview is WebView2's own host object — present on every
// page inside the wails shell. That's the reliable "am I in the overlay"
// check (Electron and plain browsers don't expose it).
const inWebView = () => !!window.chrome?.webview;

const tell = (msg: string) => window.chrome?.webview?.postMessage(msg);

// Wails only injects its runtime into assetserver-served pages — a
// foreign-origin SetURL page like ours never posts 'wails:runtime:ready',
// which leaves runtimeLoaded=false and every Go-side ExecJS parked in
// pendingJS forever. Posting it ourselves unlocks ExecJS (__xicTooltip,
// __xicNavigate, __xicTooltipUnpinned). One post per window.
if (inWebView()) tell('wails:runtime:ready');

// A viewport this small means the shell is in fab mode — the app renders
// just the button. Gated on inWebView so shrinking a dev browser tab
// doesn't collapse the UI.
const FAB_VIEWPORT = 200;
export const fabMode = signal(false);

const updateFabMode = () => {
  fabMode.value =
    inWebView() &&
    !tooltipMode &&
    window.innerWidth < FAB_VIEWPORT &&
    window.innerHeight < FAB_VIEWPORT;
  // body paints the opaque app background — drop it in fab mode so the
  // window's transparent backdrop shows through around the circle
  document.body.classList.toggle('fab-mode', fabMode.value);
};

/** ?window=1 — a spawned per-tab window: the route resolves normally but
 *  the shell swaps full nav chrome for a slim draggable title bar.
 *  Older exes navigated to /?window=<path> instead — rewrite those to the
 *  route + ?window=1 form before the router reads the URL. */
const winParam = new URLSearchParams(window.location.search).get('window');
if (winParam && winParam !== '1' && winParam.startsWith('/')) {
  history.replaceState(null, '', winParam + '?window=1');
}
export const detachedMode = winParam !== null;

/** detached window on /tracker — the transparent quest tracker. The
 *  shell skips its opaque backdrop and the page renders on the same
 *  always-on-top layer as the fab (Go hides it during cutscenes). */
export const trackerMode =
  detachedMode && window.location.pathname === '/tracker';
if (trackerMode) document.body.classList.add('tracker-mode');

/** ?tooltip=1 — this window IS the floating item tooltip. The shell
 *  positions/updates it via ExecJS; the page just renders the card and
 *  reports its desired size. */
export const tooltipMode = new URLSearchParams(window.location.search).has(
  'tooltip',
);

/** payload for the floating item tooltip — x/y are screen coords */
export interface TooltipRef {
  bag: number;
  slot: number;
  id: number;
  /** display name for refs whose item isn't in any bag */
  name?: string;
  x: number;
  y: number;
  pinned?: boolean;
}

export const tooltipPinned = signal(false);

// ---------- persisted window geometry (settings page) ----------

export interface WinRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** the shell's window.json snapshot: fab/full bounds + per-route
 *  detached windows ("/tracker" etc.) */
export interface ShellGeom {
  fab?: WinRect;
  full?: WinRect;
  windows?: Record<string, WinRect>;
}
export const shellGeom = signal<ShellGeom | null>(null);
if (inWebView()) {
  (window as any).__xicGeom = (g: ShellGeom) => {
    shellGeom.value = g;
  };
}

// ---------- theme ----------
// the app is styled exclusively in Tailwind's slate ramp, so light mode
// flips the ramp (styles.css html.light) — no per-component work

export type Theme = 'dark' | 'light';
const THEME_KEY = 'xic.theme';
export const theme = signal<Theme>(
  (localStorage.getItem(THEME_KEY) as Theme) || 'dark',
);
const applyTheme = (t: Theme) =>
  document.documentElement.classList.toggle('light', t === 'light');
applyTheme(theme.value);
export function setTheme(t: Theme) {
  theme.value = t;
  localStorage.setItem(THEME_KEY, t);
  applyTheme(t);
}

let lastTip: TooltipRef | null = null;

// the shell clears pinned here when the pinned window's × hides it
// (the close lands in the tooltip window, so main can't see it directly)
(window as any).__xicTooltipUnpinned = () => {
  tooltipPinned.value = false;
};

const sendTip = () => {
  if (lastTip) tell(`xic:tooltip:${JSON.stringify(lastTip)}`);
};

/** screen coords anchoring a tooltip just right of an element (flipped
 *  left / bottom-aligned when it would overflow the window). Frameless
 *  windows fill the webview, so screenX/Y + client rect ≈ screen pos. */
export function tipAnchor(
  el: HTMLElement,
  estW = 320,
  estH = 440,
): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const wx = window.screenX;
  const wy = window.screenY;
  let x = wx + r.right + 6;
  let y = wy + r.top;
  if (x + estW > wx + window.innerWidth) x = wx + r.left - estW - 6;
  if (y + estH > wy + window.innerHeight)
    y = wy + window.innerHeight - estH - 4;
  return { x: Math.round(x), y: Math.round(y) };
}

export const host = {
  /** true when running inside a native WebView2 shell */
  inShell: inWebView,

  /** start the native caption-move loop (fab drag, fallback for header) */
  drag() {
    tell('xic:drag');
  },

  /** pop the current route out into its own small window */
  spawnWindow(path: string) {
    tell(`xic:spawn:${path}`);
  },

  /** close this window (a spawned tab). On the main window Esc/× use
   *  collapse() instead — the fab is its "closed" state. */
  closeWindow() {
    if (inWebView()) tell('xic:close');
    else window.close();
  },

  /** fab → full window */
  expand() {
    tell('xic:expand');
  },

  /** full → fab. Esc and the × button both collapse — the fab is the
   *  persistent "closed" state unless the addon is unloaded. */
  collapse() {
    if (inWebView()) tell('xic:collapse');
    else window.close();
  },

  /** quit the overlay process entirely (fab right-click) */
  quit() {
    if (inWebView()) tell('xic:quit');
    else window.close();
  },

  /** pin the item tooltip — opens/retargets the native window interactive
   *  (drag + actions). Click-only: there's no hover peek. */
  pinTooltip(t?: TooltipRef) {
    if (t) lastTip = t;
    if (!lastTip) return;
    tooltipPinned.value = true;
    lastTip = { ...lastTip, pinned: true };
    sendTip();
  },

  /** move the pinned tooltip's content to a different item */
  setTooltip(t: TooltipRef) {
    if (!tooltipPinned.value) return;
    lastTip = { ...t, pinned: true };
    sendTip();
  },

  /** unconditional hide — the tooltip window's own × (its signals are a
   *  separate context, so the pinned/visible guards don't apply) */
  closeTooltip() {
    tell('xic:tooltip-hide');
  },


  /** navigate the MAIN window to a route (from a detached window or the
   *  main one — the shell ExecJS's __xicNavigate either way) */
  showInMain(url: string) {
    if (inWebView()) tell(`xic:main:${url}`);
    else location.assign(url);
  },

  /** pull the shell's persisted window bounds into shellGeom */
  refreshGeom() {
    if (inWebView()) tell('xic:geom');
  },

  /** open a url in the system browser — the overlay can't navigate
   *  itself, so it goes through the shell's ShellExecute */
  openExternal(url: string) {
    if (inWebView()) tell(`xic:open:${url}`);
    else window.open(url, '_blank', 'noopener');
  },

  /** persist + live-apply bounds for 'fab' or a spawned route key
   *  ('/tracker'); w/h optional — the shell keeps the known size */
  setGeom(key: string, r: { x: number; y: number; w?: number; h?: number }) {
    const wh = r.w != null && r.h != null ? `,${r.w},${r.h}` : '';
    tell(`xic:geom-set:${key}:${r.x},${r.y}${wh}`);
  },
};

const EDGE = 8; // px of viewport edge that acts as the size border

function edgeAt(x: number, y: number): string | null {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const l = x < EDGE;
  const r = x >= w - EDGE;
  const t = y < EDGE;
  const b = y >= h - EDGE;
  if (t && l) return 'nw-resize';
  if (t && r) return 'ne-resize';
  if (b && l) return 'sw-resize';
  if (b && r) return 'se-resize';
  if (l) return 'w-resize';
  if (r) return 'e-resize';
  if (t) return 'n-resize';
  if (b) return 's-resize';
  return null;
}

// Wires the frameless chrome affordances for the wails shell (full mode
// only — the fab handles its own drag/click):
//  - edges: mousemove shows the resize cursor; mousedown starts a native
//    size loop via "wails:resize:<cursor>"
//  - drag: mousedown on a --wails-draggable:drag element (honoring
//    no-drag) starts a native caption move via "wails:drag"
export function installWindowChrome() {
  if (!inWebView()) return;
  updateFabMode();
  window.addEventListener('resize', updateFabMode);

  document.addEventListener('mousemove', (e) => {
    if (e.buttons !== 0 || fabMode.value || tooltipMode) return; // no churn mid-drag / no edges on fab/tooltip
    const cursor = edgeAt(e.clientX, e.clientY) ?? '';
    if (document.documentElement.style.cursor !== cursor) {
      document.documentElement.style.cursor = cursor;
    }
  });

  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0 || fabMode.value) return;
      const edge = tooltipMode ? null : edgeAt(e.clientX, e.clientY);
      if (edge) {
        e.preventDefault();
        e.stopPropagation();
        tell(`xic:resize:${edge}`);
        return;
      }
      let el = e.target as HTMLElement | null;
      while (el && el !== document.body) {
        const v = getComputedStyle(el).getPropertyValue('--wails-draggable').trim();
        if (v === 'no-drag') return;
        if (v === 'drag') {
          e.preventDefault(); // no text selection while dragging
          e.stopPropagation();
          tell('xic:drag');
          return;
        }
        el = el.parentElement;
      }
    },
    true,
  );

  // every click hands keyboard focus back to the game — the webview
  // claims foreground on click and losing game input mid-fight is the
  // surprise we're avoiding. Text-entry elements keep focus so typing
  // still works; the shell SetForegroundWindows FFXI on xic:refocus.
  document.addEventListener(
    'mouseup',
    (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable="true"]')) return;
      tell('xic:refocus');
    },
    true,
  );
}
