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
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const m = Math.floor(secs / 60);
  return `${m}:${String(Math.ceil(secs - m * 60)).padStart(2, '0')}`;
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
      <div key={e.k} class="rounded px-2 py-1">
        <span class="flex items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate text-xs text-slate-100">
            {e.n}
          </span>
          <span class="shrink-0 text-[9px] tabular-nums text-slate-300">
            {fmtCd(left)}
          </span>
        </span>
        <span class="mt-0.5 block h-1.5 overflow-hidden rounded border border-slate-500/60 bg-slate-800/80">
          <span
            class={cn(
              'block h-full rounded',
              e.t === 'a' ? 'bg-amber-400/80' : 'bg-sky-400/80',
            )}
            style={`width:${fill * 100}%`}
          />
        </span>
      </div>
    );
  }

  render() {
    const cds = this.cooldowns.value;
    if (cds.length === 0) {
      return (
        <div class="flex h-full items-center justify-center">
          <p class="px-2 py-1 text-[10px] text-slate-400">
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
