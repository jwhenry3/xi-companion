// Menu bar — what the overlay renders while the shell is in fab mode
// (540×56 window): one row of buttons covering every detached-able
// window. A click toggles the window (open ↔ close); the XIC mark opens
// the main UI. Open windows glow. Drag anywhere to reposition,
// right-click quits the overlay process.
import { host, openWindows } from './core/host';
import {
  ScrollText,
  Keyboard,
  Timer,
  Radar,
  Package,
  MessageSquare,
  BookOpen,
  Map as MapIcon,
  NotebookPen,
  Shirt,
  Settings,
} from 'lucide-preact';

const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag

// "XIC" in the FFXI wordmark style — Cinzel Bold (Trajan clone,
// bundled in assets/fonts) with the logo's gold metallic gradient over
// a dark edge. paint-order=stroke keeps the outline behind the fill.
function XicLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <defs>
        <linearGradient id="xic-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f9e7a8" />
          <stop offset="0.45" stop-color="#e0b64f" />
          <stop offset="1" stop-color="#8a5f14" />
        </linearGradient>
      </defs>
      <text
        x="12"
        y="17.8"
        text-anchor="middle"
        font-family="'Cinzel', 'Times New Roman', serif"
        font-weight="700"
        font-size="14.5"
        textLength="20.5"
        lengthAdjust="spacingAndGlyphs"
        fill="url(#xic-gold)"
        stroke="#171106"
        stroke-width="0.7"
        paint-order="stroke"
      >
        XIC
      </text>
    </svg>
  );
}

// Shared press handling: a plain click runs the button's action; once the
// pointer moves past the threshold we hand off to the native caption-move
// loop — which then owns the rest of the gesture (mouseup never reaches
// the page, so no click fires).
function pressDrag(onPress: () => void) {
  let dragging = false;
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // buttons handle their own press — not the grid's
    dragging = false;
    const sx = e.screenX;
    const sy = e.screenY;
    const onMove = (ev: MouseEvent) => {
      if (dragging) return;
      if (Math.hypot(ev.screenX - sx, ev.screenY - sy) > DRAG_THRESHOLD) {
        dragging = true;
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        host.drag(); // → xic:drag
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  };
  const onClick = () => {
    if (!dragging) onPress();
  };
  return { onMouseDown, onClick };
}

const BTN =
  'ffxi-fab grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full transition';

// always-on fab layer first (tracker-style overlay panels), then the
// main UI's pages — both groups toggle their own detached window
const PANELS = [
  { path: '/tracker', label: 'quest tracker', Icon: ScrollText },
  { path: '/macrobar', label: 'macro bar', Icon: Keyboard },
  { path: '/cooldowns', label: 'cooldowns', Icon: Timer },
  { path: '/minimap', label: 'minimap', Icon: Radar },
];
const PAGES = [
  { path: '/', label: 'inventory', Icon: Package },
  { path: '/chat', label: 'chat', Icon: MessageSquare },
  { path: '/journal', label: 'journal', Icon: BookOpen },
  { path: '/map', label: 'map', Icon: MapIcon },
  { path: '/macros', label: 'macro editor', Icon: NotebookPen },
  { path: '/profile', label: 'gearswap sets', Icon: Shirt },
  { path: '/settings', label: 'settings', Icon: Settings },
];

function Sep() {
  return <span class="h-6 w-px shrink-0 bg-indigo-200/30" />;
}

export function Fab() {
  // drag from the gaps between buttons too — the container doubles as a
  // handle so there's no dead space in the bar
  const gap = pressDrag(() => {});
  const open = openWindows.value;

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    host.quit();
  };

  return (
    <div
      class="flex h-screen w-screen cursor-default items-center justify-center bg-transparent"
      title="XI Companion — click toggles a window · drag to move · right-click to quit"
      onContextMenu={onContextMenu}
    >
      <div class="flex items-center gap-1" onMouseDown={gap.onMouseDown}>
        <button
          class={BTN}
          title="main window"
          {...pressDrag(() => host.expand())}
        >
          <XicLogo size={26} />
        </button>
        <Sep />
        {PANELS.map(({ path, label, Icon }) => (
          <button
            class={`${BTN}${open.includes(path) ? ' on' : ''}`}
            title={label}
            {...pressDrag(() => host.toggleWindow(path))}
          >
            <Icon size={18} />
          </button>
        ))}
        <Sep />
        {PAGES.map(({ path, label, Icon }) => (
          <button
            class={`${BTN}${open.includes(path) ? ' on' : ''}`}
            title={label}
            {...pressDrag(() => host.toggleWindow(path))}
          >
            <Icon size={18} />
          </button>
        ))}
      </div>
    </div>
  );
}
