// Cooldowns: detached fab-layer window (/cooldowns?window=1) listing
// active ability/spell recasts — name, live countdown, and a bar that
// fills toward 100% as the timer ends. Fed by the addon's `recasts`
// SSE signal (/api/recasts); each payload is stamped on arrival and
// counted down locally on a 100ms tick so bars move smoothly between
// the addon's ~0.4s broadcasts. Open from the tracker footer or
// //xicompanion cooldowns.
import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import type { RecastEntry } from '../core/types';
import { cn } from '@/lib/utils';

function fmtCd(secs: number): string {
  if (secs <= 0) return 'ready';
  const s = Math.ceil(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

@Component()
export class CooldownsView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private now = signal(Date.now());
  private timer = 0;

  onInit() {
    void this.api.refreshRecasts();
    // recast `r` is seconds-at-snapshot — count it down locally so the
    // bars move smoothly between the addon's ~0.4s SSE updates
    this.timer = window.setInterval(() => (this.now.value = Date.now()), 100);
  }

  onDestroy() {
    window.clearInterval(this.timer);
  }

  /** ability/spell cooldowns — bar fills toward 100% as the timer ends */
  private cooldowns = computed(() => {
    const s = this.api.recasts.value;
    if (!s || !Array.isArray(s.list)) return [];
    const elapsed = (this.now.value - s.at) / 1000;
    return s.list
      .map((e) => {
        const left = Math.max(0, e.r - elapsed);
        const max = Math.max(e.m, e.r, 0.001);
        return { e, left, fill: Math.min(1, Math.max(0, 1 - left / max)) };
      })
      .filter((r) => r.left > 0);
  });

  private row(e: RecastEntry, left: number, fill: number) {
    return (
      <span
        key={e.k}
        class="flex items-center gap-1.5 rounded px-2 py-0.5"
      >
        <span class="w-24 shrink-0 truncate text-xs text-slate-100">
          {e.n}
        </span>
        <span class="block h-2 flex-1 overflow-hidden rounded bg-slate-800/80">
          <span
            class={cn(
              'block h-full',
              e.t === 'a' ? 'bg-amber-400/80' : 'bg-sky-400/80',
            )}
            style={`width:${fill * 100}%`}
          />
        </span>
        <span class="w-9 shrink-0 text-right text-[10px] tabular-nums text-slate-300">
          {fmtCd(left)}
        </span>
      </span>
    );
  }

  render() {
    const cds = this.cooldowns.value;
    if (cds.length === 0) {
      return (
        <div class="flex h-full items-center justify-center">
          <p class="px-2 py-1 text-[11px] text-slate-400">
            no active cooldowns
          </p>
        </div>
      );
    }
    return (
      <div class="h-full space-y-0.5 overflow-y-auto overflow-x-hidden p-1">
        {cds.map((r) => this.row(r.e, r.left, r.fill))}
      </div>
    );
  }
}
