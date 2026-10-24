// Floating action cluster — what the overlay renders while the shell is in
// fab mode (112px window): a 2×2 grid of buttons — main UI, quest tracker,
// macro bar, cooldowns. Click opens/focuses the target, drag repositions,
// right-click quits the overlay process.
import { host } from './core/host';
import { ScrollText, Keyboard, Timer } from 'lucide-preact';

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
        host.drag(); // → wails:drag
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
  'ffxi-fab grid h-11 w-11 cursor-pointer place-items-center rounded-full transition';

export function Fab() {
  // drag from the gap between buttons too — the container doubles as a
  // handle so there's no dead space in the cluster
  const gap = pressDrag(() => {});

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    host.quit();
  };

  return (
    <div
      class="grid h-screen w-screen cursor-default place-items-center bg-transparent"
      title="XI Companion — click a button · drag to move · right-click to quit"
      onContextMenu={onContextMenu}
    >
      <div
        class="grid grid-cols-2 gap-1.5"
        onMouseDown={gap.onMouseDown}
      >
        <button
          class={BTN}
          title="main window"
          {...pressDrag(() => host.expand())}
        >
          <XicLogo size={30} />
        </button>
        <button
          class={BTN}
          title="quest tracker"
          {...pressDrag(() => host.spawnWindow('/tracker'))}
        >
          <ScrollText size={18} />
        </button>
        <button
          class={BTN}
          title="macro bar"
          {...pressDrag(() => host.spawnWindow('/macrobar'))}
        >
          <Keyboard size={18} />
        </button>
        <button
          class={BTN}
          title="cooldowns"
          {...pressDrag(() => host.spawnWindow('/cooldowns'))}
        >
          <Timer size={18} />
        </button>
      </div>
    </div>
  );
}
