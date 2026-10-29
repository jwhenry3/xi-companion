// Combat meter: detached panel-mode window (/meter?window=1). Damage
// and healing totals come from the addon's 0x028 parse (party SSE's
// mt rows) — per-actor DPS is derived client-side from the session
// clock so the bars update on the ~4Hz feed cadence.
import { Component, View, inject, signal } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import { RotateCcw } from 'lucide-preact';
import { cn } from '@/lib/utils';

@Component()
export class MeterView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private tick = signal(Date.now());
  private timer = 0;
  private dmgOn = signal(true);
  private healOn = signal(true);

  onInit() {
    void this.api.refreshParty();
    this.timer = window.setInterval(() => (this.tick.value = Date.now()), 500);
  }

  onDestroy() {
    window.clearInterval(this.timer);
  }

  render() {
    void this.tick.value; // re-render on the ticker
    const s = this.api.party.value;
    const rows = s?.mt ?? [];
    // /s rate is over combat-active time — idle gaps between fights
    // don't dilute it; the header clock shows the same span
    const elapsed = Math.max(1, s?.mta ?? s?.mtt ?? 0);
    // inclusionary filters — dmg and heal are independent toggles;
    // both on shows each row's combined contribution
    const sel = { d: this.dmgOn.value, h: this.healOn.value };

    const fmt = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}m`
      : n >= 10_000 ? `${Math.round(n / 1000)}k`
      : String(n);

    // one group per enabled metric — section header carries the column
    // labels; rows sort by that metric's total
    const group = (
      k: 'd' | 'h',
      label: string,
      tc: string,
      bc: string,
    ) => {
      if (!sel[k]) return null;
      // own row pins to the top — easier to read your numbers mid-fight
      const g = rows
        .filter((r) => r[k] > 0)
        .sort((a, b) => (b.own ?? 0) - (a.own ?? 0) || b[k] - a[k]);
      if (g.length === 0) return null;
      const gtot = g.reduce((a, r) => a + r[k], 0);
      const gmax = Math.max(...g.map((r) => r[k]));
      return (
        <div class="mt-0.5">
          <span class="flex items-center gap-1.5 pb-0.5">
            <span
              class={cn(
                'w-24 text-[9px] font-bold uppercase tracking-widest',
                tc,
              )}
            >
              {label}
            </span>
            <span class="flex-1" />
            <span class="w-12 text-right text-[9px] text-slate-500">
              total
            </span>
            <span class="w-11 text-right text-[9px] text-slate-500">
              /s
            </span>
            <span class="w-9 text-right text-[9px] text-slate-500">%</span>
          </span>
          {g.map((r) => {
            const rate = r[k] / elapsed;
            const pct = gtot > 0 ? (r[k] / gtot) * 100 : 0;
            return (
              <span key={r.n} class="flex items-center gap-1.5">
                <span
                  class={cn(
                    'w-24 truncate text-[11px]',
                    r.own ? 'font-semibold text-sky-200' : 'text-slate-200',
                  )}
                  title={r.n}
                >
                  {r.n}
                </span>
                <span class="block h-2 flex-1 overflow-hidden rounded bg-slate-800/80">
                  <span
                    class={cn('block h-full', bc)}
                    style={`width:${(r[k] / gmax) * 100}%`}
                  />
                </span>
                <span
                  class={cn(
                    'w-12 shrink-0 text-right text-[10px] tabular-nums',
                    tc,
                  )}
                >
                  {fmt(r[k])}
                </span>
                <span class="w-11 shrink-0 text-right text-[10px] tabular-nums text-slate-500">
                  {Math.round(rate)}/s
                </span>
                <span class="w-9 shrink-0 text-right text-[10px] tabular-nums text-slate-500">
                  {pct.toFixed(0)}%
                </span>
              </span>
            );
          })}
        </div>
      );
    };

    const chip = (k: 'd' | 'h', label: string, on: boolean) => (
      <button
        class={cn(
          'rounded px-1.5 py-px text-[10px]',
          on
            ? k === 'd'
              ? 'bg-rose-500/40 text-rose-100'
              : 'bg-emerald-500/40 text-emerald-100'
            : 'text-slate-500 hover:bg-slate-700',
        )}
        onClick={() => {
          if (k === 'd') this.dmgOn.value = !on;
          else this.healOn.value = !on;
          // never empty — re-enable the other if both end up off
          if (!this.dmgOn.value && !this.healOn.value)
            (k === 'd' ? this.healOn : this.dmgOn).value = true;
        }}
      >
        {label}
      </button>
    );

    return (
      <div class="flex h-full flex-col gap-1 px-2 py-1.5">
        <span class="flex items-center gap-1.5">
          {chip('d', 'dmg', sel.d)}
          {chip('h', 'heal', sel.h)}
          <span class="flex-1" />
          <span class="text-[10px] tabular-nums text-slate-500">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          </span>
          <button
            class="rounded p-0.5 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
            title="reset meter"
            onClick={() => this.api.meterReset()}
          >
            <RotateCcw size={11} />
          </button>
        </span>
        {rows.length === 0 ? (
          <p class="flex-1 text-center text-xs text-slate-500">
            no actions seen yet
          </p>
        ) : (
          <div class="min-h-0 flex-1 overflow-y-auto">
            {group('d', 'dmg', 'text-rose-300', 'bg-rose-500/80')}
            {group('h', 'heal', 'text-emerald-300', 'bg-emerald-500/80')}
          </div>
        )}
      </div>
    );
  }
}
