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
import { Copy, Play, Check, UserMinus, LayoutGrid, List, Pin } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import { detachedMode } from '../core/host';
import { Dropdown } from '../core/dropdown';
import type {
 AbilitiesPayload,
 AbilityEntry,
 SpellEntry,
} from '../core/types';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
 PanelShell,
 PanelSidebar,
 SidebarBody,
 SidebarLabel,
 SidebarFoot,
 PanelMain,
 PanelHeader,
 DetailPane,
} from '../core/panel';

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
// pins — 'pfx|name' keys so the same name under different prefixes
// can't collide; shared by the grid and list views
const PIN_KEY = 'xicompanion.abilities.pins';
const pinKey = (e: Row) => `${e.pfx}|${e.n}`;
const loadPins = () => {
 try {
 return new Set<string>(
 JSON.parse(localStorage.getItem(PIN_KEY) ?? '[]'),
 );
 } catch {
 return new Set<string>();
 }
};

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
 // trusts only accept <me> — the client's retarget rejects anything else
 const t = (e as SpellEntry).ty === 'Trust' ? '<me>' : target;
 return `${pfx} "${e.n}" ${t}`;
}

function fmtSecs(secs?: number): string {
 if (!secs || secs <= 0) return '';
 const s = Math.round(secs * 10) / 10;
 if (s < 60) return `${s}s`;
 const m = Math.floor(s / 60);
 const rs = Math.floor(s % 60);
 if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`;
 const h = Math.floor(m / 60);
 const rm = m % 60;
 return rm ? `${h}h${rm}m` : `${h}h`;
}

export function iconUrl(api: AddonApi, e: Row): string | null {
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

// view mode — 'grid' is the quick-execute layout (2 columns, click =
// cast), 'detail' is the list + info pane. Shared with the detached
// window header's mode toggle (app.shell renders it for /abilities)
export const abilitiesMode = signal<'grid' | 'detail'>('grid');

@Component()
export class AbilitiesView extends View implements OnInit, OnDestroy {
 private api = inject(AddonApi);
 private tab = signal<'spells' | 'abilities'>('spells');
 private cat = signal('all');
 private query = signal('');
 private learnedOnly = signal(loadLearned());
 private pins = signal<Set<string>>(loadPins());
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
 const pfx = PREFIX_ALIAS[e.pfx] ?? e.pfx;
 const t = (e as SpellEntry).ty === 'Trust' ? '<me>' : this.target.value;
 void this.api.sendCommand(`input ${pfx} "${e.n}" ${t}`);
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
 <span class="shrink-0 text-[11px] text-slate-500">
 {this.catStats(tab, c)}
 </span>
 </button>
 );
 }

 private row(e: Row) {
 const key = `${e.k}${e.id}`;
 const learned = !!e.l;
 const pinned = this.pins.value.has(pinKey(e));
 const rc = recastKey(e);
 const left = rc ? (this.recastLeft.value.get(rc) ?? 0) : 0;
 const open = this.info.value === key;
 return (
 <div
 key={key}
 data-entry-open={open ? '' : undefined}
 class={cn(
 'group flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm',
 open
 ? 'bg-slate-800 text-slate-100'
 : 'text-slate-300 hover:bg-slate-800/50',
 !learned && 'text-slate-500',
 )}
 onClick={() => (this.info.value = open ? null : key)}
 title={
 learned
 ? commandFor(e, this.target.value)
 : 'not learned'
 }
 >
 {/* level sits left of the icon in a fixed slot — always rendered
 so rows without one still hold the column for scanning; trusts
 are lv99-equivalent and show nothing */}
 <span class="w-7 shrink-0 text-right text-[11px] text-slate-400">
 {e.lvl != null && e.ty !== 'Trust' && (
 <>
 {e.lvl}
 {e.j === 'S' ? ' SJ' : ''}
 </>
 )}
 </span>
 {(() => {
 const u = iconUrl(this.api, e);
 return (
 u != null && (
 <img
 src={u}
 class={cn(
 'h-8 w-8 shrink-0 rounded-[3px]',
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
 <span class="flex min-w-0 flex-1 flex-col">
 <span class="flex items-center gap-1.5">
 <span class="min-w-0 flex-1 truncate">{e.n}</span>
 </span>
 {/* cast time / cooldown live on the second row so a long
 recast never squeezes the name or shoves the row's
 actions sideways */}
 <span class="flex items-center gap-2 text-[11px] leading-tight text-slate-500">
 {'ct' in e && e.ct != null && e.ct > 0 && (
 <span>cast {fmtSecs(e.ct)}</span>
 )}
 {'rc' in e && e.rc != null && e.rc > 0 && (
 <span>cd {fmtSecs(e.rc)}</span>
 )}
 {left > 0 && (
 <span class="tabular-nums text-amber-300">
 {fmtSecs(left)} left
 </span>
 )}
 </span>
 </span>
 {(() => {
 const tn = this.summonedTrust(e);
 return (
 tn && (
 <button
 class="shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-700/60 hover:text-rose-300"
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
 class="shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-700/60 hover:text-emerald-300"
 title={commandFor(e, this.target.value)}
 onClick={(ev) => {
 ev.stopPropagation();
 this.trigger(e);
 }}
 >
 <Play size={13} />
 </button>
 )}
 {/* pin sits last so the play button keeps a stable spot — it's
 hover-revealed like the grid tile's corner pin, always visible
 once pinned */}
 <button
 class={cn(
 'shrink-0 rounded p-0.5 hover:bg-slate-700/60',
 pinned
 ? 'text-amber-300'
 : 'text-slate-500 opacity-0 group-hover:opacity-100',
 )}
 title={pinned ? 'unpin' : 'pin to top'}
 onClick={(ev) => this.togglePin(e, ev)}
 >
 <Pin size={12} />
 </button>
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
 <DetailPane>
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
 use {(e as SpellEntry).ty === 'Trust' ? '<me>' : this.target.value}
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
 'border-slate-700 bg-black/30 text-slate-300 hover:bg-slate-800 hover:text-slate-100',
 )}
 onClick={() => this.copy(cmd, key)}
 >
 {this.copied.value === key ? 'copied' : 'copy macro line'}
 </button>
 <p class="pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
 command
 </p>
 <code class="block break-all rounded bg-black/60 px-1.5 py-1 text-xs text-sky-200">
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
 </DetailPane>
 );
 }

 private togglePin(e: Row, ev: Event) {
 ev.stopPropagation();
 const s = new Set(this.pins.value);
 const k = pinKey(e);
 if (s.has(k)) s.delete(k);
 else s.add(k);
 this.pins.value = s;
 localStorage.setItem(PIN_KEY, JSON.stringify([...s]));
 }

 // shared mode toggle — rendered inside the view (grid + detail) so
 // it works in the nav tab where there's no detached title bar
 private modeToggle() {
 // icon shows the mode a click switches TO — hidden in detached
 // windows where the title bar already has the toggle
 if (detachedMode) return null;
 const grid = abilitiesMode.value === 'grid';
 const Icon = grid ? List : LayoutGrid;
 return (
 <button
 class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-300/80 hover:bg-white/10 hover:text-white"
 title={grid ? 'switch to list view' : 'switch to grid view'}
 onClick={() => (abilitiesMode.value = grid ? 'detail' : 'grid')}
 >
 <Icon size={12} />
 </button>
 );
 }

 // quick-execute grid — two columns (spells | abilities); each tile
 // casts on click instead of opening the detail pane. Honors the
 // learned-only + search filters and live recast dimming.
 private gridView() {
 const d = this.data.value;
 const q = this.query.value.trim().toLowerCase();
 const learned = this.learnedOnly.value;
 const filt = (list: Row[]) =>
 (list ?? []).filter(
 (e) => (!learned || e.l) && (!q || e.n.toLowerCase().includes(q)),
 );
 const tile = (e: Row) => {
 const rc = recastKey(e);
 const left = rc ? (this.recastLeft.value.get(rc) ?? 0) : 0;
 const u = iconUrl(this.api, e);
 const sp = e as SpellEntry;
 const ab = e as AbilityEntry;
 const cost =
 (sp.mp ?? 0) > 0
 ? `${sp.mp} MP`
 : (ab.mp ?? 0) > 0
 ? `${ab.mp} MP`
 : (ab.tp ?? 0) > 0
 ? `${ab.tp} TP`
 : null;
 const pinned = this.pins.value.has(pinKey(e));
 return (
 <button
 key={pinKey(e)}
 class={cn(
 'group relative flex items-center gap-1.5 rounded border border-slate-700/60 bg-slate-800/50 px-1 py-1 text-left',
 e.l
 ? 'hover:bg-indigo-500/20 active:bg-indigo-500/40'
 : 'opacity-40',
 left > 0 && 'opacity-50',
 )}
 title={e.n}
 disabled={!e.l}
 onClick={() => this.trigger(e)}
 >
 <span
 class={cn(
 'absolute right-0.5 top-0.5 rounded p-0.5 hover:bg-white/10',
 pinned
 ? 'text-amber-300'
 : 'text-slate-500/60 opacity-0 group-hover:opacity-100',
 )}
 title={pinned ? 'unpin' : 'pin to top'}
 onClick={(ev) => this.togglePin(e, ev)}
 >
 <Pin size={9} />
 </span>
 {u != null && (
 <img
 src={u}
 class="h-8 w-8 shrink-0 rounded-[3px]"
 style={{ background: elBg(e) }}
 alt=""
 loading="lazy"
 />
 )}
 <span class="min-w-0 flex-1">
 <span class="block truncate text-xs leading-tight text-slate-100">
 {e.n}
 </span>
 <span class="block truncate text-[10px] leading-tight text-slate-400">
 {e.lvl != null && e.ty !== 'Trust' && (
 <>
 lv{e.lvl}
 {e.j === 'S' ? ' SJ' : ''}
 {cost && ' · '}
 </>
 )}
 {cost}
 {left > 0 && (
 <span class="text-amber-300">
 {(e.lvl != null || cost) && ' · '}
 {left}s
 </span>
 )}
 </span>
 </span>
 </button>
 );
 };
 const col = (label: string, list: Row[]) => {
 // grid shows castables only — unlearned stays dimmed in the list
 const rows = filt(list).filter((e) => e.l);
 const pinned = rows.filter((e) => this.pins.value.has(pinKey(e)));
 const rest = rows.filter((e) => !this.pins.value.has(pinKey(e)));
 return (
 <div class="flex min-h-0 flex-1 flex-col">
 <p class="px-1 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400/70">
 {label}
 </p>
 {pinned.length > 0 && (
 <>
 <p class="px-1 pb-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-300/70">
 pinned
 </p>
 <div class="grid shrink-0 auto-rows-min grid-cols-2 content-start gap-1">
 {pinned.map(tile)}
 </div>
 <div class="mx-1 my-1 border-t border-slate-700/50" />
 </>
 )}
 <div class="grid flex-1 auto-rows-min grid-cols-2 content-start gap-1 overflow-y-auto">
 {/* 'all' rows are already category-rank sorted — emit a
 type header on each transition; a picked category is
 single-type, so no headers needed */}
 {(() => {
 if (this.cat.value !== 'all') return rest.map(tile);
 // bucket by category — row order isn't reliable enough to
 // rely on transitions (dup headers when cats interleave)
 const groups = new Map<string, Row[]>();
 for (const e of rest) {
 const c = catFor(e);
 const g = groups.get(c);
 if (g) g.push(e);
 else groups.set(c, [e]);
 }
 const out: any[] = [];
 const order = [...groups.keys()].sort(
 (a, b) =>
 (CAT_ORDER.indexOf(a) === -1 ? 99 : CAT_ORDER.indexOf(a)) -
 (CAT_ORDER.indexOf(b) === -1 ? 99 : CAT_ORDER.indexOf(b)),
 );
 for (const c of order) {
 out.push(
 <p
 key={'h:' + c}
 class="col-span-2 mt-1 px-1 text-[9px] font-bold uppercase tracking-widest text-slate-400/70 first:mt-0"
 >
 {c.toLowerCase()}
 </p>,
 );
 for (const e of groups.get(c)!) out.push(tile(e));
 }
 return out;
 })()}
 </div>
 </div>
 );
 };
 return (
 <div class="flex h-full flex-col gap-1 overflow-hidden p-1">
 <div class="flex shrink-0 items-center gap-1 px-0.5">
 <Input
 class="h-6 flex-1 text-xs"
 placeholder="search…"
 value={this.query.value}
 onInput={(e) =>
 (this.query.value = (
 e.currentTarget as HTMLInputElement
 ).value)
 }
 />
 {this.modeToggle()}
 </div>
 <div class="flex min-h-0 flex-1 gap-2">
 {col('spells', d?.spells ?? [])}
 {col('abilities', d?.abilities ?? [])}
 </div>
 </div>
 );
 }

 render() {
 if (abilitiesMode.value === 'grid') return this.gridView();
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
 <PanelShell>
 <PanelSidebar>
 <SidebarBody>
 <SidebarLabel class="pt-1">SPELLS</SidebarLabel>
 {this.catRow('spells', 'all', 'All Spells')}
 {this.catsFor('spells').map((c) =>
 this.catRow('spells', c, c),
 )}
 <SidebarLabel>ABILITIES</SidebarLabel>
 {this.catRow('abilities', 'all', 'All Abilities')}
 {this.catsFor('abilities').map((c) =>
 this.catRow('abilities', c, c),
 )}
 </SidebarBody>
 <SidebarFoot>
 {d?.on === 0 ? (
 <span>log in to see your spellbook</span>
 ) : (
 <span>
 {this.catStats('spells', 'all')} spells ·{' '}
 {this.catStats('abilities', 'all')} abilities learned
 </span>
 )}
 </SidebarFoot>
 </PanelSidebar>

 <PanelMain>
 <PanelHeader>
 <span class="min-w-0 flex-1 truncate text-xs font-semibold text-slate-300">
 {groupLabel}
 </span>
 {this.modeToggle()}
 <Input
 class="w-48"
 placeholder="search…"
 value={this.query.value}
 onInput={(e) =>
 (this.query.value = (
 e.currentTarget as HTMLInputElement
 ).value)
 }
 />
 <label class="flex shrink-0 items-center gap-1 text-[11px] text-slate-400">
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
 class="h-5 px-1 font-mono text-[10px] leading-none"
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
 </PanelHeader>
 <div class="min-h-0 flex-1 overflow-y-auto p-2">
 {(() => {
 // pinned rows lead the list under their own header (mirroring
 // the grid's pinned section); the rest keep the flat or
 // category-grouped layout
 const pinned: Row[] = [];
 const rest: Row[] = [];
 for (const e of this.rows.value)
 (this.pins.value.has(pinKey(e)) ? pinned : rest).push(e);
 const head = (key: string, label: string, amber = false) => (
 <p
 key={key}
 class={cn(
 'px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider',
 amber ? 'text-amber-300/70' : 'text-slate-500',
 )}
 >
 {label}
 </p>
 );
 const out: any[] = [];
 if (pinned.length) {
 out.push(head('h:pinned', 'pinned', true));
 for (const e of pinned) out.push(this.row(e));
 if (rest.length)
 out.push(
 <div
 key="d:pinned"
 class="mx-2 my-1 border-t border-slate-700/50"
 />,
 );
 }
 // 'all' shows group headers as categories change (sorted
 // group-then-alpha); single-cat lists stay flat
 if (this.cat.value === 'all') {
 let last = '';
 for (const e of rest) {
 const c = catFor(e);
 if (c !== last) {
 last = c;
 out.push(head(`h:${c}`, c));
 }
 out.push(this.row(e));
 }
 } else {
 for (const e of rest) out.push(this.row(e));
 }
 return out;
 })()}
 {d && this.rows.value.length === 0 && (
 <p class="py-8 text-center text-xs text-slate-500">
 {d.on === 0
 ? 'log in to see your spellbook'
 : 'no matches'}
 </p>
 )}
 </div>
 </PanelMain>

 {openRow && this.detail(openRow)}
 </PanelShell>
 );
 }
}
