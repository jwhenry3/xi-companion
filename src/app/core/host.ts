// Host-shell abstraction: the UI runs inside either the Wails v3 overlay
// (distributed build) or the Electron overlay (dev) / a plain browser.
//
// The overlay window has two modes — a tiny floating button ("fab") and
// the full UI. The page picks which to render from the viewport size
// (fabMode signal) and talks to the shell through WebView2's
// chrome.webview.postMessage with raw strings:
//
//   "xicompanion:drag"                  → native caption move loop (button-gated
//   "xicompanion:resize:<cursor>"       → native size loop in Go — NOT wails:*
//                                 messages, which bypass RawMessageHandler
//                                 and can't be gated on button state)
//   "xicompanion:expand"               → fab → full window
//   "xicompanion:collapse"             → full → fab (Esc/× both collapse now)
//   "xicompanion:quit"                 → exit the overlay process
//   "xicompanion:spawn:<route>"        → open/focus a detached per-tab window
//   "xicompanion:toggle:<route>"       → spawn-or-close (the fab's menu bar)
//   "xicompanion:windows"              → ask for the open spawned-route list
//   "xicompanion:close"                → destroy a detached window (main collapses)
//   "xicompanion:refocus"              → hand keyboard focus back to the FFXI window
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

// A window this short means the shell is in fab mode — the app renders
// just the menu bar. Height only: the bar is ~540px wide. Detached and
// tooltip windows are excluded — a min-size spawned window (280×180)
// would otherwise read as the fab. inWebView gates dev browser tabs.
const FAB_VIEWPORT = 200;
export const fabMode = signal(false);
// latched while a fab dropdown is showing — the menu itself lives in the
// shared detached /fabmenu window now, so this is bookkeeping for the
// bar's own button glow (and a belt-and-suspenders fabMode hold if an
// old shell still grows the window)
export const fabMenuOpen = signal(false);

const updateFabMode = () => {
  fabMode.value =
    inWebView() &&
    !tooltipMode &&
    !detachedMode &&
    (fabMenuOpen.value || window.innerHeight < FAB_VIEWPORT);
  // body paints the opaque app background — drop it in fab mode so the
  // window's transparent backdrop shows through around the bar
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

/** the shared hidden window that hosts the fab's dropdown menus —
 *  the fab bar never resizes for a menu; this window shows/sizes/
 *  positions itself under the tapped group button instead */
export const menuMode =
  detachedMode && window.location.pathname === '/fabmenu';

/** the collapse-all handle — a bare floating button, no chrome */
export const visibilityMode =
  detachedMode && window.location.pathname === '/visibility';

/** detached windows that render as floating overlay panels — the
 *  transparent backdrop + opaque card chrome. The shell skips the
 *  opaque backdrop and Go keeps them on the always-on-top fab layer
 *  (hidden during cutscenes). */
export const trackerMode =
  detachedMode && window.location.pathname === '/tracker';
export const cooldownsMode =
  detachedMode && window.location.pathname === '/cooldowns';
export const macrobarMode =
  detachedMode && window.location.pathname === '/macrobar';
export const minimapMode =
  detachedMode && window.location.pathname === '/minimap';
export const partyMode =
  detachedMode && window.location.pathname === '/party';
export const targetMode =
  detachedMode && window.location.pathname === '/target';
export const skillchainMode =
  detachedMode && window.location.pathname === '/skillchain';
// every spawned window gets the transparent backdrop so the ffxi-panel
// card's rounded corners clip cleanly; fab-layer panels additionally
// disable selection (tracker-style overlay panels)
if (detachedMode) document.body.classList.add('detached-mode');
if (
  trackerMode ||
  cooldownsMode ||
  macrobarMode ||
  minimapMode ||
  partyMode ||
  targetMode ||
  skillchainMode ||
  visibilityMode ||
  menuMode
)
  document.body.classList.add('panel-mode');

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

/** route keys of the detached windows currently open — the shell pushes
 *  the list via __xicWindows on every spawn/close; the fab's menu bar
 *  reads it to mark which toggles are on. */
export const openWindows = signal<string[]>([]);
/** collapse-all toggle state — owned by the shell, pushed via
 *  __xicCollapsed so every window's control shows the same state */
export const uiCollapsed = signal(false);

// fab-layer routes whose login autospawn lives in addon settings — user
// hides/shows flip the same flag so the next login matches the last
// state (only explicit open/close actions post; quitting posts nothing)
const PANEL_SETTING: Record<string, string> = {
  '/tracker': 'tracker',
  '/macrobar': 'macrobar',
  '/cooldowns': 'cooldowns',
  '/minimap': 'minimap',
  '/party': 'party',
  '/target': 'target',
  '/skillchain': 'skillchain',
};
function persistPanel(path: string, on: boolean) {
  const key = PANEL_SETTING[path];
  if (!key || !inWebView()) return;
  void fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: on }),
  }).catch(() => {});
}

if (inWebView()) {
  (window as any).__xicGeom = (g: ShellGeom) => {
    shellGeom.value = g;
  };
  (window as any).__xicWindows = (list: string[]) => {
    openWindows.value = list ?? [];
  };
  // collapse-all state pushed by the shell — keeps the fab's button
  // and the /visibility window's icon in sync across reloads
  (window as any).__xicCollapsed = (c: boolean) => {
    uiCollapsed.value = !!c;
  };
  // the shell only reports on change — ask once at load so a page that
  // mounted after windows were already up starts with the right list
  if (!detachedMode && !tooltipMode) tell('xicompanion:windows');
}

// ---------- theme ----------
// 'slate' is a translucent-black square-edged skin for detached panels.
// Each detached window can pick its own theme — the per-route key
// shadows the global one for that window only.

export type Theme = 'classic' | 'slate' | 'charcoal' | 'bare';
export const THEMES: Theme[] = [
  'classic',
  'slate',
  'charcoal',
  'bare',
];
// renames — normalize stored picks from older builds
// ('dark' → 'classic', 'glass' → 'slate')
const normTheme = (v: string | null): Theme | null =>
  v === 'dark' || v === 'light'
    ? 'classic'
    : v === 'glass'
      ? 'slate'
      : (v as Theme | null);
const THEME_KEY = 'xicompanion.theme';
const WTHEME_KEY = `xicompanion.wintheme.${window.location.pathname}`;
const storedTheme = detachedMode
  ? normTheme(localStorage.getItem(WTHEME_KEY))
  : null;
export const theme = signal<Theme>(
  storedTheme || normTheme(localStorage.getItem(THEME_KEY)) || 'classic',
);
const applyTheme = (t: Theme) => {
  const cl = document.documentElement.classList;
  cl.toggle('classic', t === 'classic');
  cl.toggle('slate', t === 'slate');
  cl.toggle('charcoal', t === 'charcoal');
  cl.toggle('bare', t === 'bare');
  // DWM blur-behind is shell-side (backdrop-filter can't see through a
  // transparent window) — slate posts 'on', every other theme clears it
  if (inWebView()) tell(`xicompanion:blur:${t === 'slate' ? 'on' : 'off'}`);
};
applyTheme(theme.value);
export function setTheme(t: Theme) {
  theme.value = t;
  localStorage.setItem(detachedMode ? WTHEME_KEY : THEME_KEY, t);
  applyTheme(t);
}
const winKey = (path: string) => `xicompanion.wintheme.${path}`;
/** a detached route's stored pick (null = follows the global theme) */
export function getWinTheme(path: string): Theme | null {
  return normTheme(localStorage.getItem(winKey(path)));
}
export function setWinTheme(path: string, t: Theme | null) {
  if (t) localStorage.setItem(winKey(path), t);
  else localStorage.removeItem(winKey(path));
  // storage events don't reach the originating window — if the change
  // targets this window, apply it directly (null = back to global)
  if (detachedMode && path === window.location.pathname) {
    const v = t ?? normTheme(localStorage.getItem(THEME_KEY)) ?? 'classic';
    theme.value = v;
    applyTheme(v);
  }
}
// every window shares the UDF's localStorage — changes made in one
// window surface live in the others; a detached window without its own
// pick follows the global theme
window.addEventListener('storage', (e) => {
  const mine = detachedMode ? WTHEME_KEY : THEME_KEY;
  if (e.key === mine) {
    // null newValue = key removed → fall back to the global
    const v =
      normTheme(e.newValue) ??
      normTheme(localStorage.getItem(THEME_KEY)) ??
      'classic';
    theme.value = v;
    applyTheme(v);
  } else if (
    detachedMode &&
    e.key === THEME_KEY &&
    !localStorage.getItem(WTHEME_KEY)
  ) {
    theme.value = normTheme(e.newValue) || 'classic';
    applyTheme(theme.value);
  }
});

let lastTip: TooltipRef | null = null;

// the shell clears pinned here when the pinned window's × hides it
// (the close lands in the tooltip window, so main can't see it directly)
(window as any).__xicTooltipUnpinned = () => {
  tooltipPinned.value = false;
};

const sendTip = () => {
  if (lastTip) tell(`xicompanion:tooltip:${JSON.stringify(lastTip)}`);
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

/** like tipAnchor but parks the card OUTSIDE the host window entirely —
 *  off its right edge, or its left when there's more room that way. Used
 *  by the gear grid, where an in-window tooltip lands on the slots it
 *  describes. The card floats over the game instead; screen bounds are
 *  the only clamp. */
export function tipAnchorOutside(
  el: HTMLElement,
  estW = 320,
  estH = 440,
): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const wx = window.screenX;
  const wy = window.screenY;
  // availLeft/Top are real in Chromium but missing from the DOM lib
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  const left = s.availLeft ?? 0;
  const top = s.availTop ?? 0;
  const right = left + (s.availWidth || s.width);
  const bottom = top + (s.availHeight || s.height);
  const gap = 6;
  const xRight = wx + window.innerWidth + gap;
  const xLeft = wx - estW - gap;
  // prefer whichever side keeps the whole card on-screen; if neither
  // fits (window nearly fills the display) take the roomier side and
  // clamp back into view
  const fitsRight = xRight + estW <= right;
  const fitsLeft = xLeft >= left;
  let x = fitsRight
    ? xRight
    : fitsLeft
      ? xLeft
      : right - wx - window.innerWidth >= wx - left
        ? xRight
        : xLeft;
  x = Math.min(Math.max(x, left + 2), Math.max(left + 2, right - estW - 2));
  let y = wy + r.top;
  y = Math.min(Math.max(y, top + 2), Math.max(top + 2, bottom - estH - 2));
  return { x: Math.round(x), y: Math.round(y) };
}

export const host = {
  /** true when running inside a native WebView2 shell */
  inShell: inWebView,

  /** report that this window's app page finished booting — the shell
   *  retries the initial SetURL until it hears this, since a failed
   *  navigation fires NavigationCompleted just like a good one */
  loaded() {
    tell('xicompanion:loaded');
  },

  /** start the native caption-move loop (fab drag, fallback for header) */
  drag() {
    tell('xicompanion:drag');
  },

  /** pop the current route out into its own small window */
  spawnWindow(path: string) {
    tell(`xicompanion:spawn:${path}`);
  },

  /** spawn-or-close a detached window — the fab's menu-bar buttons
   *  toggle rather than always opening */
  toggleWindow(path: string) {
    // remember the resulting visibility — the addon's login autospawn
    // reads the same settings keys, so a hidden panel stays hidden
    persistPanel(path, !openWindows.value.includes(path));
    tell(`xicompanion:toggle:${path}`);
  },

  /** collapse/restore every overlay window — the fab's collapse-all
   *  button; the bar itself stays up as the restore handle */
  collapseAll() {
    tell('xicompanion:collapseall');
  },

  /** show/position the shared fab menu window — <group>:<x>,<y>,<w>,<h>
   *  in screen px (see fabMenuShow in main.go) */
  fabMenuShow(group: string, x: number, y: number, w: number, h: number) {
    tell(`xicompanion:fabmenu-show:${group}:${x},${y},${w},${h}`);
  },

  /** hide the shared fab menu window (item click, bar drag, retarget) */
  fabMenuHide() {
    tell('xicompanion:fabmenu-hide');
  },

  /** close this window (a spawned tab). On the main window Esc/× use
   *  collapse() instead — the fab is its "closed" state. */
  closeWindow() {
    persistPanel(window.location.pathname, false);
    if (inWebView()) tell('xicompanion:close');
    else window.close();
  },

  /** fab → full window */
  expand() {
    tell('xicompanion:expand');
  },

  /** full → fab. Esc and the × button both collapse — the fab is the
   *  persistent "closed" state unless the addon is unloaded. */
  collapse() {
    if (inWebView()) tell('xicompanion:collapse');
    else window.close();
  },

  /** quit the overlay process entirely (fab right-click) */
  quit() {
    if (inWebView()) tell('xicompanion:quit');
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
    tell('xicompanion:tooltip-hide');
  },


  /** navigate the MAIN window to a route (from a detached window or the
   *  main one — the shell ExecJS's __xicNavigate either way) */
  showInMain(url: string) {
    if (inWebView()) tell(`xicompanion:main:${url}`);
    else location.assign(url);
  },

  /** pull the shell's persisted window bounds into shellGeom */
  refreshGeom() {
    if (inWebView()) tell('xicompanion:geom');
  },

  /** open a url in the system browser — the overlay can't navigate
   *  itself, so it goes through the shell's ShellExecute */
  openExternal(url: string) {
    if (inWebView()) tell(`xicompanion:open:${url}`);
    else window.open(url, '_blank', 'noopener');
  },

  /** persist + live-apply bounds for 'fab' or a spawned route key
   *  ('/tracker'); w/h optional — the shell keeps the known size */
  setGeom(key: string, r: { x: number; y: number; w?: number; h?: number }) {
    const wh = r.w != null && r.h != null ? `,${r.w},${r.h}` : '';
    tell(`xicompanion:geom-set:${key}:${r.x},${r.y}${wh}`);
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

// climbs ancestors for --wails-draggable — 'drag' = caption move,
// 'no-drag' = interactive element (edge zones must not resize-grab it)
function dragRegionOf(t: HTMLElement | null): 'drag' | 'no-drag' | null {
  let el = t;
  // e.target can be Document — getComputedStyle throws on non-Elements
  while (el instanceof HTMLElement && el !== document.body) {
    const v = getComputedStyle(el).getPropertyValue('--wails-draggable').trim();
    if (v === 'no-drag') return 'no-drag';
    if (v === 'drag') return 'drag';
    el = el.parentElement;
  }
  return null;
}

// Wires the frameless chrome affordances for the wails shell (full mode
// only — the fab handles its own drag/click):
//  - no-drag wins over the resize border so buttons inside edge zones
//    (× in the corner) still click; resize edges win over drag so the
//    title bar's top sliver + corners resize rather than move
//  - edges: mousemove shows the resize cursor; mousedown starts the
//    Go-driven size loop via "xicompanion:resize:<cursor>"
//  - drag: mousedown on a --wails-draggable:drag element (honoring
//    no-drag) starts the Go-driven caption move via "xicompanion:drag"
export function installWindowChrome() {
  if (!inWebView()) return;
  updateFabMode();
  window.addEventListener('resize', updateFabMode);

  // hovered resize edge → bright border hint, overlay-only so content
  // doesn't reflow; the 'rc' class forces the resize cursor past
  // per-element cursor rules (buttons would otherwise keep 'pointer')
  let hlEl: HTMLDivElement | null = null;
  const edgeHl = (edge: string | null) => {
    if (!edge) {
      hlEl?.remove();
      hlEl = null;
      return;
    }
    if (!hlEl) {
      hlEl = document.createElement('div');
      hlEl.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:9999;' +
        'border:0 solid rgba(56,189,248,.85);';
      document.body.appendChild(hlEl);
    }
    hlEl.style.borderWidth =
      (edge[0] === 'n' ? '2px ' : '0 ') +
      (edge.includes('e') ? '2px ' : '0 ') +
      (edge[0] === 's' || edge === 'sw-resize' || edge === 'se-resize' || edge === 's-resize' ? '2px ' : '0 ') +
      (edge.includes('w') ? '2px' : '0');
  };
  const setEdge = (edge: string | null) => {
    const cursor = edge ?? '';
    if (document.documentElement.style.cursor !== cursor) {
      document.documentElement.style.cursor = cursor;
    }
    document.documentElement.classList.toggle('rc', edge !== null);
    edgeHl(edge);
  };
  document.addEventListener('mousemove', (e) => {
    if (e.buttons !== 0 || fabMode.value || tooltipMode) return; // no churn mid-drag / no edges on fab/tooltip
    const region = dragRegionOf(e.target as HTMLElement);
    setEdge(region === 'no-drag' ? null : edgeAt(e.clientX, e.clientY));
  });
  document.addEventListener('mouseleave', () => setEdge(null));

  document.addEventListener(
    'mousedown',
    (e) => {
      // NOACTIVATE windows can't raise themselves — the shell lifts the
      // touched window to band-top on our behalf (z-order, not focus)
      if (e.button === 0) tell('xicompanion:raise');
      if (e.button !== 0 || fabMode.value) return;
      if (dragRegionOf(e.target as HTMLElement) === 'no-drag') return;
      // resize edges win over the drag region — the title bar's top
      // 8px sliver + corners resize instead of moving the window
      const edge =
        tooltipMode || menuMode ? null : edgeAt(e.clientX, e.clientY);
      if (edge) {
        e.preventDefault();
        e.stopPropagation();
        tell(`xicompanion:resize:${edge}`);
        return;
      }
      if (dragRegionOf(e.target as HTMLElement) === 'drag') {
        e.preventDefault(); // no text selection while dragging
        e.stopPropagation();
        tell('xicompanion:drag');
      }
    },
    true,
  );

  // every click hands keyboard focus back to the game — the webview
  // claims foreground on click and losing game input mid-fight is the
  // surprise we're avoiding. Text-entry elements keep focus so typing
  // still works; the shell SetForegroundWindows FFXI on xicompanion:refocus.
  document.addEventListener(
    'mouseup',
    (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable="true"]')) return;
      tell('xicompanion:refocus');
    },
    true,
  );
}
