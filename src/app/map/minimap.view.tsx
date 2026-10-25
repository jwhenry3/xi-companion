// Minimap: detached panel-mode window (/minimap?window=1) — the MapRadar
// zoomed to a player-centered radius. A bottom slider sets the zoom:
// left = close radar, right = whole-zone fit. The zone name + map coords
// sit in the window's title bar via the app shell. Same `map` SSE feed
// as /map.
import { Component, View, inject, signal } from '@preact-mvc/core';
import type { OnInit } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { MapRadar } from './map-radar';
import { resolveMapImage } from './map-image';

// slider 0..100 -> map-px half-extent, exponential so the close end gets
// fine granularity; at 100 the radar switches to whole-map fit
const MIN_R = 24;
const radiusFor = (v: number, ms: number) =>
  v >= 100 ? undefined : Math.round(MIN_R * Math.pow(ms / 2 / MIN_R, v / 100));

@Component()
export class MinimapView extends View implements OnInit {
  private api = inject(AddonApi);
  private zoom = signal(50); // slider %
  private mapImg = signal<string | null>(null);
  private imgFor = '';

  onInit() {
    void this.api.refreshMap();
    this.resolveImage();
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
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={this.zoom.value}
          title="zoom"
          class="absolute inset-x-2 bottom-1 h-1.5 accent-sky-400 opacity-80 hover:opacity-100"
          onInput={(e) =>
            (this.zoom.value = Number((e.currentTarget as HTMLInputElement).value))
          }
        />
      </div>
    );
  }
}
