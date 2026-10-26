// Skillchain tracker: detached panel-mode window (/skillchain?window=1).
// Live prediction from the `party` SSE feed's sc block — the addon sees
// each WS (0x028 cat-3), predicts what it chains into, and hands the
// window unix-eta timestamps; the view counts them down locally.
//
// Two columns:
//   SKILLCHAIN — live chains (window + burst bars) and, underneath,
//     weapon skills the equipped gear allows: everything when nothing
//     is in flight, or just the WSs that actually chain (with predicted
//     results) while a window is open. ▶ fires input /ws "n" <t>.
//   BURST — while a magic-burst window is live, learned spells whose
//     element matches the chain's burst elements. ▶ fires /ma "n" <t>.
import { Component, View, inject, signal, computed, effect } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { Play } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import type {
  AbilitiesPayload,
  PartyState,
  ScChain,
  SpellEntry,
} from '../core/types';
import { cn } from '@/lib/utils';

// same pair chart as the addon's SC table: SC[active].next[prop] =
// [level, result]; .el = the chain's magic-burst elements
const SC: Record<
  string,
  { el: string[]; lvl: number; next?: Record<string, [number, string]> }
> = {
  Radiance: { el: ['Fire', 'Wind', 'Lightning', 'Light'], lvl: 4 },
  Umbra: { el: ['Earth', 'Ice', 'Water', 'Dark'], lvl: 4 },
  Light: {
    el: ['Fire', 'Wind', 'Lightning', 'Light'],
    lvl: 3,
    next: { Light: [4, 'Light'] },
  },
  Darkness: {
    el: ['Earth', 'Ice', 'Water', 'Dark'],
    lvl: 3,
    next: { Darkness: [4, 'Darkness'] },
  },
  Gravitation: {
    el: ['Earth', 'Dark'],
    lvl: 2,
    next: { Distortion: [3, 'Darkness'], Fragmentation: [2, 'Fragmentation'] },
  },
  Fragmentation: {
    el: ['Wind', 'Lightning'],
    lvl: 2,
    next: { Fusion: [3, 'Light'], Distortion: [2, 'Distortion'] },
  },
  Distortion: {
    el: ['Ice', 'Water'],
    lvl: 2,
    next: { Gravitation: [3, 'Darkness'], Fusion: [2, 'Fusion'] },
  },
  Fusion: {
    el: ['Fire', 'Light'],
    lvl: 2,
    next: { Fragmentation: [3, 'Light'], Gravitation: [2, 'Gravitation'] },
  },
  Compression: {
    el: ['Darkness'],
    lvl: 1,
    next: { Transfixion: [1, 'Transfixion'], Detonation: [1, 'Detonation'] },
  },
  Liquefaction: {
    el: ['Fire'],
    lvl: 1,
    next: { Impaction: [2, 'Fusion'], Scission: [1, 'Scission'] },
  },
  Induration: {
    el: ['Ice'],
    lvl: 1,
    next: {
      Reverberation: [2, 'Fragmentation'],
      Compression: [1, 'Compression'],
      Impaction: [1, 'Impaction'],
    },
  },
  Reverberation: {
    el: ['Water'],
    lvl: 1,
    next: { Induration: [1, 'Induration'], Impaction: [1, 'Impaction'] },
  },
  Transfixion: {
    el: ['Light'],
    lvl: 1,
    next: {
      Scission: [2, 'Distortion'],
      Reverberation: [1, 'Reverberation'],
      Compression: [1, 'Compression'],
    },
  },
  Scission: {
    el: ['Earth'],
    lvl: 1,
    next: {
      Liquefaction: [1, 'Liquefaction'],
      Reverberation: [1, 'Reverberation'],
      Detonation: [1, 'Detonation'],
    },
  },
  Detonation: {
    el: ['Wind'],
    lvl: 1,
    next: { Compression: [2, 'Gravitation'], Scission: [1, 'Scission'] },
  },
  Impaction: {
    el: ['Lightning'],
    lvl: 1,
    next: { Liquefaction: [1, 'Liquefaction'], Detonation: [1, 'Detonation'] },
  },
};

/** does a WS with these props chain off the active elements? */
function scForm(elems: string[], props: string[]): [number, string] | null {
  for (const first of elems) {
    const combo = SC[first]?.next;
    for (const second of props) {
      const r = combo?.[second];
      if (r) return r;
    }
  }
  return null;
}

// chain-element → accent color (classic element palette)
const EL_COLOR: Record<string, string> = {
  Liquefaction: 'text-red-400',
  Impaction: 'text-fuchsia-400',
  Detonation: 'text-green-300',
  Scission: 'text-amber-500',
  Reverberation: 'text-blue-400',
  Induration: 'text-cyan-300',
  Transfixion: 'text-yellow-100',
  Compression: 'text-indigo-400',
  Fusion: 'text-rose-300',
  Fragmentation: 'text-purple-300',
  Gravitation: 'text-orange-400',
  Distortion: 'text-sky-400',
  Light: 'text-yellow-50',
  Radiance: 'text-yellow-50',
  Darkness: 'text-violet-300',
  Umbra: 'text-violet-300',
  Fire: 'text-red-400',
  Lightning: 'text-fuchsia-400',
  Wind: 'text-green-300',
  Earth: 'text-amber-500',
  Water: 'text-blue-400',
  Ice: 'text-cyan-300',
  Dark: 'text-indigo-400',
};
const elColor = (e: string) => EL_COLOR[e] ?? 'text-slate-300';

// burst element name → res spell element id
const EL_ID: Record<string, number> = {
  Fire: 0, Ice: 1, Wind: 2, Earth: 3, Lightning: 4, Water: 5, Light: 6, Dark: 7,
};

const LV: Record<number, string> = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };

function Bar(props: { frac: number; cls: string }) {
  return (
    <span class="block h-1 overflow-hidden rounded bg-slate-800/80">
      <span
        class={cn('block h-full rounded', props.cls)}
        style={`width:${Math.max(0, Math.min(100, props.frac * 100))}%`}
      />
    </span>
  );
}

const EXEC =
  'shrink-0 cursor-pointer rounded p-0.5 text-slate-500 hover:bg-slate-700/60 hover:text-emerald-300';

@Component()
export class SkillchainView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private now = signal(Date.now() / 1000);
  private abilities = signal<AbilitiesPayload | null>(null);
  private timer?: ReturnType<typeof setInterval>;
  private disposeJob?: () => void;
  private jobKey = '';

  onInit() {
    void this.api.refreshParty().catch(() => {});
    // countdown bars animate locally — the feed only changes on real
    // events (a new WS), not every frame
    this.timer = setInterval(() => {
      this.now.value = Date.now() / 1000;
    }, 100);
    // learned spells for the burst column — per-job like the spellbook
    this.disposeJob = effect(() => {
      const p = this.api.state.value?.player;
      const key = p ? `${p.main_job_id}/${p.sub_job_id}` : '';
      if (key !== this.jobKey) {
        this.jobKey = key;
        this.abilities.value = null;
        if (key) void this.load();
      }
    });
  }

  onDestroy() {
    clearInterval(this.timer);
    this.disposeJob?.();
  }

  private async load() {
    const p = this.api.state.value?.player;
    try {
      this.abilities.value = await this.api.fetchAbilities(
        p?.main_job_id ?? 0,
        p?.sub_job_id ?? 0,
      );
    } catch {
      this.abilities.value = { on: 0 };
    }
  }

  private exec(kind: 'ws' | 'ma', name: string) {
    void this.api.sendCommand(`input /${kind} "${name}" <t>`);
  }

  /** usable WS rows: predicted result when a window is open, else roots */
  private wsRows(chains: ScChain[]) {
    const ws = (this.api.party.value?.sc?.ws ?? []).map((w) => ({
      ...w,
      // the WS chains if any live window accepts one of its props;
      // show the best predicted result across open chains
      hit: chains
        .filter((c) => this.now.value >= c.o && this.now.value <= c.c)
        .map((c) => scForm(c.e, w.p))
        .find((r) => r != null) as [number, string] | undefined,
    }));
    const anyWindow = chains.some(
      (c) => this.now.value >= c.o && this.now.value <= c.c,
    );
    // open window → chain-capable first by level; closed → all roots
    const rows = anyWindow
      ? [...ws].sort(
          (a, b) =>
            (b.hit?.[0] ?? 0) - (a.hit?.[0] ?? 0) || a.n.localeCompare(b.n),
        )
      : ws;
    return rows.map((w) => (
      <button
        key={w.i}
        class={cn(
          'flex w-full cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-slate-800',
          anyWindow && !w.hit && 'opacity-40',
        )}
        title={`input /ws "${w.n}" <t>`}
        onClick={() => this.exec('ws', w.n)}
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs leading-tight text-slate-200">
            {w.n}
          </span>
          <span
            class={cn(
              'block truncate text-[10px] leading-tight',
              w.hit ? cn('font-medium', elColor(w.hit[1])) : 'text-slate-500',
            )}
          >
            {w.hit
              ? `→ ${w.hit[1]}${w.hit[0] > 1 ? ` Lv${LV[w.hit[0]] ?? w.hit[0]}` : ''}`
              : w.p.slice(0, 2).join(' / ')}
          </span>
        </span>
        <Play size={13} class="shrink-0 text-slate-500" />
      </button>
    ));
  }

  /** learned spells whose element is in the live burst set */
  private burstSpells = computed<SpellEntry[]>(() => {
    const now = this.now.value;
    const burst = new Set<number>();
    for (const c of this.api.party.value?.sc?.c ?? []) {
      if (c.b != null && now <= c.b) {
        for (const e of SC[c.e[0] ?? '']?.el ?? []) {
          const id = EL_ID[e];
          if (id != null) burst.add(id);
        }
      }
    }
    if (burst.size === 0) return [];
    return (this.abilities.value?.spells ?? [])
      .filter(
        (s) =>
          s.l === 1 &&
          s.el != null &&
          burst.has(s.el) &&
          s.ty !== 'Trust' &&
          s.ty !== 'SummonerPact',
      )
      .sort(
        (a, b) => a.el! - b.el! || (a.mp ?? 0) - (b.mp ?? 0) || a.n.localeCompare(b.n),
      );
  });

  private chain(c: ScChain) {
    const now = this.now.value;
    const waiting = now < c.o;
    const chainLeft = Math.max(0, c.c - now);
    const chainFrac =
      c.c > c.o ? Math.max(0, (c.c - Math.max(now, c.o)) / (c.c - c.o)) : 0;
    const burstLeft = c.b != null ? Math.max(0, c.b - now) : 0;
    const burstDur = c.b != null ? Math.max(0.001, c.b - c.t) : 1;
    return (
      <div key={`${c.n}${c.t}`} class="rounded bg-slate-800/40 px-2 py-1">
        <span class="flex items-baseline gap-1.5">
          <span
            class={cn(
              'min-w-0 flex-1 truncate text-xs font-semibold',
              c.lv > 0 ? elColor(c.e[0] ?? '') : 'text-slate-200',
            )}
          >
            {c.lv > 0 ? c.n : c.w ?? c.n}
          </span>
          {c.lv > 0 && (
            <span class="shrink-0 text-[9px] font-bold tracking-wider text-amber-300">
              Lv{LV[c.lv] ?? c.lv}
            </span>
          )}
          <span class="shrink-0 truncate text-[9px] text-slate-500">
            {[c.an, c.tg].filter(Boolean).join(' → ')}
          </span>
        </span>
        <span class="mt-0.5 flex items-center gap-1 text-[10px]">
          {c.e.map((e) => (
            <span key={e} class={cn('font-medium', elColor(e))}>
              {e}
            </span>
          ))}
          {c.lv === 0 && (
            <span class="text-slate-500">— waiting to chain</span>
          )}
        </span>
        <span class="mt-1 block">
          {chainLeft > 0 ? (
            <span class="block">
              <Bar
                frac={chainFrac}
                cls={waiting ? 'bg-slate-600' : 'bg-sky-400/80'}
              />
              <span class="text-[10px] tabular-nums text-slate-400">
                {waiting
                  ? `chain opens in ${(c.o - now).toFixed(1)}s`
                  : `chain window ${chainLeft.toFixed(1)}s`}
              </span>
            </span>
          ) : (
            <span class="text-[10px] text-slate-600">window closed</span>
          )}
          {burstLeft > 0 && (
            <span class="mt-0.5 block">
              <Bar frac={burstLeft / burstDur} cls="bg-fuchsia-400/80" />
              <span class="text-[10px] tabular-nums text-fuchsia-300">
                magic burst {burstLeft.toFixed(1)}s
              </span>
            </span>
          )}
        </span>
      </div>
    );
  }

  render() {
    const s = this.api.party.value as PartyState | null;
    const chains = (s?.sc?.c ?? [])
      .slice()
      .sort((a, b) => b.t - a.t);
    const now = this.now.value;
    const bursting = chains.some((c) => c.b != null && now <= c.b);
    const spells = this.burstSpells.value;
    const empty = !s || s.on === 0;
    return (
      <div
        class={cn(
          'h-full overflow-y-auto overflow-x-hidden p-1',
          empty && 'flex items-center justify-center',
        )}
      >
        {empty ? (
          <p class="px-2 py-1 text-[10px] text-slate-400">
            {s && s.on !== 0 ? 'use a weapon skill' : 'log in to track'}
          </p>
        ) : (
          <div class="flex gap-2">
            {/* status: executed openers + the live chain/MB window —
                both reserved so the columns below stay put */}
            <div class="min-w-0 flex-1">
              <p class="px-1 pb-0.5 text-[10px] font-bold tracking-widest text-slate-400/70">
                OPENERS
              </p>
              <div class="mb-1 min-h-9 space-y-px">
                {chains.map((c) => (
                  <p key={`op${c.n}${c.t}`} class="px-1 leading-tight">
                    <span class="block truncate text-xs text-slate-200">
                      {c.w ?? c.n}
                    </span>
                    <span class="block truncate text-[10px] text-slate-500">
                      {c.an}
                      {c.e.map((e) => (
                        <span
                          key={e}
                          class={cn('font-medium', elColor(e))}
                        >
                          {` ${e}`}
                        </span>
                      ))}
                    </span>
                  </p>
                ))}
                {chains.length === 0 && (
                  <p class="px-1 pt-1.5 text-[10px] text-slate-600">
                    none — land a weapon skill
                  </p>
                )}
              </div>
              <p class="px-1 pb-0.5 text-[10px] font-bold tracking-widest text-slate-400/70">
                ACTIVE CHAIN
              </p>
              <div class="min-h-14 space-y-1">
                {chains.map((c) => this.chain(c))}
                {chains.length === 0 && (
                  <p class="px-1 pt-2 text-[10px] text-slate-600">
                    none — land a weapon skill
                  </p>
                )}
              </div>
            </div>
            <div class="w-px shrink-0 bg-slate-700/40" />
            <div class="min-w-0 flex-1">
              <p class="px-1 pb-0.5 text-[10px] font-bold tracking-widest text-slate-400/70">
                {chains.length > 0 ? 'NEXT WS' : 'WEAPON SKILLS'}
              </p>
              {this.wsRows(chains)}
            </div>
            <div class="w-px shrink-0 bg-slate-700/40" />
            <div class="min-w-0 flex-1">
              <p class="px-1 pb-0.5 text-[10px] font-bold tracking-widest text-slate-400/70">
                MAGIC BURST
              </p>
              {bursting ? (
                spells.length > 0 ? (
                  spells.map((sp) => (
                    <button
                      key={sp.id}
                      class="flex w-full cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-slate-800"
                      title={`input /ma "${sp.n}" <t>`}
                      onClick={() => this.exec('ma', sp.n)}
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-xs leading-tight text-slate-200">
                          {sp.n}
                        </span>
                        <span class="block truncate text-[10px] leading-tight text-slate-500">
                          {sp.mp != null && sp.mp > 0 ? `${sp.mp} mp` : ''}
                          {sp.ct != null && sp.ct > 0 ? ` · ${sp.ct}s` : ''}
                        </span>
                      </span>
                      <Play size={13} class="shrink-0 text-slate-500" />
                    </button>
                  ))
                ) : (
                  <p class="px-1 text-[10px] text-slate-500">
                    no learned spells match the burst elements
                  </p>
                )
              ) : (
                <p class="px-1 text-[10px] text-slate-500">
                  complete a skillchain to open a burst window
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
}
