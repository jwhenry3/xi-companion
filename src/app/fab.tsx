// Floating action button — what the overlay renders while the shell is in
// fab mode (56px window). Click expands to the full UI, drag repositions,
// right-click quits the overlay process.
import { host } from './core/host';

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

export function Fab() {
  let dragging = false;

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    dragging = false;
    const sx = e.screenX;
    const sy = e.screenY;

    // A plain click expands; once the pointer moves past the threshold we
    // hand off to the native caption-move loop — which then owns the rest
    // of the gesture (mouseup never reaches the page, so no click fires).
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
    if (!dragging) host.expand();
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    host.quit();
  };

  return (
    <div
      class="grid h-screen w-screen cursor-default place-items-center bg-transparent"
      title="XI Companion — click to open · drag to move · right-click to quit"
      onContextMenu={onContextMenu}
    >
      <button
        class="grid h-12 w-12 cursor-pointer place-items-center rounded-full bg-slate-800 shadow-lg shadow-black/60 ring-1 ring-slate-600 transition hover:bg-slate-700"
        onMouseDown={onMouseDown}
        onClick={onClick}
      >
        <XicLogo size={34} />
      </button>
    </div>
  );
}
