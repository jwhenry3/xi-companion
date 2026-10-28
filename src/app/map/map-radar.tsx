// MapRadar: SVG rendering of the addon's MapState — the zone map image
// when the addon serves one (data/maps/<zone>_<map>.png), a faint grid
// otherwise, then widescan diamonds, entity dots and the player arrow.
// Shared by the /map page (whole-map fit) and the /minimap window
// (player-centered radius). All coordinates are map pixels in the
// state's `ms` space, so the viewBox doubles as the unit system.
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  MapState,
  MapEntity,
  MapWsEntry,
  MapPoi,
} from '../core/types';

const C = {
  party: '#38bdf8', // sky-400
  ally: '#22d3ee', // cyan-400
  ls: '#fb923c', // orange-400
  nm: '#fde047', // yellow-300
  mob: '#fb7185', // rose-400
  npc: '#34d399', // emerald-400
  qmk: '#e879f9', // fuchsia-400 — '???' examination points
  pc: '#a78bfa', // violet-400
  other: '#94a3b8', // slate-400
  ws: '#fbbf24', // amber-400
  me: '#f8fafc', // slate-50
};

// POI kinds — a real FFXI item icon (item id served by /api/icon)
// per kind, themed to the marker: homepoints are crystals, maws are
// void, waypoints are waystones... `color`/`label` feed the map page's
// filter chips. Order doubles as the chip order.
export const POI_KIND: Record<
  string,
  { color: string; label: string; icon: number }
> = {
  hp: { color: '#38bdf8', label: 'home point', icon: 4102 }, // Light Crystal
  book: { color: '#4ade80', label: 'book', icon: 6717 }, // Trust Tome
  tele: { color: '#67e8f9', label: 'telepoint', icon: 6508 }, // Vortex Crystal
  maw: { color: '#a78bfa', label: 'cavernous maw', icon: 9214 }, // Void Crystal
  way: { color: '#fdba74', label: 'waypoint', icon: 2862 }, // Kingdom Waystone
  portal: { color: '#f9a8d4', label: 'portal', icon: 4063 }, // Macrocosmic Orb
  flux: { color: '#cbd5e1', label: 'conflux', icon: 4057 }, // Gelid Aggregate
  fount: { color: '#34d399', label: 'geo fount', icon: 6509 }, // Geo Crystal
  in: { color: '#c084fc', label: 'ingress', icon: 2490 }, // Forbidden Key
  rift: { color: '#fb7185', label: 'planar rift', icon: 4061 }, // Riftborn Boulder
  outpost: { color: '#fbbf24', label: 'outpost', icon: 129 }, // Imperial Standard
};

/** one POI icon at (p.x, p.y); `s` is the half-size in viewBox units.
 *  The kind-colored disc stays underneath as a fallback when the icon
 *  fetch 404s (Ashita, missing DATs) — image/bmp renders in every
 *  WebView we target. */
function PoiGlyph({
  p,
  s,
  iconUrl,
}: {
  p: MapPoi;
  s: number;
  iconUrl: (id: number) => string;
}) {
  const st = POI_KIND[p.k] ?? { color: '#e2e8f0', label: p.k, icon: 0 };
  return (
    <g transform={`translate(${p.x} ${p.y})`}>
      <circle
        cx={0}
        cy={0}
        r={s * 0.75}
        fill={st.color}
        fill-opacity={0.35}
      />
      {st.icon > 0 && (
        <image
          href={iconUrl(st.icon)}
          x={-s}
          y={-s}
          width={s * 2}
          height={s * 2}
        />
      )}
      {p.n && <title>{p.n}</title>}
    </g>
  );
}

// entity category — drives the row label, the dot color, and the
// list's type-filter chips. Grouping wins over the linkshell ring:
// an LS mate who's also in your party reads as party.
export function entKind(e: MapEntity): string {
  if (e.f & 1) return 'party';
  if (e.f & 2) return 'alliance';
  if (e.f & 8) return 'linkshell';
  if (e.f & 16) return 'nm';
  if (e.st === 16) return 'mob';
  // '???' NPCs are quest/examination points — filterable, not generic NPCs
  if (e.n === '???') return '???';
  if (e.f & 4 || e.st === 2) return 'npc';
  if (e.st === 1) return 'player';
  return 'other';
}

export function entColor(e: MapEntity): string {
  if (e.f & 1) return C.party; // social rings first — always friendly
  if (e.f & 2) return C.ally;
  if (e.f & 8) return C.ls;
  if (e.f & 16) return C.nm;
  if (e.st === 16) return C.mob;
  if (e.n === '???') return C.qmk;
  if (e.f & 4 || e.st === 2) return C.npc;
  if (e.st === 1) return C.pc;
  return C.other;
}

/** widescan blips render at absolute wx/wy — map.lua projects every
 *  0x0F4 entry (and 0x0F5 track update) through the client's world->map
 *  transform. x/y are the raw world-yalm deltas and only act as a
 *  fallback when the Lua-side projection was unavailable */
const wsX = (w: MapWsEntry, me: { x: number }) => w.wx ?? me.x + w.x;
const wsY = (w: MapWsEntry, me: { y: number }) => w.wy ?? me.y + w.y;

// height delta (yalms) past which a marker earns an elevation chevron —
// same-floor slope jitter stays under this
export const ELEV_DELTA = 3;

/** triangle path centered on the origin in `dot` units: dir -1 points
 *  up (entity is above the player, apex above `base`), +1 points down */
const chev = (dir: -1 | 1, base: number, dot: number) =>
  `M 0 ${dir * (base + 1.15) * dot} L ${0.85 * dot} ${dir * base * dot} L ${
    -0.85 * dot
  } ${dir * base * dot} Z`;

/** signed elevation for tooltips: "+12" / "-8" when past the band */
const elText = (el?: number) =>
  el != null && Math.abs(el) >= ELEV_DELTA
    ? `  ${el > 0 ? '+' : ''}${el}y`
    : '';

export function MapRadar(props: {
  s: MapState | null;
  /** map-px half-extent of the view; omit to fit the whole map */
  radius?: number;
  /** view center in map px when radius is set (default: the player) */
  center?: { x: number; y: number };
  /** resolved zone image URL, or null for the grid fallback */
  img?: string | null;
  /** POI kinds to hide (from the map page's marker filter chips);
   *  unset = show everything */
  poiHide?: ReadonlySet<string>;
  /** multiplier on all marker sizes/strokes (default 1) */
  scale?: number;
  /** entity kinds to hide (party/alliance/player/npc/... via
   *  entKind); unset = show everything */
  entHide?: ReadonlySet<string>;
  /** entity index (MapEntity.i) of the row selected in the side list —
   *  gets a pulsing ring on the radar */
  sel?: number | null;
  /** entity index of the player's live target (party payload t.i) —
   *  an amber chevron floating over the dot, like the client's arrow */
  tgt?: number | null;
  /** resolves an item id to its /api/icon URL (the views own AddonApi) */
  iconUrl: (id: number) => string;
  class?: string;
}) {
  // position smoothing — SSE snapshots land in bursts, so each marker
  // lerps toward its latest target on a rAF loop instead of snapping.
  // Keyed per entity index; cleared on zone change. All hooks live
  // above the early return below.
  const lerped = useRef(
    new Map<
      string,
      { x: number; y: number; el?: number; tx: number; ty: number; tel?: number }
    >(),
  );
  const lerpZone = useRef('');
  const [, bump] = useState(0);
  const raf = useRef(0);
  const lastT = useRef(0);
  const step = () => {
    raf.current = 0;
    const now = performance.now();
    const dt = Math.min(80, now - (lastT.current || now));
    lastT.current = now;
    const k = 1 - Math.exp(-dt / 160); // ~160ms settle, framerate-independent
    let moving = false;
    for (const p of lerped.current.values()) {
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const de = p.el != null && p.tel != null ? p.tel - p.el : 0;
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05 || Math.abs(de) > 0.02) {
        p.x += dx * k;
        p.y += dy * k;
        if (p.el != null) p.el += de * k;
        moving = true;
      } else {
        p.x = p.tx;
        p.y = p.ty;
        p.el = p.tel;
      }
    }
    if (moving) {
      bump((t) => t + 1);
      raf.current = requestAnimationFrame(step);
    }
  };
  // kick the loop after every render (new targets may have landed)
  useEffect(() => {
    if (!raf.current) {
      lastT.current = performance.now();
      raf.current = requestAnimationFrame(step);
    }
  });
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

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
  // sync lerp targets from the new snapshot; a zone/map change snaps
  // everything (an entity index means nothing across zones)
  const zoneKey = `${s.z ?? ''}:${s.m ?? ''}`;
  if (lerpZone.current !== zoneKey) {
    lerpZone.current = zoneKey;
    lerped.current.clear();
  }
  const seen = new Set<string>();
  const pull = (key: string, x: number, y: number, el?: number) => {
    seen.add(key);
    let p = lerped.current.get(key);
    if (!p) {
      p = { x, y, el, tx: x, ty: y, tel: el };
      lerped.current.set(key, p);
    } else {
      p.tx = x;
      p.ty = y;
      p.tel = el;
    }
    return p;
  };
  const meRaw = s.me;
  const meT = pull('me', meRaw.x, meRaw.y);
  const me = { ...meRaw, x: meT.x, y: meT.y };
  const wss = (s.ws ?? []).map((w) => {
    const p = pull(`w${w.i}`, wsX(w, meRaw), wsY(w, meRaw), w.el);
    return { w, x: p.x, y: p.y, el: p.el };
  });
  const ents = (s.e ?? []).map((e, i) => {
    const p = pull(e.i != null ? `e${e.i}` : `x${i}`, e.x, e.y, e.el);
    return { e, x: p.x, y: p.y, el: p.el, i };
  });
  for (const k of lerped.current.keys()) {
    if (!seen.has(k)) lerped.current.delete(k);
  }
  const r = props.radius;
  const cx = props.center?.x ?? me.x;
  const cy = props.center?.y ?? me.y;
  const vb = r
    ? `${cx - r} ${cy - r} ${r * 2} ${r * 2}`
    : `0 0 ${ms} ${ms}`;
  // dot/line sizes live in viewBox units — proportional to the visible
  // extent so the rendered pixel size stays constant at every zoom. A
  // floor in map units (the old Math.max) read oversized when zoomed in
  const unit = ((r ? r * 2 : ms) / 220) * (props.scale ?? 1);
  const dot = unit * 3;
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

      {wss.map(({ w, x, y, el }) => (
        <g key={`w${w.i}`}>
          <rect
            x={x - dot * 1.1}
            y={y - dot * 1.1}
            width={dot * 2.2}
            height={dot * 2.2}
            transform={`rotate(45 ${x} ${y})`}
            fill="none"
            stroke={w.tr ? C.me : w.nm ? C.nm : C.ws}
            stroke-width={unit * 1.2}
          />
          {/* elevation chevron — only tracked targets (0x0F5) carry el */}
          {el != null && el >= ELEV_DELTA && (
            <path
              d={chev(-1, 1.75, dot)}
              transform={`translate(${x} ${y})`}
              fill={w.tr ? C.me : w.nm ? C.nm : C.ws}
              stroke="#000"
              stroke-width={unit * 0.5}
            />
          )}
          {el != null && el <= -ELEV_DELTA && (
            <path
              d={chev(1, 1.75, dot)}
              transform={`translate(${x} ${y})`}
              fill={w.tr ? C.me : w.nm ? C.nm : C.ws}
              stroke="#000"
              stroke-width={unit * 0.5}
            />
          )}
          {w.n && (
            <title>{`${w.n}${w.l > 1 ? `  lv${w.l}` : ''}${elText(el)}`}</title>
          )}
        </g>
      ))}

      {ents
        .filter((t) => !props.entHide?.has(entKind(t.e)))
        .map(({ e, x, y, el, i }) => {
        const col = entColor(e);
        return (
          <g key={e.i != null ? `e${e.i}` : `x${i}`}>
            <circle
              cx={x}
              cy={y}
              r={dot * 0.55}
              fill={col}
              fill-opacity={e.hp === 0 ? 0.35 : 0.95}
              stroke="#000"
              stroke-width={unit * 0.8}
            />
            {/* ▲ above / ▼ below when the height delta clears the
                same-floor noise band */}
            {(el ?? 0) >= ELEV_DELTA && (
              <path
                d={chev(-1, 0.75, dot)}
                transform={`translate(${x} ${y})`}
                fill={col}
                stroke="#000"
                stroke-width={unit * 0.5}
              />
            )}
            {(el ?? 0) <= -ELEV_DELTA && (
              <path
                d={chev(1, 0.75, dot)}
                transform={`translate(${x} ${y})`}
                fill={col}
                stroke="#000"
                stroke-width={unit * 0.5}
              />
            )}
            {e.i != null && e.i === props.sel && (
              <>
                <circle
                  cx={x}
                  cy={y}
                  r={dot * 0.95}
                  fill="none"
                  stroke={C.me}
                  stroke-width={unit * 0.9}
                />
                <circle
                  cx={x}
                  cy={y}
                  r={dot * 0.95}
                  fill="none"
                  stroke={C.me}
                  stroke-width={unit * 0.9}
                >
                  <animate
                    attributeName="r"
                    values={`${dot * 0.95};${dot * 1.8}`}
                    dur="1s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="stroke-opacity"
                    values="0.9;0"
                    dur="1s"
                    repeatCount="indefinite"
                  />
                </circle>
              </>
            )}
            {e.i != null && e.i === props.tgt && (
              <path
                d={chev(1, 0.9, dot)}
                transform={`translate(${x} ${y - dot * 2.2})`}
                fill="#fbbf24"
                stroke="#1e293b"
                stroke-width={unit * 0.4}
              />
            )}
            <title>{`${e.n ?? '—'}${elText(el)}`}</title>
          </g>
        );
        })}

      {/* static POI markers — above the live layers so landmarks stay
          legible under crowds; the player arrow still draws last */}
      {(s.poi ?? [])
        .filter((p) => !props.poiHide?.has(p.k))
        .map((p, i) => (
          <PoiGlyph
            key={`p${i}`}
            p={p}
            s={dot * 1.5}
            iconUrl={props.iconUrl}
          />
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
