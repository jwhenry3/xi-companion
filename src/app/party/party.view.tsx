// Party list: detached panel-mode window (/party?window=1) — each
// member's FFXIV-style job tile + level, name, leader marker,
// HP/MP/TP bars, and status effects.
// Alliance sections appear only when they have members. Fed live by
// the `party` SSE event; snapshot on boot via /api/party.
import { Component, View, inject } from '@preact-mvc/core';
import type { OnInit } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import type { PartyMember } from '../core/types';
import { cn } from '@/lib/utils';

function barClass(v: number) {
  if (v <= 25) return 'bg-rose-500';
  if (v <= 50) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function Meter(props: { v: number; cls: string; text?: string }) {
  const v = Math.max(0, Math.min(100, props.v));
  return (
    <span class="flex flex-col gap-px">
      <span class="relative block h-1.5 overflow-hidden rounded border border-slate-500/60 bg-slate-800/80">
        <span
          class={cn('block h-full rounded', props.cls)}
          style={`width:${v}%`}
        />
      </span>
      {props.text && (
        <span class="text-[11px] font-medium tabular-nums leading-tight text-slate-200">
          {props.text}
        </span>
      )}
    </span>
  );
}

// "1234/1500" like the native party frames; falls back to just the
// current value when the max can't be derived
function curMax(cur?: number, max?: number): string {
  if (cur == null) return '';
  return max != null && max > 0 ? `${cur}/${max}` : `${cur}`;
}

// FFXIV-style job tile: the abbrev stands in for the class icon, tinted
// by role (tank blue / healer green / dps red)
const JOB_STYLE: Record<string, string> = {
  PLD: 'border-sky-500/50 text-sky-300',
  RUN: 'border-sky-500/50 text-sky-300',
  WHM: 'border-emerald-500/50 text-emerald-300',
  SCH: 'border-emerald-500/50 text-emerald-300',
};
const jobStyle = (j?: string) =>
  (j && JOB_STYLE[j]) ?? 'border-rose-500/40 text-rose-300/90';

const TRUST_ROLE: Record<string, string> = {
  TNK: 'Tank', HLR: 'Healer', RNG: 'Ranged', CST: 'Caster',
  SUP: 'Support', DD: 'Damage dealer',
};
const trustStyle = () => 'border-violet-500/50 text-violet-300';

const jobTitle = (m: PartyMember) =>
  m.tr
    ? `${TRUST_ROLE[m.tr] ?? m.tr} (Trust)`
    : [m.j && `${m.j}${m.jl != null ? ` ${m.jl}` : ''}`,
       m.sj && `${m.sj}${m.sjl != null ? ` ${m.sjl}` : ''}`]
        .filter(Boolean)
        .join(' / ');

@Component()
export class PartyView extends View implements OnInit {
  private api = inject(AddonApi);

  onInit() {
    void this.api.refreshParty();
  }

  private memberRow(m: PartyMember, ph: string) {
    const dim = m.o === 1;
    const sel =
      !!m.n && this.api.party.value?.t?.n === m.n;
    return (
      <div
        class={cn(
          'flex cursor-pointer gap-1.5 rounded px-1.5 py-1 hover:bg-slate-800/60',
          dim && 'opacity-45',
          sel && 'bg-sky-800/40 hover:bg-sky-800/50',
        )}
        title={sel ? `${m.n} (targeted)` : `target ${m.n}`}
        onClick={() =>
          void this.api.sendCommand(`input /target <${ph}>`)
        }
      >
        {/* FFXIV-style job tile — main job+level on top, sub below
            (RDM75 / BLU37); the fixed slot keeps rows aligned while a
            member's job packet hasn't arrived yet. Trusts get just the
            role tag — they have no job packets. */}
        <span
          class={cn(
            'mt-px flex h-9 w-10 shrink-0 flex-col items-center justify-center rounded-[3px] border bg-slate-800/60 font-bold leading-none tracking-tight',
            m.tr ? trustStyle() : m.j ? jobStyle(m.j) : 'border-transparent',
          )}
          title={jobTitle(m) || undefined}
        >
          {m.tr ? (
            <span class="text-[10px]">{m.tr}</span>
          ) : (
            <>
              <span class="text-[10px]">
                {m.j ?? ''}
                {m.jl ?? ''}
              </span>
              {m.sj && (
                <span class="text-[9px] opacity-80">
                  {m.sj}
                  {m.sjl ?? ''}
                </span>
              )}
            </>
          )}
        </span>
        <div class="min-w-0 flex-1">
          <span class="flex items-baseline gap-1">
            {m.l === 1 && <span class="text-[9px] text-amber-300">◆</span>}
            <span class="min-w-0 flex-1 truncate text-xs font-medium text-slate-100">
              {m.n}
            </span>
            {m.th != null && (
              <span
                class="shrink-0 text-[9px] font-semibold text-amber-300/90"
                title={`Treasure Hunter +${m.th} (from job traits; gear TH not visible)`}
              >
                TH+{m.th}
              </span>
            )}
            {/* TP colored like the client's gauge: dim until WS-ready,
                teal from 1000, amber at the 3000 cap */}
            <span
              class={cn(
                'shrink-0 text-xs font-bold tabular-nums',
                m.tp != null && m.tp >= 3000
                  ? 'text-amber-400'
                  : m.tp != null && m.tp >= 1000
                    ? 'text-teal-300'
                    : 'text-slate-500',
              )}
            >
              {m.tp}
            </span>
          </span>
          <span class="mt-0.5 flex items-start gap-1">
            <span class="pt-px text-[8px] font-semibold text-rose-400/80">
              HP
            </span>
            <span class="flex-1">
              <Meter
                v={m.hp}
                cls={barClass(m.hp)}
                text={curMax(m.hc, m.hx)}
              />
            </span>
            <span class="pt-px text-[8px] font-semibold text-sky-400/80">
              MP
            </span>
            <span class="flex-1">
              <Meter v={m.mp} cls="bg-sky-500" text={curMax(m.mc, m.mx)} />
            </span>
          </span>
          {(m.b?.length ?? 0) > 0 && (
            <span class="mt-0.5 flex flex-wrap items-center gap-0.5">
              {m.b!.map((b, i) => (
                <img
                  key={i}
                  src={this.api.statusIconUrl(b.i)}
                  class="h-4 w-4 rounded-[2px]"
                  title={b.n ?? `#${b.i}`}
                  alt={b.n ?? ''}
                  loading="eager"
                  onError={(e) =>
                    ((e.target as HTMLImageElement).style.display = 'none')
                  }
                />
              ))}
            </span>
          )}
        </div>
      </div>
    );
  }

  private section(
    label: string | undefined,
    list: PartyMember[] | undefined,
    kind: 'p' | 'a1' | 'a2',
  ) {
    if (!list || list.length === 0) return null;
    // rows are contiguous from the get_party() slot list, so array
    // index == macro placeholder index (p0=self → <me>, a1[0] → <a10>)
    const ph = (i: number) =>
      kind === 'p' ? (i === 0 ? 'me' : `p${i}`) : `${kind}${i}`;
    return (
      <div class="mb-1">
        {label && (
          <p class="px-1 pb-0.5 text-[10px] font-bold tracking-widest text-slate-400/70">
            {label}
          </p>
        )}
        <div class="space-y-0.5">
          {list.map((m, i) => this.memberRow(m, ph(i)))}
        </div>
      </div>
    );
  }

  render() {
    const s = this.api.party.value;
    const empty =
      !s || s.on === 0 ||
      ((s.p?.length ?? 0) + (s.a1?.length ?? 0) + (s.a2?.length ?? 0) === 0);
    return (
      <div
        class={cn(
          'h-full overflow-y-auto overflow-x-hidden p-1',
          empty && 'flex items-center justify-center',
        )}
      >
        {empty ? (
          <p class="px-2 py-1 text-[11px] text-slate-400">
            {s && s.on !== 0 ? 'no party' : 'log in to track'}
          </p>
        ) : (
          <>
            {this.section(undefined, s!.p, 'p')}
            {this.section('Alliance', s!.a1, 'a1')}
            {this.section('Alliance 2', s!.a2, 'a2')}
          </>
        )}
      </div>
    );
  }
}
