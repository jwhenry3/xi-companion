// Minimap: detached panel-mode window (/minimap?window=1) — the MapRadar
// zoomed to a player-centered radius. A bottom slider sets the zoom:
// left = whole-zone fit, right = close radar (persists to localStorage).
// The player's grid coord ("F-10") overlays the top-left corner.
// Same `map` SSE feed as /map.
import { Component, View, inject, signal } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { MapRadar } from './map-radar';
import { resolveMapImage } from './map-image';
import {
  radiusFor,
  loadZoom,
  saveZoom,
  loadHidden,
  HIDE_KEY,
} from './map-zoom';

const ZOOM_KEY = 'xicompanion.minimap.zoom';
const SEL_KEY = 'xicompanion.selent';

@Component()
export class MinimapView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private zoom = signal(loadZoom(ZOOM_KEY, 50)); // slider %
  private mapImg = signal<string | null>(null);
  private imgFor = '';
  private pollTimer?: ReturnType<typeof setInterval>;
  // entity kinds hidden on the map page — the chips live there; this
  // view mirrors them via localStorage
  private hiddenKinds = signal<ReadonlySet<string>>(loadHidden());
  // entity the /entities window (or /map list) last picked — pulses on
  // the radar via MapRadar's sel ring; shared through localStorage
  private sel = signal<number | null>(null);
  private onStorage = (e: StorageEvent) => {
    if (e.key === HIDE_KEY) this.hiddenKinds.value = loadHidden();
    if (e.key === SEL_KEY) {
      const v = Number(localStorage.getItem(SEL_KEY));
      this.sel.value = Number.isFinite(v) && v > 0 ? v : null;
    }
  };

  onInit() {
    void this.api.refreshMap();
    this.resolveImage();
    window.addEventListener('storage', this.onStorage);
    // the window can spawn before the addon serves map state, or the img
    // fetch can fail — imgFor stays latched either way and nothing ever
    // retries for that zone, so poll until a real map image is up
    this.pollTimer = setInterval(() => {
      if (!this.api.connected.value) return;
      if (!this.api.map.value) {
        void this.api.refreshMap().catch(() => {});
        return;
      }
      if (this.mapImg.value == null) {
        this.imgFor = ''; // unlatch the failed/absent attempt
        this.resolveImage();
      }
    }, 10_000);
  }

  onDestroy() {
    clearInterval(this.pollTimer);
    window.removeEventListener('storage', this.onStorage);
  }

  private resolveImage() {
    const s = this.api.map.value;
    const key = s?.z != null && s.m != null ? `${s.z}_${s.m}` : '';
    if (!s || !key || key === this.imgFor) return;
    this.imgFor = key;
    void resolveMapImage(this.api.mapImgUrl(s.z!, s.m!), key).then((url) => {
      if (this.imgFor === key) this.mapImg.value = url;
    });
  }

  render() {
    const s = this.api.map.value;
    this.resolveImage();
    const radius = radiusFor(this.zoom.value, s?.ms ?? 512);
    return (
      <div class="relative h-full w-full">
        <MapRadar
          s={s}
          radius={radius}
          img={this.mapImg.value}
          entHide={this.hiddenKinds.value}
          sel={this.sel.value}
          tgt={this.api.party.value?.t?.i}
          iconUrl={(id) => this.api.iconUrl(id)}
          scale={1.2}
        />
        {!!s?.pos && (
          <span class="absolute left-1 top-1 rounded bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums leading-none text-slate-200">
            {s.pos}
          </span>
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
            const v = Number((e.currentTarget as HTMLInputElement).value);
            this.zoom.value = v;
            saveZoom(ZOOM_KEY, v);
          }}
        />
      </div>
    );
  }
}
