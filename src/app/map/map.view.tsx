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

function entLabel(e: MapEntity): string {
  if (e.f & 1) return 'party';
  if (e.f & 2) return 'alliance';
  if (e.st === 16) return 'mob';
  if (e.f & 4 || e.st === 2) return 'npc';
  if (e.st === 1) return 'player';
  return '';
}

function entClass(e: MapEntity): string {
  if (e.f & 3) return 'text-sky-300';
  if (e.st === 16) return 'text-rose-300';
  if (e.f & 4 || e.st === 2) return 'text-emerald-300';
  if (e.st === 1) return 'text-violet-300';
  return 'text-slate-400';
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

  /** probe the addon for data/maps/<zone>_<map>.png — once per zone/map;
   *  a 404 keeps the radar on the grid fallback */
  private resolveImage() {
    const s = this.api.map.value;
    const key = s?.z != null && s.m != null ? `${s.z}_${s.m}` : '';
    if (!s || !key || key === this.imgFor) return;
    this.imgFor = key;
    const url = this.api.mapImgUrl(s.z!, s.m!);
    const probe = new Image();
    probe.onload = () => {
      if (this.imgFor === key) this.mapImg.value = url;
    };
    probe.onerror = () => {
      if (this.imgFor === key) this.mapImg.value = null;
    };
    probe.src = url;
  }

  private scan() {
    this.scanning.value = true;
    void this.api.mapScan().catch(() => undefined);
    this.scanTimer = window.setTimeout(
      () => (this.scanning.value = false),
      2000,
    );
  }

  private ents = computed(() =>
    [...(this.api.map.value?.e ?? [])].sort((a, b) => a.d - b.d),
  );

  private entRow(e: MapEntity) {
    const label = entLabel(e);
    return (
      <div class="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-800/60">
        <span class={`w-2 shrink-0 text-center ${entClass(e)}`}>●</span>
        <span class="min-w-0 flex-1 truncate text-slate-200">
          {e.n || '—'}
        </span>
        {label && (
          <span class="shrink-0 text-[9px] uppercase text-slate-500">
            {label}
          </span>
        )}
        <span class="w-10 shrink-0 text-right text-[10px] tabular-nums text-slate-400">
          {e.d.toFixed(1)}
        </span>
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
          <div class="w-56 shrink-0 overflow-y-auto rounded border border-slate-800 bg-slate-950 p-1">
            {this.ents.value.length === 0 ? (
              <p class="px-2 py-2 text-[11px] text-slate-600">
                nothing in range
              </p>
            ) : (
              this.ents.value.map((e) => this.entRow(e))
            )}
          </div>
        </div>
      </div>
    );
  }
}
