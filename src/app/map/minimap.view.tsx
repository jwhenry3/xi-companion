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
import { radiusFor, loadZoom, saveZoom } from './map-zoom';

const ZOOM_KEY = 'xicompanion.minimap.zoom';

@Component()
export class MinimapView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private zoom = signal(loadZoom(ZOOM_KEY, 50)); // slider %
  private mapImg = signal<string | null>(null);
  private imgFor = '';
  private pollTimer?: ReturnType<typeof setInterval>;

  onInit() {
    void this.api.refreshMap();
    this.resolveImage();
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
        <MapRadar s={s} radius={radius} img={this.mapImg.value} />
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
