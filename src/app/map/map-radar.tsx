// MapRadar: SVG rendering of the addon's MapState — the zone map image
// when the addon serves one (data/maps/<zone>_<map>.png), a faint grid
// otherwise, then widescan diamonds, entity dots and the player arrow.
// Shared by the /map page (whole-map fit) and the /minimap window
// (player-centered radius). All coordinates are map pixels in the
// state's `ms` space, so the viewBox doubles as the unit system.
import type { MapState, MapEntity, MapWsEntry } from '../core/types';

const C = {
  party: '#38bdf8', // sky-400
  ally: '#22d3ee', // cyan-400
  ls: '#fb923c', // orange-400
  mob: '#fb7185', // rose-400
  npc: '#34d399', // emerald-400
  pc: '#a78bfa', // violet-400
  other: '#94a3b8', // slate-400
  ws: '#fbbf24', // amber-400
  me: '#f8fafc', // slate-50
};

function entColor(e: MapEntity): string {
  if (e.f & 1) return C.party; // social rings first — always friendly
  if (e.f & 2) return C.ally;
  if (e.f & 8) return C.ls;
  if (e.st === 16) return C.mob;
  if (e.f & 4 || e.st === 2) return C.npc;
  if (e.st === 1) return C.pc;
  return C.other;
}

/** widescan x/y are map-px offsets from the player's map pos; tracked
 *  targets get absolute wx/wy from 0x0F5 updates instead */
const wsX = (w: MapWsEntry, me: { x: number }) => w.wx ?? me.x + w.x;
const wsY = (w: MapWsEntry, me: { y: number }) => w.wy ?? me.y + w.y;

export function MapRadar(props: {
  s: MapState | null;
  /** map-px half-extent centered on the player; omit to fit the map */
  radius?: number;
  /** resolved zone image URL, or null for the grid fallback */
  img?: string | null;
  class?: string;
}) {
  const s = props.s;
  if (!s || s.on === 0 || !s.me) {
    return (
      <div
        class={`flex items-center justify-center text-[10px] text-slate-500 ${
          props.class ?? ''
        }`}
      >
        no map data
      </div>
    );
  }
  const ms = s.ms ?? 512;
  const me = s.me;
  const r = props.radius;
  const vb = r
    ? `${me.x - r} ${me.y - r} ${r * 2} ${r * 2}`
    : `0 0 ${ms} ${ms}`;
  // dot/line sizes live in viewBox units so they read consistently at
  // any zoom — a whole-map fit shows ~512 units, a close radar ~100
  const unit = (r ? r * 2 : ms) / 220;
  const dot = Math.max(1.8, unit * 3);
  // facing: radians, 0 = east, increasing clockwise (same handedness as
  // the y-down map space) — the arrow shape points up, so +90 aligns it
  const deg = ((me.f ?? 0) * 180) / Math.PI + 90;
  const grid = ms / 8;

  return (
    <svg
      class={props.class ?? ''}
      viewBox={vb}
      preserveAspectRatio="xMidYMid meet"
      style="display:block;width:100%;height:100%"
    >
      {props.img ? (
        <image href={props.img} x={0} y={0} width={ms} height={ms} />
      ) : (
        <>
          <rect x={0} y={0} width={ms} height={ms} fill="#0b1029" />
          {Array.from({ length: 9 }, (_, i) => i * grid).map((g) => (
            <g key={g} stroke="#ccd4f022" stroke-width={unit * 0.6}>
              <line x1={g} y1={0} x2={g} y2={ms} />
              <line x1={0} y1={g} x2={ms} y2={g} />
            </g>
          ))}
        </>
      )}

      {(s.ws ?? []).map((w) => (
        <g key={`w${w.i}`}>
          <rect
            x={wsX(w, me) - dot * 1.1}
            y={wsY(w, me) - dot * 1.1}
            width={dot * 2.2}
            height={dot * 2.2}
            transform={`rotate(45 ${wsX(w, me)} ${wsY(w, me)})`}
            fill="none"
            stroke={w.tr ? C.me : C.ws}
            stroke-width={unit * 1.2}
          />
          {w.n && <title>{`${w.n}${w.l > 1 ? `  lv${w.l}` : ''}`}</title>}
        </g>
      ))}

      {(s.e ?? []).map((e, i) => (
        <circle
          key={`e${i}`}
          cx={e.x}
          cy={e.y}
          r={dot * 0.55}
          fill={entColor(e)}
          fill-opacity={e.hp === 0 ? 0.35 : 0.95}
          stroke="#000"
          stroke-width={unit * 0.8}
        >
          <title>{e.n ?? '—'}</title>
        </circle>
      ))}

      {/* player arrow — triangle pointing up, rotated by facing;
          scale(0.65) keeps it readable without covering the dots it
          sits on top of */}
      <path
        d={`M 0 ${-dot * 1.7} L ${dot * 1.3} ${dot * 1.3} L 0 ${
          dot * 0.6
        } L ${-dot * 1.3} ${dot * 1.3} Z`}
        fill={C.me}
        stroke="#1e293b"
        stroke-width={unit * 0.8}
        transform={`translate(${me.x} ${me.y}) rotate(${deg}) scale(0.65)`}
      />
    </svg>
  );
}
