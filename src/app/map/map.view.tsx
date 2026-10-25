// Map page: the whole-zone radar — zone image (if one was dropped into
// the addon's data/maps/), live entity dots in render range, widescan
// diamonds while a scan is held, and a side list of what the radar sees.
// A "widescan" button re-issues the server's 0x0F4 scan request; the
// floating /minimap window renders the same feed zoomed to the player.
import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { ExternalLink, Radar } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import type { MapEntity } from '../core/types';
import { MapRadar } from './map-radar';
import { resolveMapImage } from './map-image';

function entLabel(e: MapEntity): string {
  const k = entKind(e);
  return k === 'other' ? '' : k;
}

// entity category — drives the row label, the dot color, and the
// list's type-filter chips. Grouping wins over the linkshell ring:
// an LS mate who's also in your party reads as party.
function entKind(e: MapEntity): string {
  if (e.f & 1) return 'party';
  if (e.f & 2) return 'alliance';
  if (e.f & 8) return 'linkshell';
  if (e.st === 16) return 'mob';
  if (e.f & 4 || e.st === 2) return 'npc';
  if (e.st === 1) return 'player';
  return 'other';
}

const KIND_ORDER = [
  'party',
  'alliance',
  'linkshell',
  'player',
  'npc',
  'mob',
  'other',
];
const KIND_COLOR: Record<string, string> = {
  party: 'text-sky-300',
  alliance: 'text-cyan-300',
  linkshell: 'text-orange-300',
  player: 'text-violet-300',
  npc: 'text-emerald-300',
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

  onInit() {
    void this.api.refreshMap();
    this.resolveImage();
  }

  onDestroy() {
    window.clearTimeout(this.scanTimer);
  }

  /** zone/map image — user PNG or client DAT decoded in-page; a null
   *  result keeps the radar on the grid fallback */
  private resolveImage() {
    const s = this.api.map.value;
    const key = s?.z != null && s.m != null ? `${s.z}_${s.m}` : '';
    if (!s || !key || key === this.imgFor) return;
    this.imgFor = key;
    void resolveMapImage(this.api.mapImgUrl(s.z!, s.m!), key).then((url) => {
      if (this.imgFor === key) this.mapImg.value = url;
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

  private hiddenKinds = signal<ReadonlySet<string>>(new Set());

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
  }

  private entMenu = signal<{ name: string; x: number; y: number } | null>(
    null,
  );

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
    return (
      <div
        class={`flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-800/60 ${
          isPlayer ? 'cursor-pointer' : ''
        }`}
        title={isPlayer ? 'click for actions' : undefined}
        onClick={
          isPlayer
            ? (ev) =>
                (this.entMenu.value = {
                  name: e.n!,
                  x: Math.min(ev.clientX, window.innerWidth - 120),
                  y: Math.min(ev.clientY, window.innerHeight - 70),
                })
            : undefined
        }
      >
        <span class={`w-2 shrink-0 text-center ${entClass(e)}`}>●</span>
        <span class="min-w-0 flex-1 truncate text-slate-200">
          {e.n || '—'}
        </span>
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
          <div class="min-w-0 flex-1 overflow-hidden rounded border border-slate-800 bg-slate-950">
            <MapRadar s={s} img={this.mapImg.value} />
          </div>
          <div class="flex w-56 shrink-0 flex-col rounded border border-slate-800 bg-slate-950">
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
          </div>
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
