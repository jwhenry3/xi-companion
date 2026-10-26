// Abilities: the /abilities skill+spell book — every JA/WS/spell the
// current job can learn vs. has learned, laid out like the journal:
// a bordered sidebar with section headers + category rows, a slim
// header (group title, search, learned filter, target chips), and a
// detail pane on the right for the selected row. Click a row to open
// the detail — it carries the canonical macro line (wiki infobox cmd
// for JAs), a copy button, and a use-with-<target> action; the ▶ on
// learned rows fires the same line directly
// (`input <prefix> "name" <target>`); the target chips switch
// <t>/<st>/<stpc>/<stnpc>/<me> — <st> opens the client's own subtarget
// cursor. Live recast state joins the `recasts` SSE feed (JA 'a<rid>',
// spell 's<id>').
import { Component, View, inject, signal, computed, effect } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { Copy, Play, Check, UserMinus } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import { Dropdown } from '../core/dropdown';
import type {
  AbilitiesPayload,
  AbilityEntry,
  SpellEntry,
} from '../core/types';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type Row = AbilityEntry | SpellEntry;

const TARGETS = ['<t>', '<st>', '<stpc>', '<stnpc>', '<me>'] as const;
const TARGET_KEY = 'xicompanion.abilities.target';
const LEARNED_KEY = 'xicompanion.abilities.learned';
const loadTarget = () =>
  (TARGETS as readonly string[]).includes(
    localStorage.getItem(TARGET_KEY) ?? '',
  )
    ? (localStorage.getItem(TARGET_KEY) as (typeof TARGETS)[number])
    : '<t>';
// learned-only is the default view — obtainable entries are opt-in
const loadLearned = () =>
  localStorage.getItem(LEARNED_KEY) !== '0';

// short aliases for the derived command line — the wiki cmd field is
// preferred when present (it carries the semantically right target)
const PREFIX_ALIAS: Record<string, string> = {
  '/jobability': '/ja',
  '/magic': '/ma',
  '/weaponskill': '/ws',
  '/ninjutsu': '/nin',
  '/song': '/so',
  '/pet': '/pet',
};

// sidebar categories: spells by magic family, JAs by acquisition type.
// Only categories present in the payload are listed.
const SPELL_CAT: Record<string, string> = {
  WhiteMagic: 'White',
  BlackMagic: 'Black',
  BlueMagic: 'Blue',
  Ninjutsu: 'Ninjutsu',
  BardSong: 'Songs',
  Geomancy: 'Geomancy',
  SummonerPact: 'Summoning',
  Trust: 'Trust',
};
const CAT_ORDER = [
  'White', 'Black', 'Blue', 'Ninjutsu', 'Songs', 'Geomancy',
  'Summoning', 'Trust', 'Other',
  'Job Abilities', 'SP Abilities', 'Merit', 'Weapon Skills',
];

function catFor(e: Row): string {
  if (e.k === 'sp') {
    return SPELL_CAT[(e as SpellEntry).ty ?? ''] ?? 'Other';
  }
  if (e.k === 'ws') return 'Weapon Skills';
  const ty = (e as AbilityEntry).ty ?? 'Level';
  if (ty === 'Level') return 'Job Abilities';
  if (ty === 'Merit') return 'Merit';
  if (ty === 'SP Ability') return 'SP Abilities';
  return ty;
}

function commandFor(e: Row, target: string): string {
  if ('cmd' in e && e.cmd) return e.cmd;
  const pfx = PREFIX_ALIAS[e.pfx] ?? e.pfx;
  return `${pfx} "${e.n}" ${target}`;
}

function fmtSecs(secs?: number): string {
  if (!secs || secs <= 0) return '';
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const m = Math.floor(secs / 60);
  return `${m}m${secs - m * 60 > 0 ? `${Math.round(secs - m * 60)}s` : ''}`;
}

function iconUrl(api: AddonApi, e: Row): string | null {
  const sp = e as SpellEntry;
  if (sp.iic != null) return api.iconUrl(sp.iic);
  if (e.mic != null)
    return e.k === 'ws' ? api.wsIconUrl(e.mic) : api.menuIconUrl(e.mic);
  return e.ic != null ? api.statusIconUrl(e.ic) : null;
}

// FFXI element tile colors — the menu renders spell/ability icons on a
// solid colored background keyed by element (0-7)
const EL_BG: Record<number, string> = {
  0: '#8f2d2d', // fire
  1: '#2d4f8f', // ice
  2: '#2d8f43', // wind
  3: '#8f7a2d', // earth
  4: '#5d2d8f', // thunder
  5: '#2d7a8f', // water
  6: '#8f8f6a', // light
  7: '#5a3a6e', // dark
};
const elBg = (e: Row): string | undefined =>
  (e as SpellEntry).el != null ? EL_BG[(e as SpellEntry).el as number] : undefined;

/** recast feed key — 'a<recast_id>' for JAs, 's<spell id>' for spells */
function recastKey(e: Row): string | null {
  if (e.k === 'ja' && 'rid' in e && e.rid != null) return `a${e.rid}`;
  if (e.k === 'sp') return `s${e.id}`;
  return null;
}

function meta(e: Row): string {
  const parts: string[] = [];
  if (e.k === 'sp') {
    const s = e as SpellEntry;
    if (s.ty) parts.push(s.ty.replace(/([a-z])([A-Z])/g, '$1 $2'));
    if (s.mp) parts.push(`${s.mp} MP`);
    if (s.ct) parts.push(`${s.ct}s cast`);
    if (s.rc) parts.push(`${fmtSecs(s.rc)} recast`);
  } else {
    const a = e as AbilityEntry;
    if (a.k === 'ws') parts.push('weapon skill');
    else parts.push(a.ty && a.ty !== 'Level' ? a.ty : 'job ability');
    if (a.mp) parts.push(`${a.mp} MP`);
    if (a.tp) parts.push(`${a.tp} TP`);
    if (a.dur) parts.push(`${fmtSecs(a.dur)}`);
  }
  if (e.rg) parts.push(`rng ${e.rg}`);
  return parts.join(' · ');
}

@Component()
export class AbilitiesView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private tab = signal<'spells' | 'abilities'>('spells');
  private cat = signal('all');
  private query = signal('');
  private learnedOnly = signal(loadLearned());
  private target = signal(loadTarget());
  private info = signal<string | null>(null);
  private copied = signal<string | null>(null);
  private data = signal<AbilitiesPayload | null>(null);
  private disposeJob: (() => void) | null = null;
  private jobKey = '';

  onInit() {
    // refetch when the job ids change — obtainable/learned sets are
    // per-job, and the query cache is keyed on them anyway
    this.disposeJob = effect(() => {
      const p = this.api.state.value?.player;
      const key = p ? `${p.main_job_id}/${p.sub_job_id}` : '';
      if (key !== this.jobKey) {
        this.jobKey = key;
        this.data.value = null;
        if (key) this.load();
      }
    });
    if (!this.jobKey) this.load();
    // fresh party snapshot so summoned-trust rows show release on open
    void this.api.refreshParty().catch(() => {});
  }

  onDestroy() {
    this.disposeJob?.();
  }

  private async load() {
    const p = this.api.state.value?.player;
    try {
      this.data.value = await this.api.fetchAbilities(
        p?.main_job_id ?? 0,
        p?.sub_job_id ?? 0,
      );
    } catch {
      this.data.value = { on: 0 };
    }
  }

  private list = computed(() => {
    const d = this.data.value;
    return this.tab.value === 'spells'
      ? (d?.spells ?? [])
      : (d?.abilities ?? []);
  });

  // categories present in a tab, in canonical order then alpha —
  // the sidebar lists them under its SPELLS/ABILITIES section headers
  private catsFor(tab: 'spells' | 'abilities'): string[] {
    const d = this.data.value;
    const list = tab === 'spells' ? (d?.spells ?? []) : (d?.abilities ?? []);
    const counts = new Map<string, number>();
    for (const e of list) {
      const c = catFor(e);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.keys()].sort(
      (a, b) =>
        (CAT_ORDER.indexOf(a) === -1 ? 99 : CAT_ORDER.indexOf(a)) -
          (CAT_ORDER.indexOf(b) === -1 ? 99 : CAT_ORDER.indexOf(b)) ||
        a.localeCompare(b),
    );
  }

  private rows = computed(() => {
    const q = this.query.value.trim().toLowerCase();
    const cat = this.cat.value;
    const learnedOnly = this.learnedOnly.value;
    const rows = this.list.value.filter(
      (e) =>
        (cat === 'all' || catFor(e) === cat) &&
        (!learnedOnly || e.l) &&
        (!q || e.n.toLowerCase().includes(q)),
    );
    if (cat === 'all') {
      // all: grouped by category (canonical order) then alphabetical
      const rank = (e: Row) => {
        const i = CAT_ORDER.indexOf(catFor(e));
        return i === -1 ? 99 : i;
      };
      rows.sort((a, b) => rank(a) - rank(b) || a.n.localeCompare(b.n));
    }
    return rows;
  });

  // sidebar hint — 'learned/total' rows each category would show
  private catStats = (tab: 'spells' | 'abilities', c: string) => {
    const d = this.data.value;
    const list = tab === 'spells' ? (d?.spells ?? []) : (d?.abilities ?? []);
    const inCat = c === 'all' ? list : list.filter((e) => catFor(e) === c);
    return `${inCat.filter((e) => e.l).length}/${inCat.length}`;
  };

  // live recast lookup from the SSE cooldown feed
  private recastLeft = computed(() => {
    const s = this.api.recasts.value;
    const map = new Map<string, number>();
    if (s?.list) {
      const elapsed = (Date.now() - s.at) / 1000;
      for (const r of s.list) map.set(r.k, Math.max(0, r.r - elapsed));
    }
    return map;
  });

  // summoned trusts — party members flagged `tr` (party.lua detects
  // Trusts by party_name). The release command needs the member's
  // display name, which can differ from the spell's `n` (e.g. party_name
  // overrides) — so keep the matched name, not the spell's.
  private summonedTrust(e: Row): string | null {
    if (e.k !== 'sp' || (e as SpellEntry).ty !== 'Trust') return null;
    const want = [e.n, (e as SpellEntry).pn]
      .filter((v): v is string => !!v)
      .map((v) => v.toLowerCase());
    for (const m of this.api.party.value?.p ?? []) {
      if (m.tr && m.n && want.includes(m.n.toLowerCase())) return m.n;
    }
    return null;
  }

  private release(name: string) {
    void this.api.sendCommand(`input /returntrust "${name}"`);
  }

  private trigger(e: Row) {
    if (!e.l) return;
    void this.api.sendCommand(`input ${e.pfx} "${e.n}" ${this.target.value}`);
  }

  private copy(text: string, key: string) {
    void navigator.clipboard?.writeText(text).then(
      () => {
        this.copied.value = key;
        setTimeout(() => {
          if (this.copied.value === key) this.copied.value = null;
        }, 1200);
      },
      () => undefined,
    );
  }

  private setTarget(t: (typeof TARGETS)[number]) {
    this.target.value = t;
    localStorage.setItem(TARGET_KEY, t);
  }

  // sidebar category row — label + learned/total hint, like the
  // journal's groupRow
  private catRow(tab: 'spells' | 'abilities', c: string, label: string) {
    const active = this.tab.value === tab && this.cat.value === c;
    return (
      <button
        key={`${tab}:${c}`}
        class={cn(
          'flex w-full items-center gap-2 rounded px-2 py-1 text-left',
          active
            ? 'bg-slate-800 text-slate-100'
            : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
        )}
        onClick={() => {
          this.tab.value = tab;
          this.cat.value = c;
        }}
      >
        <span class="min-w-0 flex-1 truncate text-sm">{label}</span>
        <span class="shrink-0 text-[10px] text-slate-500">
          {this.catStats(tab, c)}
        </span>
      </button>
    );
  }

  private row(e: Row) {
    const key = `${e.k}${e.id}`;
    const learned = !!e.l;
    const rc = recastKey(e);
    const left = rc ? (this.recastLeft.value.get(rc) ?? 0) : 0;
    const open = this.info.value === key;
    return (
      <div
        key={key}
        data-entry-open={open ? '' : undefined}
        class={cn(
          'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-sm',
          open
            ? 'bg-slate-800 text-slate-100'
            : 'text-slate-300 hover:bg-slate-800/50',
          !learned && 'text-slate-500',
        )}
        onClick={() => (this.info.value = open ? null : key)}
        title={
          learned
            ? `${e.pfx} "${e.n}" ${this.target.value}`
            : 'not learned'
        }
      >
        {(() => {
          const u = iconUrl(this.api, e);
          return (
            u != null && (
              <img
                src={u}
                class={cn(
                  'h-5 w-5 shrink-0 rounded-[3px]',
                  !learned && 'opacity-40',
                )}
                style={{ background: elBg(e) }}
                alt=""
                loading="lazy"
                onError={(ev) =>
                  ((ev.target as HTMLImageElement).style.display = 'none')
                }
              />
            )
          );
        })()}
        <span class="min-w-0 flex-1 truncate">{e.n}</span>
        {e.lvl != null && (
          <span class="shrink-0 text-[10px] text-slate-400">
            Lv{e.lvl}
            {e.j === 'S' ? ' SJ' : ''}
          </span>
        )}
        {left > 0 && (
          <span class="shrink-0 text-[10px] tabular-nums text-amber-300">
            {fmtSecs(left)}
          </span>
        )}
        {(() => {
          const tn = this.summonedTrust(e);
          return (
            tn && (
              <button
                class="shrink-0 cursor-pointer rounded p-0.5 text-slate-500 hover:bg-slate-700/60 hover:text-rose-300"
                title={`/returntrust "${tn}"`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  this.release(tn);
                }}
              >
                <UserMinus size={13} />
              </button>
            )
          );
        })()}
        {learned && (
          <button
            class="shrink-0 cursor-pointer rounded p-0.5 text-slate-500 hover:bg-slate-700/60 hover:text-emerald-300"
            title={`${e.pfx} "${e.n}" ${this.target.value}`}
            onClick={(ev) => {
              ev.stopPropagation();
              this.trigger(e);
            }}
          >
            <Play size={13} />
          </button>
        )}
      </div>
    );
  }

  // right-hand detail pane for the open row — name, status, actions,
  // macro command + meta, mirroring the journal's detail pane
  private detail(e: Row) {
    const key = `${e.k}${e.id}`;
    const learned = !!e.l;
    const rc = recastKey(e);
    const left = rc ? (this.recastLeft.value.get(rc) ?? 0) : 0;
    const cmd = commandFor(e, this.target.value);
    const m = meta(e);
    const actionBtn = 'mb-2 mr-2 rounded border px-3 py-1 text-xs';
    return (
      <div class="w-72 shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-950/60 p-4">
        <div class="flex items-center gap-2 pb-1">
          {(() => {
            const u = iconUrl(this.api, e);
            return (
              u != null && (
                <img
                  src={u}
                  class="h-6 w-6 rounded-[3px]"
                  style={{ background: elBg(e) }}
                  alt=""
                  onError={(ev) =>
                    ((ev.target as HTMLImageElement).style.display = 'none')
                  }
                />
              )
            );
          })()}
          <h3 class="min-w-0 text-sm font-semibold text-slate-100">{e.n}</h3>
        </div>
        <p class="pb-2 text-[10px] uppercase tracking-wider text-slate-500">
          {learned ? 'learned' : 'not learned'}
          {e.lvl != null && ` · lv${e.lvl}${e.j === 'S' ? ' sj' : ''}`}
          {left > 0 && ` · ${fmtSecs(left)} left`} · #{e.id}
        </p>
        {learned && (
          <button
            class={cn(
              actionBtn,
              'border-emerald-800/60 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/40',
            )}
            title={`input ${cmd}`}
            onClick={() => this.trigger(e)}
          >
            use with {this.target.value}
          </button>
        )}
        {(() => {
          const tn = this.summonedTrust(e);
          return (
            tn && (
              <button
                class={cn(
                  actionBtn,
                  'border-rose-800/60 bg-rose-950/40 text-rose-300 hover:bg-rose-900/40',
                )}
                title={`input /returntrust "${tn}"`}
                onClick={() => this.release(tn)}
              >
                release {tn}
              </button>
            )
          );
        })()}
        <button
          class={cn(
            actionBtn,
            'border-slate-700 bg-slate-900/60 text-slate-300 hover:bg-slate-800 hover:text-slate-100',
          )}
          onClick={() => this.copy(cmd, key)}
        >
          {this.copied.value === key ? 'copied' : 'copy macro line'}
        </button>
        <p class="pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          command
        </p>
        <code class="block break-all rounded bg-slate-900/80 px-1.5 py-1 text-xs text-sky-200">
          {cmd}
        </code>
        {m && (
          <div class="pt-3">
            <p class="pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              details
            </p>
            <p class="text-xs leading-relaxed text-slate-400">{m}</p>
          </div>
        )}
      </div>
    );
  }

  render() {
    const d = this.data.value;
    const openRow =
      this.list.value.find((e) => `${e.k}${e.id}` === this.info.value) ??
      null;
    const groupLabel =
      this.cat.value === 'all'
        ? this.tab.value === 'spells'
          ? 'All Spells'
          : 'All Abilities'
        : this.cat.value;
    return (
      <div class="flex h-full min-h-0 overflow-hidden rounded border border-slate-800 bg-slate-900">
        <aside class="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-950/60">
          <div class="flex-1 overflow-y-auto p-2">
            <p class="px-2 pb-1 pt-1 text-[10px] font-semibold tracking-wider text-slate-500">
              SPELLS
            </p>
            {this.catRow('spells', 'all', 'All Spells')}
            {this.catsFor('spells').map((c) =>
              this.catRow('spells', c, c),
            )}
            <p class="px-2 pb-1 pt-3 text-[10px] font-semibold tracking-wider text-slate-500">
              ABILITIES
            </p>
            {this.catRow('abilities', 'all', 'All Abilities')}
            {this.catsFor('abilities').map((c) =>
              this.catRow('abilities', c, c),
            )}
          </div>
          <div class="border-t border-slate-800 p-2 text-[10px] text-slate-500">
            {d?.on === 0 ? (
              <span>log in to see your spellbook</span>
            ) : (
              <span>
                {this.catStats('spells', 'all')} spells ·{' '}
                {this.catStats('abilities', 'all')} abilities learned
              </span>
            )}
          </div>
        </aside>

        <section class="flex min-w-0 flex-1 flex-col">
          <header class="flex h-10 shrink-0 items-center gap-3 border-b border-slate-800 px-4">
            <span class="min-w-0 flex-1 truncate text-xs font-semibold text-slate-300">
              {groupLabel}
            </span>
            <Input
              class="h-6 w-48 px-2 text-xs"
              placeholder="search…"
              value={this.query.value}
              onInput={(e) =>
                (this.query.value = (
                  e.currentTarget as HTMLInputElement
                ).value)
              }
            />
            <label class="flex shrink-0 items-center gap-1 text-[10px] text-slate-400">
              <input
                type="checkbox"
                checked={this.learnedOnly.value}
                onChange={(e) => {
                  const v = e.currentTarget.checked;
                  this.learnedOnly.value = v;
                  localStorage.setItem(LEARNED_KEY, v ? '1' : '0');
                }}
              />
              learned only
            </label>
            <Dropdown
              class="h-5 cursor-pointer rounded border border-slate-600/60 bg-transparent px-1 font-mono text-[10px] leading-none text-slate-300"
              title={`fire with ${this.target.value}`}
              align="right"
              value={this.target.value}
              options={TARGETS.map((t) => ({
                value: t,
                label:
                  t === '<st>'
                    ? '<st> — subtarget'
                    : t === '<stpc>'
                      ? '<stpc> — party target'
                      : t === '<stnpc>'
                        ? '<stnpc> — NPC target'
                        : t,
              }))}
              onChange={(t) =>
                this.setTarget(t as (typeof TARGETS)[number])
              }
            />
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            {(() => {
              // 'all' shows group headers as categories change (sorted
              // group-then-alpha); single-cat lists stay flat
              if (this.cat.value !== 'all') {
                return this.rows.value.map((e) => this.row(e));
              }
              let last = '';
              return this.rows.value.flatMap((e) => {
                const c = catFor(e);
                const parts = [];
                if (c !== last) {
                  last = c;
                  parts.push(
                    <p
                      key={`h:${c}`}
                      class="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500"
                    >
                      {c}
                    </p>,
                  );
                }
                parts.push(this.row(e));
                return parts;
              });
            })()}
            {d && this.rows.value.length === 0 && (
              <p class="py-8 text-center text-xs text-slate-500">
                {d.on === 0
                  ? 'log in to see your spellbook'
                  : 'no matches'}
              </p>
            )}
          </div>
        </section>

        {openRow && this.detail(openRow)}
      </div>
    );
  }
}
