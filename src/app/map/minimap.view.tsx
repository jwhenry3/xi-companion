// Minimap: detached panel-mode window (/minimap?window=1) — the MapRadar
// zoomed to a player-centered radius. Click the map to cycle zoom
// (quarter-zone → half → whole); the zone name + map coords sit in the
// window's title bar via the app shell. Same `map` SSE feed as /map.
import { Component, View, inject, signal } from '@preact-mvc/core';
import type { OnInit } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { MapRadar } from './map-radar';

// zoom steps in map-px half-extent; 0 = fit the whole zone map
const ZOOMS = [48, 96, 192, 0];

@Component()
export class MinimapView extends View implements OnInit {
  private api = inject(AddonApi);
  private zoom = signal(1); // index into ZOOMS — start mid-zoom
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

  render() {
    const s = this.api.map.value;
    this.resolveImage();
    const radius = ZOOMS[this.zoom.value] || undefined;
    return (
      <div
        class="h-full w-full cursor-pointer"
        title="click to zoom"
        onClick={() => (this.zoom.value = (this.zoom.value + 1) % ZOOMS.length)}
      >
        <MapRadar s={s} radius={radius} img={this.mapImg.value} />
      </div>
    );
  }
}
