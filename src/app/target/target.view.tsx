// Target HUD: detached panel-mode window (/target?window=1) — the
// current target's name + HP bar, and a casting bar fed by 0x028
// action packets when the target is mid-cast (spell or weaponskill).
// The cast bar animates client-side toward its unix eta so the ~4Hz
// SSE cadence doesn't gate the fill rate.
import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import { Search } from 'lucide-preact';
import { cn } from '@/lib/utils';

function barClass(v: number) {
 if (v <= 25) return 'bg-rose-500';
 if (v <= 50) return 'bg-amber-500';
 return 'bg-emerald-500';
}

@Component()
export class TargetView extends View implements OnInit, OnDestroy {
 private api = inject(AddonApi);
 // 100ms ticker — the cast fill interpolates between SSE updates
 private tick = signal(Date.now());
 private timer = 0;

 onInit() {
 void this.api.refreshParty();
 this.timer = window.setInterval(() => (this.tick.value = Date.now()), 100);
 }

 onDestroy() {
 window.clearInterval(this.timer);
 }

 render() {
 const s = this.api.party.value;
 const t = s?.t;
 const empty = !t || s?.on === 0;
 const hp = t?.hpp != null ? Math.max(0, Math.min(100, t.hpp)) : null;

 // t.cast is the Lua-side match. Fallback: the tracked cast only if
 // its resolved actor name agrees with the target — anything else is
 // a foreign cast (trust/party/another mob) and must NOT render on
 // this bar even when the Lua-side match couldn't confirm it
 const top = s?.cast;
 const norm = (v?: string) => (v || '').toLowerCase().replace(/[^a-z]/g, '');
 const c = t?.cast
 ?? (top && !top.own && top.an && norm(top.an) === norm(t?.n) ? top : undefined);
 const now = this.tick.value / 1000;
 const rem = c ? Math.max(0, c.t - now) : 0;
 const pct = c && c.d > 0
 ? Math.max(0, Math.min(1, 1 - rem / c.d))
 : 0;

 return (
 <div
 class={cn(
 'flex h-full flex-col justify-start gap-1 px-2 py-1.5',
 empty && 'items-center justify-center',
 )}
 >
 {empty ? (
 <p class="text-xs text-slate-400">no target</p>
 ) : (
 <>
 <span class="flex items-baseline gap-1.5">
 {/* name matches the client's claim colors: amber
 unclaimed, emerald yours/party's, rose someone else's */}
 <span
 class={cn(
 'min-w-0 flex-1 truncate text-sm font-medium',
 t!.rel === 'self'
 ? 'text-sky-200'
 : t!.rel === 'party'
 ? 'text-emerald-300'
 : t!.rel === 'alliance'
 ? 'text-teal-300'
 : t!.rel === 'ls'
 ? 'text-blue-300'
 : t!.rel === 'pc'
 ? 'text-violet-300'
 : t!.cl === 1 || t!.cl === 2
 ? 'text-emerald-300'
 : t!.cl === 3
 ? 'text-rose-400'
 : 'text-amber-200',
 )}
 >
 {t!.n || '—'}
 </span>
 {hp != null && (
 <span class="shrink-0 text-xs tabular-nums text-slate-300">
 {hp}%
 </span>
 )}
 {t!.tp != null && (
 <span class="shrink-0 text-[11px] tabular-nums text-teal-300">
 tp {t!.tp}
 </span>
 )}
 {(t!.lv != null || t!.con) && (
 <span class="shrink-0 text-[11px] text-amber-300" title="/check result">
 {t!.lv != null ? `lv ${t.lv}` : ''}
 {t!.lv != null && t!.con ? ' · ' : ''}
 {t!.con ?? ''}
 </span>
 )}
 {t!.th != null && (
 <span class="shrink-0 text-[11px] font-semibold text-amber-300">
 TH {t!.th}
 </span>
 )}
 {t!.n && (
 <button
 class="flex shrink-0 items-center gap-1 rounded border border-slate-600/70 px-1.5 py-px text-[11px] text-slate-300 hover:border-sky-700 hover:text-sky-300"
 title={`AI summary: ffxi - ${t!.n}`}
 onClick={() =>
 host.openExternal(
 `https://www.google.com/search?q=${encodeURIComponent(`ffxi - ${t!.n}`)}`,
 )
 }
 >
 <Search size={11} />
 Look Up
 </button>
 )}
 </span>
 {hp != null && (
 <span class="block h-1.5 overflow-hidden rounded border border-slate-500/60 bg-slate-800/80">
 <span
 class={cn('block h-full rounded', barClass(hp))}
 style={`width:${hp}%`}
 />
 </span>
 )}
 {c && (
 <>
 <span class="block h-1.5 overflow-hidden rounded border border-slate-500/60 bg-slate-800/80">
 {/* fills up — the cast winds up to impact */}
 <span
 class="block h-full rounded bg-violet-400"
 style={`width:${pct * 100}%`}
 />
 </span>
 <span class="truncate text-[10px] text-violet-300">
 casting {c.n}
 </span>
 </>
 )}
 </>
 )}
 </div>
 );
 }
}
