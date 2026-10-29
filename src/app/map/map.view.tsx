// Map page: the whole-zone radar — zone image (if one was dropped into
// the addon's data/maps/), live entity dots in render range, widescan
// diamonds while a scan is held, and a side list of what the radar sees.
// A "widescan" button re-issues the server's 0x0F4 scan request; the
// floating /minimap window renders the same feed zoomed to the player.
// The radar zooms via a bottom slider (persisted, 0 = whole-map fit)
// and pans by dragging — a recenter chip re-follows the player.
import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { ExternalLink, LocateFixed, Radar } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import type { MapEntity } from '../core/types';
import { MapRadar, ELEV_DELTA, POI_KIND, entKind } from './map-radar';
import { cn } from '@/lib/utils';
import { resolveMapImage } from './map-image';
import {
 radiusFor,
 loadZoom,
 saveZoom,
 loadHidden,
 saveHidden,
} from './map-zoom';
import { PanelSidebar } from '../core/panel';

const ZOOM_KEY = 'xicompanion.map.zoom';

function entLabel(e: MapEntity): string {
 const k = entKind(e);
 return k === 'other' ? '' : k;
}

const KIND_ORDER = [
 'party',
 'alliance',
 'linkshell',
 'player',
 'npc',
 '???',
 'nm',
 'mob',
 'other',
];
const KIND_COLOR: Record<string, string> = {
 party: 'text-sky-300',
 alliance: 'text-cyan-300',
 linkshell: 'text-orange-300',
 player: 'text-violet-300',
 npc: 'text-emerald-300',
 '???': 'text-fuchsia-400',
 nm: 'text-yellow-300',
 mob: 'text-rose-300',
 other: 'text-slate-400',
};

function entClass(e: MapEntity): string {
 return KIND_COLOR[entKind(e)] ?? KIND_COLOR.other;
}

@Component()
export class MapView extends View implements OnInit, OnDestroy {
 private api = inject(AddonApi);
 private mapImg = signal<string | null>(null);
 private imgFor = '';
 private scanning = signal(false);
 private scanTimer = 0;
 private zoom = signal(loadZoom(ZOOM_KEY, 0)); // slider %, 0 = whole-map fit
 // explicit view center once the user drags; null = follow the player
 private pan = signal<{ x: number; y: number } | null>(null);
 private drag = signal<{
 px: number;
 py: number;
 cx: number;
 cy: number;
 r: number;
 } | null>(null);

 private onStorage = (e: StorageEvent) => {
 if (e.key !== 'xicompanion.selent') return;
 const v = Number(localStorage.getItem('xicompanion.selent'));
 this.sel.value = Number.isFinite(v) && v > 0 ? v : null;
 };

 onInit() {
 void this.api.refreshMap();
 this.resolveImage();
 window.addEventListener('storage', this.onStorage);
 }

 onDestroy() {
 window.clearTimeout(this.scanTimer);
 window.removeEventListener('storage', this.onStorage);
 }

 /** zone/map image — user PNG or client DAT decoded in-page; a null
 * result keeps the radar on the grid fallback */
 private resolveImage() {
 const s = this.api.map.value;
 const key = s?.z != null && s.m != null ? `${s.z}_${s.m}` : '';
 if (!s || !key || key === this.imgFor) return;
 this.imgFor = key;
 this.pan.value = null; // new zone/map — drop any stale drag center
 this.sel.value = null;
 void resolveMapImage(this.api.mapImgUrl(s.z!, s.m!), key).then((url) => {
 if (this.imgFor === key) {
 this.mapImg.value = url;
 // failed fetches used to latch imgFor forever — unlatch so the
 // next map event retries (resolveMapImage still rate-limits)
 if (!url) this.imgFor = '';
 }
 });
 }

 private scan() {
 this.scanning.value = true;
 void this.api.mapScan().catch(() => undefined);
 this.scanTimer = window.setTimeout(
 () => (this.scanning.value = false),
 2000,
 );
 }

 private mapPointerDown = (e: PointerEvent) => {
 if (e.button !== 0) return;
 const s = this.api.map.value;
 const r = radiusFor(this.zoom.value, s?.ms ?? 512);
 if (!r || !s?.me) return; // whole-map fit: nothing to pan
 const c = this.pan.value ?? s.me;
 this.drag.value = { px: e.clientX, py: e.clientY, cx: c.x, cy: c.y, r };
 (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
 };

 private mapPointerMove = (e: PointerEvent) => {
 const d = this.drag.value;
 if (!d) return;
 const el = e.currentTarget as HTMLElement;
 // the square viewBox letterboxes inside the box, so the smaller
 // side owns the screen-px -> map-px scale
 const side = Math.min(el.clientWidth, el.clientHeight) || 1;
 const u = (d.r * 2) / side;
 const ms = this.api.map.value?.ms ?? 512;
 this.pan.value = {
 x: Math.min(ms, Math.max(0, d.cx - (e.clientX - d.px) * u)),
 y: Math.min(ms, Math.max(0, d.cy - (e.clientY - d.py) * u)),
 };
 };

 private mapPointerUp = () => {
 this.drag.value = null;
 };

 // persisted so the /minimap window hides the same kinds
 private hiddenKinds = signal<ReadonlySet<string>>(loadHidden());

 // name-sorted so rows hold still — distance order reshuffled the
 // list on every scan as mobs moved; the mob-array index breaks
 // same-name ties deterministically
 private ents = computed(() =>
 [...(this.api.map.value?.e ?? [])]
 .filter((e) => !this.hiddenKinds.value.has(entKind(e)))
 .sort(
 (a, b) =>
 (a.n ?? '').localeCompare(b.n ?? '') ||
 (a.i ?? 0) - (b.i ?? 0),
 ),
 );

 // kinds present in the feed right now, in display order — the chips
 // only offer filters that would actually change the list
 private kinds = computed(() => {
 const seen = new Set<string>();
 for (const e of this.api.map.value?.e ?? []) seen.add(entKind(e));
 return KIND_ORDER.filter((k) => seen.has(k));
 });

 private toggleKind(k: string) {
 const next = new Set(this.hiddenKinds.value);
 if (next.has(k)) next.delete(k);
 else next.add(k);
 this.hiddenKinds.value = next;
 saveHidden(next);
 }

 // POI marker kinds present on this map + which are hidden — the chips
 // sit under the entity filters in the sidebar
 private hiddenPoi = signal<ReadonlySet<string>>(new Set());
 private poiKinds = computed(() => {
 const seen = new Set<string>();
 for (const p of this.api.map.value?.poi ?? []) seen.add(p.k);
 return Object.keys(POI_KIND).filter((k) => seen.has(k));
 });
 private togglePoi(k: string) {
 const next = new Set(this.hiddenPoi.value);
 if (next.has(k)) next.delete(k);
 else next.add(k);
 this.hiddenPoi.value = next;
 }

 private entMenu = signal<{ name: string; x: number; y: number } | null>(
 null,
 );
 // mob-array index of the entity ringed on the radar (click a list
 // row to toggle); cleared on zone change since indices don't carry
 private sel = signal<number | null>(null);

 private tell(name: string) {
 this.entMenu.value = null;
 // hand the thread to the chat window via shared localStorage —
 // storage events reach the already-open window, the onInit read
 // covers a freshly spawned one
 localStorage.setItem('xicompanion.chat.thread', `tell:${name}`);
 if (host.inShell()) host.spawnWindow('/chat');
 else window.open('/chat', '_blank');
 }

 private inspect(name: string) {
 this.entMenu.value = null;
 void this.api
 .sendCommand(`input /check "${name}"`)
 .catch(() => undefined);
 }

 private entRow(e: MapEntity) {
 const label = entLabel(e);
 const isPlayer = entKind(e) === 'player' && !!e.n;
 const isSel = e.i != null && e.i === this.sel.value;
 return (
 <div
 class={`flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-800/60 ${
 isSel ? 'bg-slate-800/80' : ''
 }`}
 title={isPlayer ? 'click for actions' : 'click to mark on the map'}
 onClick={(ev) => {
 const next = isSel ? null : (e.i ?? null);
 this.sel.value = next;
 localStorage.setItem(
 'xicompanion.selent',
 next == null ? '' : String(next),
 );
 if (isPlayer) {
 this.entMenu.value = {
 name: e.n!,
 x: Math.min(ev.clientX, window.innerWidth - 120),
 y: Math.min(ev.clientY, window.innerHeight - 70),
 };
 }
 }}
 >
 <span class={`w-2 shrink-0 text-center ${entClass(e)}`}>●</span>
 <span class="min-w-0 flex-1 truncate text-slate-200">
 {e.n || '—'}
 </span>
 {/* damaged mob/NM (st 16) — a slim hp bar + %; full-health mobs
     show nothing so the list stays clean */}
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
 {label && (
 <span class="shrink-0 text-[9px] uppercase text-slate-500">
 {label}
 </span>
 )}
 </div>
 );
 }

 render() {
 const s = this.api.map.value;
 this.resolveImage();
 const on = !!s && s.on !== 0 && !!s.me;
 const ws = s?.ws ?? [];
 const radius = radiusFor(this.zoom.value, s?.ms ?? 512);
 return (
 <div class="flex h-full flex-col gap-3">
 <div class="flex items-center gap-3">
 <h2 class="text-sm font-semibold text-slate-200">
 {s?.zn ?? '—'}
 {!!s?.m && <span class="text-slate-500"> · map {s.m}</span>}
 </h2>
 {on && (
 <span class="text-[11px] tabular-nums text-slate-500">
 {Math.round(s!.me!.x)}, {Math.round(s!.me!.y)}
 {!!s!.pos && <span class="text-slate-400"> · {s!.pos}</span>}
 </span>
 )}
 <span class="flex-1" />
 {!!s?.wsa && (
 <span class="text-[10px] text-amber-300">
 widescan · {ws.length}
 </span>
 )}
 <button
 class="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
 title="request a widescan update (same packet the map menu sends)"
 disabled={!on || this.scanning.value}
 onClick={() => this.scan()}
 >
 <Radar size={12} />
 widescan
 </button>
 {host.inShell() && (
 <button
 class="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-200"
 title="pop out the minimap window"
 onClick={() => host.spawnWindow('/minimap')}
 >
 <ExternalLink size={13} />
 </button>
 )}
 </div>
 <div class="flex min-h-0 flex-1 gap-3">
 <div class="relative min-w-0 flex-1 overflow-hidden rounded border border-slate-800 bg-slate-950">
 <div
 class={`h-full w-full touch-none ${
 radius
 ? this.drag.value
 ? ''
 : ''
 : ''
 }`}
 onPointerDown={this.mapPointerDown}
 onPointerMove={this.mapPointerMove}
 onPointerUp={this.mapPointerUp}
 onPointerCancel={this.mapPointerUp}
 >
 <MapRadar
 s={s}
 img={this.mapImg.value}
 radius={radius}
 center={this.pan.value ?? undefined}
 poiHide={this.hiddenPoi.value}
 entHide={this.hiddenKinds.value}
 sel={this.sel.value}
 tgt={this.api.party.value?.t?.ix}
 stgt={this.api.party.value?.stx}
 iconUrl={(id) => this.api.iconUrl(id)}
 scale={0.8}
 />
 </div>
 {radius && this.pan.value && (
 <button
 class="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-900/80 text-slate-400 hover:text-slate-200"
 title="recenter on the player"
 onClick={() => (this.pan.value = null)}
 >
 <LocateFixed size={13} />
 </button>
 )}
 <input
 type="range"
 min={0}
 max={100}
 step={1}
 value={this.zoom.value}
 title="zoom"
 class="absolute inset-x-2 bottom-1 h-1.5 accent-sky-400 opacity-80 hover:opacity-100"
 onInput={(e) => {
 const v = Number(
 (e.currentTarget as HTMLInputElement).value,
 );
 this.zoom.value = v;
 saveZoom(ZOOM_KEY, v);
 if (v <= 0) this.pan.value = null;
 }}
 />
 </div>
 <PanelSidebar class="w-56">
 {this.kinds.value.length > 0 && (
 <div class="flex flex-wrap gap-1 border-b border-slate-800 p-1">
 {this.kinds.value.map((k) => {
 const off = this.hiddenKinds.value.has(k);
 return (
 <button
 class={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
 KIND_COLOR[k]
 } ${
 off
 ? 'opacity-35'
 : 'bg-slate-800/70 hover:bg-slate-700/70'
 }`}
 title={off ? `show ${k}` : `hide ${k}`}
 onClick={() => this.toggleKind(k)}
 >
 {k}
 </button>
 );
 })}
 </div>
 )}
 {this.poiKinds.value.length > 0 && (
 <div class="flex flex-wrap gap-1 border-b border-slate-800 p-1">
 {this.poiKinds.value.map((k) => {
 const off = this.hiddenPoi.value.has(k);
 const color =
 POI_KIND[k]?.color ?? '#94a3b8';
 return (
 <button
 class={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
 off
 ? 'opacity-35'
 : 'bg-slate-800/70 hover:bg-slate-700/70'
 }`}
 style={{ color }}
 title={
 off
 ? `show ${POI_KIND[k]?.label ?? k}`
 : `hide ${POI_KIND[k]?.label ?? k}`
 }
 onClick={() => this.togglePoi(k)}
 >
 <span
 class="inline-block h-1.5 w-1.5 rounded-full"
 style={{ background: color }}
 />
 {POI_KIND[k]?.label ?? k}
 </button>
 );
 })}
 </div>
 )}
 <div class="min-h-0 flex-1 overflow-y-auto p-1">
 {this.ents.value.length === 0 ? (
 <p class="px-2 py-2 text-[11px] text-slate-600">
 {(this.api.map.value?.e ?? []).length > 0
 ? 'all filtered'
 : 'nothing in range'}
 </p>
 ) : (
 this.ents.value.map((e) => this.entRow(e))
 )}
 </div>
 </PanelSidebar>
 </div>
 {this.entMenu.value && (
 <>
 <div
 class="fixed inset-0 z-40"
 onClick={() => (this.entMenu.value = null)}
 />
 <div
 class="fixed z-50 min-w-28 overflow-hidden rounded border border-slate-700 bg-slate-900 py-1 shadow-lg"
 style={{
 left: this.entMenu.value.x,
 top: this.entMenu.value.y,
 }}
 >
 <button
 class="block w-full px-3 py-1.5 text-left text-[11px] text-slate-200 hover:bg-slate-800"
 onClick={() => this.tell(this.entMenu.value!.name)}
 >
 tell — start a direct message
 </button>
 <button
 class="block w-full px-3 py-1.5 text-left text-[11px] text-slate-200 hover:bg-slate-800"
 onClick={() => this.inspect(this.entMenu.value!.name)}
 >
 inspect — /check
 </button>
 </div>
 </>
 )}
 </div>
 );
 }
}
