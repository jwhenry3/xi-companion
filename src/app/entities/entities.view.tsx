// Nearby: detached panel-mode window (/entities?window=1) — the
// entity list without the map. Clicking a row writes
// xicompanion.selent to shared localStorage; the /minimap (and /map)
// window's storage listener picks it up and pulses that entity's
// marker on the radar.
import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import type { MapEntity, MapPoi, MapWsEntry } from '../core/types';
import {
  ELEV_DELTA,
  POI_KIND,
  entColor,
  entKind,
} from '../map/map-radar';
import { HIDE_KEY, loadHidden, saveHidden } from '../map/map-zoom';
import { cn } from '@/lib/utils';

const SEL_KEY = 'xicompanion.selent';

// same order + text color as the map page's chips — the hide-set is
// shared through localStorage, so toggling here updates /map and
// /minimap on the next storage event (and vice versa)
const FILTER_ORDER = ['players', 'mob', 'npc', 'poi'];
const FILTER_COLOR: Record<string, string> = {
  players: 'text-sky-300',
  mob: 'text-rose-300',
  npc: 'text-emerald-300',
  poi: 'text-fuchsia-400',
};
const MOBS = new Set(['mob', 'nm']);
const PLAYERS = new Set(['party', 'alliance', 'linkshell', 'player']);
const KIND_COLOR: Record<string, string> = {
  party: 'text-sky-300',
  alliance: 'text-cyan-300',
  linkshell: 'text-orange-300',
  player: 'text-violet-300',
  npc: 'text-emerald-300',
  '???': 'text-fuchsia-400',
  nm: 'text-yellow-300',
  mob: 'text-rose-300',
  ws: 'text-slate-500',
  other: 'text-slate-400',
};

@Component()
export class EntitiesView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private sel = signal<number | null>(
    (() => {
      const v = Number(localStorage.getItem(SEL_KEY));
      return Number.isFinite(v) ? v : null;
    })(),
  );
  private hiddenKinds = signal<ReadonlySet<string>>(loadHidden());
  private onStorage = (e: StorageEvent) => {
    if (e.key === SEL_KEY) {
      const v = Number(localStorage.getItem(SEL_KEY));
      this.sel.value = Number.isFinite(v) ? v : null;
    }
    if (e.key === HIDE_KEY) this.hiddenKinds.value = loadHidden();
  };

  private toggleKind(k: string) {
    const next = new Set(this.hiddenKinds.value);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    this.hiddenKinds.value = next;
    saveHidden(next);
  }

  // widescan-only objects (most ???'s) — classify into the same kind
  // buckets so the filter chips cover them
  private wsKind(w: { n?: string; nm?: number }): string {
    return w.nm ? 'nm' : w.n === '???' ? '???' : 'ws';
  }

  // three filter groups: players covers every PC kind, npc covers the
  // rest of the mob-array + widescan kinds, and POI covers the map
  // markers AND ???s (they're examination points, not really NPCs)
  private groupOf = (k: string) =>
    k === '???' || k === 'poi'
      ? 'poi'
      : PLAYERS.has(k)
        ? 'players'
        : MOBS.has(k)
          ? 'mob'
          : 'npc';

  // all three filters always visible — an empty group just has no rows
  private kinds = FILTER_ORDER;

  private q = signal('');

  onInit() {
    void this.api.refreshMap();
    window.addEventListener('storage', this.onStorage);
  }

  onDestroy() {
    window.removeEventListener('storage', this.onStorage);
  }

  private pick(e: MapEntity) {
    const next = e.i === this.sel.value ? null : e.i;
    this.sel.value = next ?? null;
    // storage events only reach OTHER windows — ours uses the signal
    localStorage.setItem(SEL_KEY, next == null ? '' : String(next));
  }

  private row(e: MapEntity) {
    const kind = entKind(e);
    const isSel = e.i != null && e.i === this.sel.value;
    return (
      <div
        key={e.i}
        class={cn(
          'flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 text-xs hover:bg-slate-800/60',
          isSel && 'bg-slate-800/80',
        )}
        title="highlight on minimap"
        onClick={() => this.pick(e)}
      >
        <span
          class="w-2 shrink-0 text-center"
          style={`color:${entColor(e)}`}
        >
          ●
        </span>
        {/* name colored by relationship for PCs — party/alliance/
            linkshell tints like the client's own name display */}
        <span
          class={cn(
            'min-w-0 flex-1 truncate',
            PLAYERS.has(kind) ? KIND_COLOR[kind] : 'text-slate-200',
          )}
        >
          {e.n || '—'}
        </span>
        {/* damaged mob/NM (st 16): slim hp bar + % */}
        {e.st === 16 && e.hp < 100 && (
          <span class="flex shrink-0 items-center gap-1">
            <span class="block h-1.5 w-9 overflow-hidden rounded bg-slate-700/80">
              <span
                class={cn(
                  'block h-full',
                  e.hp <= 25
                    ? 'bg-rose-500'
                    : e.hp <= 50
                      ? 'bg-amber-500'
                      : 'bg-emerald-500',
                )}
                style={`width:${Math.max(0, e.hp)}%`}
              />
            </span>
            <span class="text-[9px] tabular-nums text-slate-400">
              {e.hp}%
            </span>
          </span>
        )}
        {e.el != null && Math.abs(e.el) >= ELEV_DELTA && (
          <span
            class="shrink-0 text-[9px] tabular-nums text-slate-400"
            title={`${Math.abs(e.el)} yalms ${e.el > 0 ? 'above' : 'below'} you`}
          >
            {e.el > 0 ? '▲' : '▼'}
            {Math.abs(e.el)}
          </span>
        )}
        {e.d > 0 && (
          <span class="w-9 shrink-0 text-right text-[9px] tabular-nums text-slate-500">
            {e.d.toFixed(1)}y
          </span>
        )}
        {kind !== 'other' && (
          <span class="shrink-0 text-[9px] uppercase text-slate-500">
            {kind}
          </span>
        )}
      </div>
    );
  }

  private poiRow(p: MapPoi) {
    const k = POI_KIND[p.k];
    return (
      <div
        key={`poi-${p.k}-${p.x}-${p.y}`}
        class="flex items-center gap-2 rounded px-2 py-0.5 text-xs"
      >
        {k ? (
          <img src={this.api.iconUrl(k.icon)} class="h-4 w-4 shrink-0" />
        ) : (
          <span class="w-2 shrink-0 text-center text-slate-400">◆</span>
        )}
        <span class="min-w-0 flex-1 truncate text-slate-300">
          {p.n || '—'}
        </span>
        <span
          class="shrink-0 text-[9px] uppercase"
          style={`color:${k?.color ?? '#94a3b8'}`}
        >
          {k?.label ?? p.k}
        </span>
      </div>
    );
  }

  // widescan rows — most ???'s only ever appear here (they're outside
  // the mob array until you're close). No click-select: widescan
  // entries aren't in the mob array, so e.i doesn't map onto sel.
  private wsRow(w: { i: number; n?: string; nm?: number; l: number }) {
    const kind = this.wsKind(w);
    return (
      <div
        key={`ws-${w.i}`}
        class="flex items-center gap-2 rounded px-2 py-0.5 text-xs"
        title="widescan — too far for the mob array"
      >
        <span class={cn('w-2 shrink-0 text-center', KIND_COLOR[kind] ?? 'text-slate-400')}>
          ○
        </span>
        <span class="min-w-0 flex-1 truncate text-slate-300">
          {w.n || '—'}
        </span>
        {w.l > 1 && (
          <span class="w-6 shrink-0 text-right text-[9px] tabular-nums text-slate-500">
            {w.l}
          </span>
        )}
        <span class={cn('shrink-0 text-[9px] uppercase', KIND_COLOR[kind] ?? 'text-slate-400')}>
          {kind}
        </span>
      </div>
    );
  }

  render() {
    const s = this.api.map.value;
    const on = !!s && s.on !== 0 && !!s.me;
    const ents = s?.e ?? [];
    const hidden = this.hiddenKinds.value;
    const phide = null; // poi chips gone — 'poi' is a group filter now
    // merge entities + POIs into one nearby list — sort key is map-px
    // distance to the player so both kinds interleave by proximity
    const me = s?.me as { x?: number; y?: number } | undefined;
    const pxd = (x?: number, y?: number) =>
      me?.x != null && me.y != null && x != null && y != null
        ? Math.hypot(x - me.x, y - me.y)
        : 1e9;
    const q = this.q.value.trim().toLowerCase();
    const match = (n?: string) =>
      !q || (n ?? '').toLowerCase().includes(q);
    const rows: (
      | { e: MapEntity }
      | { poi: MapPoi }
      | { ws: MapWsEntry }
    )[] = [
      ...ents
        // trusts/fellows: in_party but not PCs — the party panel
        // already covers them, so the list skips them entirely
        .filter((e) => e.st === 1 || (e.f & 1) === 0)
        .filter((e) => !hidden.has(this.groupOf(entKind(e))))
        .filter((e) => match(e.n))
        .map((e) => ({ e, pxd: pxd(e.x, e.y) })),
      ...(s?.ws ?? [])
        // named widescan entries only — and drop any already in the
        // mob array (same entity index, the near row is richer)
        .filter((w) => w.n != null && w.n !== '')
        .filter((w) => !ents.some((e) => e.i === w.i))
        .filter((w) => !hidden.has(this.groupOf(this.wsKind(w))))
        .filter((w) => match(w.n))
        .map((w) => ({ ws: w, pxd: pxd(w.wx, w.wy) })),
      ...(hidden.has('poi')
        ? []
        : (s?.poi ?? [])
            .filter((p) => match(p.n))
            .map((p) => ({ poi: p, pxd: pxd(p.x, p.y) }))),
    ]
      .sort((a, b) => a.pxd - b.pxd)
      .map((r) =>
        'e' in r ? { e: r.e } : 'poi' in r ? { poi: r.poi } : { ws: r.ws },
      );
    const sorted = rows;
    return (
      <div class="flex h-full flex-col px-1">
        {/* header stays put — only the row list scrolls */}
        {this.kinds.length > 0 && (
          <div class="flex flex-wrap items-center gap-1 bg-slate-900/90 py-1">
            <input
              class="h-5 min-w-0 flex-1 rounded border border-slate-700 bg-slate-800/70 px-1 text-[10px] text-slate-200 placeholder:text-slate-600 focus:border-slate-500 focus:outline-none"
              placeholder="search"
              value={this.q.value}
              onInput={(e) =>
                (this.q.value = (e.target as HTMLInputElement).value)
              }
            />
            {this.kinds.map((k) => {
              const off = hidden.has(k);
              return (
                <button
                  class={cn(
                    'rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide',
                    FILTER_COLOR[k],
                    off
                      ? 'opacity-35'
                      : 'bg-slate-800/70 hover:bg-slate-700/70',
                  )}
                  title={off ? `show ${k}` : `hide ${k}`}
                  onClick={() => this.toggleKind(k)}
                >
                  {k}
                </button>
              );
            })}
          </div>
        )}
        <div class="flex-1 overflow-y-auto pb-1">
        {!on ? (
          <p class="pt-4 text-center text-xs text-slate-500">
            waiting for map data
          </p>
        ) : sorted.length === 0 ? (
          <p class="pt-4 text-center text-xs text-slate-500">
            no nearby entities
          </p>
        ) : (
          sorted.map((r) =>
            'e' in r ? this.row(r.e) : 'poi' in r ? this.poiRow(r.poi) : this.wsRow(r.ws),
          )
        )}
        </div>
      </div>
    );
  }
}
