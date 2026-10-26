// Journal: the player's quest, mission and Records of Eminence state.
// Live data arrives from the addon's packet trackers (0x056 log packets,
// 0x111/0x112 RoE packets) over the `journal` SSE event; the static
// name/description tables come from /api/journal/names (extracted from
// the client DATs at build time).
import { Component, View, inject, signal, computed, effect, Router } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { ChevronDown, ChevronRight, ExternalLink, ListTodo } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import { wikiLink, wikiSearchUrl, type WikiLink } from './wiki';
import type { JournalNames, JournalNameEntry } from '../core/types';
import {
  MISSION_ORDER,
  QUEST_ORDER,
  groupKey,
  hasActivity,
  missionStatus,
  questStatus,
  sortedIds,
  trackKey,
  type Status,
} from './activity';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type Section = { kind: 'mission' | 'quest' | 'roe'; key: string };

interface Entry {
  id: number;
  name: string;
  status: Status;
  entry?: JournalNameEntry;
  /** RoE: live progress + target */
  progress?: number;
  target?: number;
  limited?: boolean;
  /** missions: stage names attached to this record */
  stages?: string[];
}

/** RoE subcategory -> its entries */
interface RoeSub {
  id: number;
  name: string;
  entries: Entry[];
}
/** RoE top category -> its subcategories */
interface RoeCat {
  id: number;
  name: string;
  subs: RoeSub[];
}

function statusBadge(s: Status) {
  if (s === 'done')
    return <span class="text-emerald-400" title="completed">✓</span>;
  if (s === 'current')
    return <span class="text-sky-400" title="in progress">▶</span>;
  return <span class="text-slate-600" title="not started">·</span>;
}

@Component()
export class JournalView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private router = inject(Router);

  private names = signal<JournalNames | null>(null);
  private sel = signal<Section>({ kind: 'mission', key: 'sandoria' });
  private query = signal('');
  private showAll = signal(false);
  private openId = signal<number | null>(null);
  private roeError = signal<string | null>(null);
  private disposeDeepLink?: () => void;
  private disposeWiki?: () => void;
  private disposeConn?: () => void;
  private wiki = signal<{ state: 'idle' | 'loading' | 'ok' | 'none'; page?: WikiLink }>({
    state: 'idle',
  });
  // sidebar filter: only groups with in-progress content
  private activeOnly = signal(true);

  onInit() {
    void this.api.refreshJournal();
    void this.loadNames();
    // a names fetch that raced the addon's startup used to stick as
    // "Objective #N" forever — refetch on every (re)connect
    this.disposeConn = effect(() => {
      if (this.api.connected.value) {
        void this.loadNames();
        this.api.pokeJournal();
      }
    });
    // the tracker deep-links in via /journal?g=<kind>&s=<key>&id=<n>. The
    // view stays mounted across query-only navigations (router.navigate
    // from the main window's __xicNavigate), so watch the url signal —
    // every tracker click re-applies.
    this.disposeDeepLink = effect(() => {
      this.applyDeepLink();
    });
    // lazily resolve the wiki reference page for whatever entry is open
    this.disposeWiki = effect(() => {
      const e = this.selectedEntry.value;
      this.wiki.value = { state: 'idle' };
      if (e) void this.loadWiki(e);
    });
  }

  onDestroy() {
    this.disposeDeepLink?.();
    this.disposeWiki?.();
    this.disposeConn?.();
  }

  private async loadNames() {
    try {
      const n = await this.api.journalNames();
      const first = this.names.value == null;
      this.names.value = n;
      // default the view to the player's own nation storyline (skipped
      // when a deep link already picked a group)
      const nation = this.api.journal.value?.nation;
      const line =
        nation != null ? ['sandoria', 'bastok', 'windurst'][nation] : null;
      if (
        first &&
        line &&
        n.mission_lines?.[line] &&
        !this.applyDeepLink()
      ) {
        this.sel.value = { kind: 'mission', key: line };
      }
    } catch {
      // retried on the next reconnect
    }
  }

  private async loadWiki(e: Entry) {
    this.wiki.value = { state: 'loading' };
    const p = await wikiLink(e.name).catch(() => null);
    // the selection may have moved on while the wiki resolved
    if (this.selectedEntry.value?.id !== e.id) return;
    this.wiki.value = p ? { state: 'ok', page: p } : { state: 'none' };
  }

  /** select the group/entry named by the url params — returns true when
   *  a deep link was applied so the nation default is skipped */
  private applyDeepLink(): boolean {
    const url = this.router.url.value;
    const qs = url.startsWith('/journal?')
      ? url.slice(url.indexOf('?') + 1)
      : '';
    const q = new URLSearchParams(qs);
    const kind = q.get('g');
    const key = q.get('s');
    const id = q.get('id');
    if (
      (kind !== 'mission' && kind !== 'quest' && kind !== 'roe') ||
      !key
    ) {
      return false;
    }
    this.sel.value = { kind, key };
    if (id != null) {
      this.openId.value = Number(id);
      // entries render on the next signal flush — bring the row into view
      setTimeout(
        () =>
          document
            .querySelector('[data-entry-open]')
            ?.scrollIntoView({ block: 'center' }),
        50,
      );
    }
    return true;
  }

  // ---------- derived views ----------

  private entries = computed<Entry[]>(() => {
    const sel = this.sel.value;
    const names = this.names.value;
    const j = this.api.journal.value;
    const out: Entry[] = [];

    if (sel.kind === 'roe') {
      const doneSet = new Set(j?.roe?.done ?? []);
      // the client keeps completed objectives in the active slots — a
      // done id isn't active; it belongs in the completed log below
      const active = (j?.roe?.active ?? []).filter((a) => !doneSet.has(a.id));
      for (const a of active) {
        const meta = names?.roe?.[String(a.id)];
        out.push({
          id: a.id,
          name: meta?.n ?? `Objective #${a.id}`,
          status: 'current',
          entry: meta,
          progress: a.progress,
          target: meta?.t,
          limited: a.limited,
        });
      }
      const ids = Object.keys(names?.roe ?? {})
        .map(Number)
        .sort((a, b) => a - b);
      for (const id of ids) {
        if (active.some((a) => a.id === id)) continue;
        const meta = names?.roe?.[String(id)];
        if (!meta) continue;
        out.push({
          id,
          name: meta.n,
          status: doneSet.has(id) ? 'done' : 'open',
          entry: meta,
          target: meta.t,
        });
      }
      return out;
    }

    const grp =
      sel.kind === 'mission'
        ? names?.mission_lines?.[sel.key]
        : names?.quest_areas?.[sel.key];
    // union names-table ids with the live packet bits — an extraction gap
    // must never hide a quest the client reports as current/completed
    // (a bit with no record still gets a row so its ▶/✓ shows)
    const ids = new Set(sortedIds(names, sel.kind, sel.key));
    if (sel.kind === 'quest') {
      const area = j?.quests?.[sel.key];
      for (const id of [...(area?.current ?? []), ...(area?.done ?? [])]) {
        ids.add(id);
      }
    }
    for (const id of [...ids].sort((a, b) => a - b)) {
      const meta = grp?.ids?.[String(id)];
      if (!meta) {
        // mission pointers can be sentinels — only quests get bare rows
        if (sel.kind !== 'quest') continue;
        out.push({
          id,
          name: `Quest #${id}`,
          status: questStatus(j, sel.key, id),
        });
        continue;
      }
      const status: Status =
        sel.kind === 'mission'
          ? missionStatus(j, names, sel.key, id)
          : questStatus(j, sel.key, id);
      out.push({ id, name: meta.n, status, entry: meta, stages: meta.s });
    }
    return out;
  });

  private filtered = computed<Entry[]>(() => {
    const q = this.query.value.trim().toLowerCase();
    let list = this.entries.value;
    if (q) {
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.entry?.d?.toLowerCase().includes(q),
      );
    } else if (!this.showAll.value) {
      // default view is in-progress only — "show all" (or a search)
      // reveals untouched and completed entries
      list = list.filter((e) => e.status === 'current');
    }
    return list;
  });

  // ---------- RoE category tree ----------
  // the client data carries its own menu structure: roe_tree maps the
  // 11 top categories to their subcategories and each objective's `c`
  // links it to a subcategory. Groups render collapsed/expanded via
  // `collapsed` (everything expands by default — categories holding
  // in-progress objectives can't realistically start hidden anyway).

  private collapsed = signal<Set<string>>(new Set());
  private toggleGroup = (key: string) => {
    const next = new Set(this.collapsed.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.collapsed.value = next;
  };

  private roeGroups = computed<RoeCat[]>(() => {
    const names = this.names.value;
    const tree = names?.roe_tree ?? {};
    // bucket the already-status-filtered entries by subcategory id
    const bySub = new Map<number, Entry[]>();
    for (const e of this.filtered.value) {
      const c = e.entry?.c ?? 0;
      const arr = bySub.get(c) ?? [];
      arr.push(e);
      bySub.set(c, arr);
    }
    const sub = (id: number): RoeSub => ({
      id,
      name: names?.roe_categories?.[String(id)] ?? `Category #${id}`,
      entries: bySub.get(id) ?? [],
    });
    const out: RoeCat[] = [];
    const claimed = new Set<number>();
    for (const [catId, kids] of Object.entries(tree)) {
      const subs = kids.map(sub).filter((s) => s.entries.length > 0);
      for (const s of subs) claimed.add(s.id);
      if (subs.length > 0) {
        out.push({
          id: Number(catId),
          name: names?.roe_categories?.[catId] ?? `Category #${catId}`,
          subs,
        });
      }
    }
    // subcats outside the emitted tree (extraction gaps) and entries
    // with no category land in a synthetic tail group
    const straySubs = [...bySub.keys()]
      .filter((id) => !claimed.has(id))
      .sort((a, b) => a - b)
      .map(sub)
      .filter((s) => s.entries.length > 0);
    if (straySubs.length > 0) {
      out.push({ id: -1, name: 'Other', subs: straySubs });
    }
    return out;
  });

  private selectedEntry = computed<Entry | null>(() => {
    const id = this.openId.value;
    if (id == null) return null;
    return this.entries.value.find((e) => e.id === id) ?? null;
  });

  // ---------- sidebar rows ----------

  private groupRow(kind: Section['kind'], key: string, label: string, hint: string) {
    const active = this.sel.value.kind === kind && this.sel.value.key === key;
    // group-level tracker toggle — 'kind:key' suppresses every current
    // and future item in the group on the tracker window
    const untracked = (this.api.journal.value?.untracked ?? []).includes(
      groupKey(kind, key),
    );
    return (
      <button
        key={kind + key}
        class={cn(
          'flex w-full flex-col rounded px-2 py-1 text-left',
          active
            ? 'bg-slate-800 text-slate-100'
            : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
          untracked && 'opacity-60',
        )}
        onClick={() => {
          this.sel.value = { kind, key };
          this.openId.value = null;
        }}
      >
        <span class="flex items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate text-sm">{label}</span>
          {untracked && (
            <span
              class="text-[9px] text-slate-600"
              title="hidden from the tracker — re-enable from the list header or an entry's detail pane"
            >
              hidden
            </span>
          )}
        </span>
        {hint && <span class="truncate text-[10px] text-slate-500">{hint}</span>}
      </button>
    );
  }

  private missionHint(key: string): string {
    const j = this.api.journal.value;
    const line = j?.missions?.[key];
    const grp = this.names.value?.mission_lines?.[key];
    const total = Object.keys(grp?.ids ?? {}).length;
    if (!line) return total ? `${total}` : '';
    if (hasActivity(j, this.names.value, 'mission', key)) {
      const cur = grp?.ids?.[String(line.current!)]?.n;
      if (cur) return `▶ ${cur}`;
    }
    const done = line.done?.length ?? 0;
    return total ? `${done}/${total}` : `${done}`;
  }

  private questHint(key: string): string {
    const j = this.api.journal.value;
    const area = j?.quests?.[key];
    const total = Object.keys(this.names.value?.quest_areas?.[key]?.ids ?? {})
      .length;
    if (!area) return total ? `${total}` : '';
    const done = new Set(area.done ?? []);
    const cur = (area.current ?? []).filter((id) => !done.has(id)).length;
    // ▶ prefix like active mission lines — at-a-glance "in progress"
    return `${cur ? '▶ ' : ''}${cur} active · ${done.size}/${total}`;
  }

  private roeHint(): string {
    const j = this.api.journal.value;
    const doneSet = new Set(j?.roe?.done ?? []);
    // finished objectives can linger in the active slots — they don't
    // count (same rule hasActivity applies)
    const active = (j?.roe?.active ?? []).filter(
      (a) => !doneSet.has(a.id),
    ).length;
    return `${active ? '▶ ' : ''}${active} active · ${doneSet.size} done`;
  }

  // ---------- main pane ----------

  private async roeToggle(e: Entry) {
    this.roeError.value = null;
    try {
      await this.api.roeAction(e.id, e.status === 'current' ? 'clear' : 'set');
    } catch (err) {
      this.roeError.value = String(err);
    }
  }

  private entryRow(e: Entry) {
    const open = this.openId.value === e.id;
    return (
      <button
        key={e.id}
        data-entry-open={open ? '' : undefined}
        class={cn(
          'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm',
          open
            ? 'bg-slate-800 text-slate-100'
            : 'text-slate-300 hover:bg-slate-800/50',
          e.status === 'open' && 'text-slate-500',
        )}
        onClick={() => (this.openId.value = open ? null : e.id)}
      >
        <span class="w-4 shrink-0 text-center">{statusBadge(e.status)}</span>
        <span class="min-w-0 flex-1 truncate">{e.name}</span>
        {e.limited && (
          <span class="rounded bg-amber-900/60 px-1 text-[9px] text-amber-300">
            limited
          </span>
        )}
        {e.entry?.r === 1 && (
          <span class="rounded bg-slate-700/60 px-1 text-[9px] text-slate-400" title="repeatable">
            rep
          </span>
        )}
        {e.progress != null && (
          <span class="flex w-28 shrink-0 items-center gap-1">
            <span class="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
              <span
                class={cn(
                  'block h-full rounded',
                  e.status === 'done' ? 'bg-emerald-500' : 'bg-sky-500',
                )}
                style={`width:${Math.min(
                  100,
                  e.target ? (e.progress / e.target) * 100 : e.progress ? 100 : 0,
                )}%`}
              />
            </span>
            <span class="w-14 text-right text-[10px] tabular-nums text-slate-400">
              {e.target ? `${Math.min(e.progress, e.target)}/${e.target}` : e.progress}
            </span>
          </span>
        )}
        <span class="w-8 shrink-0 text-right text-[10px] text-slate-600">
          {e.id}
        </span>
      </button>
    );
  }

  private detail(e: Entry) {
    const isRoe = this.sel.value.kind === 'roe';
    const { kind, key } = this.sel.value;
    // limited-time objectives are server-managed — no manual set/clear.
    // The client keeps completed objectives in the active slots, so a
    // done entry can still be slotted: give-up frees the slot while
    // accept(-again) only applies when it isn't set at all
    const slotted =
      isRoe &&
      (this.api.journal.value?.roe?.active ?? []).some((a) => a.id === e.id);
    const canGiveUp = isRoe && !e.limited && slotted;
    const canAccept =
      isRoe &&
      !e.limited &&
      !slotted &&
      (e.status !== 'done' || e.entry?.r === 1);
    // tracker visibility — 'kind:key:id' hides this entry, 'kind:key'
    // hides the whole category (list-header toggle). A group hide wins
    // over the entry key, so re-showing clears both.
    const untracked = this.api.journal.value?.untracked ?? [];
    const entryHidden = untracked.includes(trackKey(kind, key, e.id));
    const groupHidden = untracked.includes(groupKey(kind, key));
    const trackErr = (err: unknown) => (this.roeError.value = String(err));
    const groupLabel =
      (kind === 'mission'
        ? this.names.value?.mission_lines?.[key]?.name
        : kind === 'quest'
          ? this.names.value?.quest_areas?.[key]?.name
          : 'Objectives') ?? key;
    const actionBtn =
      'mb-2 mr-2 rounded border px-3 py-1 text-xs';
    const setEntryTracked = (tracked: boolean) => {
      void this.api.setTracked(kind, key, e.id, tracked).catch(trackErr);
      // re-showing must also lift a category-level hide — the group key
      // suppresses every entry regardless of its own flag
      if (tracked && groupHidden) {
        void this.api
          .setTracked(kind, key, undefined, true)
          .catch(trackErr);
      }
    };
    const setGroupTracked = (tracked: boolean) =>
      void this.api.setTracked(kind, key, undefined, tracked).catch(trackErr);
    return (
      <div class="w-96 shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-950/60 p-4">
        <h3 class="text-sm font-semibold text-slate-100">{e.name}</h3>
        <p class="pb-2 text-[10px] uppercase tracking-wider text-slate-500">
          {e.status === 'done'
            ? 'completed'
            : e.status === 'current'
              ? 'in progress'
              : 'not started'}
          {e.entry?.r === 1 && ' · repeatable'} · #{e.id}
        </p>
        {isRoe && e.limited && (
          <p class="pb-2 text-[10px] text-amber-400/80">
            limited-time objective — managed by the server
          </p>
        )}
        {(canGiveUp || canAccept) && (
          <button
            class={cn(
              actionBtn,
              canGiveUp
                ? 'border-rose-800/60 bg-rose-950/40 text-rose-300 hover:bg-rose-900/40'
                : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/40',
            )}
            onClick={() => void this.roeToggle(e)}
          >
            {canGiveUp
              ? 'give up objective'
              : e.status === 'done'
                ? 'accept again'
                : 'accept objective'}
          </button>
        )}
        {e.status === 'current' && (
          <button
            class={cn(
              actionBtn,
              'border-slate-700 bg-slate-900/60 text-slate-300 hover:bg-slate-800 hover:text-slate-100',
            )}
            title={
              groupHidden && !entryHidden
                ? 'hidden by category — this also unhides the category'
                : undefined
            }
            onClick={() => setEntryTracked(entryHidden || groupHidden)}
          >
            {entryHidden || groupHidden
              ? 'show in tracker'
              : 'hide from tracker'}
          </button>
        )}
        <button
          class={cn(
            actionBtn,
            'border-slate-700 bg-slate-900/60 text-slate-300 hover:bg-slate-800 hover:text-slate-100',
          )}
          onClick={() => setGroupTracked(groupHidden)}
        >
          {groupHidden
            ? `show “${groupLabel}” in tracker`
            : `hide “${groupLabel}” in tracker`}
        </button>
        {e.progress != null && e.target != null && (
          <p class="pb-2 text-xs text-slate-400">
            progress: {e.progress} / {e.target}
          </p>
        )}
        {e.stages && e.stages.length > 0 && (
          <div class="pb-2">
            <p class="pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              stages
            </p>
            <ul class="space-y-0.5">
              {e.stages.map((s, i) => (
                <li key={i} class="text-xs text-slate-300">
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}
        {e.entry?.d && (
          <p class="whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
            {e.entry.d}
          </p>
        )}
        {this.wiki.value.state !== 'idle' && (
          <div class="flex items-baseline gap-2 pt-3">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              wiki
            </span>
            {this.wiki.value.state === 'loading' ? (
              <span class="text-[10px] text-slate-600">…</span>
            ) : (
              <button
                class="flex items-center gap-0.5 text-[10px] text-sky-400 hover:underline"
                title="open in your browser"
                onClick={() =>
                  host.openExternal(
                    this.wiki.value.page?.url ?? wikiSearchUrl(e.name),
                  )
                }
              >
                {this.wiki.value.state === 'ok'
                  ? this.wiki.value.page!.title
                  : 'search the wiki'}
                <ExternalLink size={9} />
              </button>
            )}
            {this.wiki.value.state === 'ok' && (
              <span class="text-[9px] text-slate-600">
                {this.wiki.value.page!.source}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  private groupHeader(
    key: string,
    label: string,
    entries: Entry[],
    depth: number,
  ) {
    const collapsed = this.collapsed.value.has(key);
    const cur = entries.filter((e) => e.status === 'current').length;
    return (
      <button
        key={key}
        class={cn(
          'flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-[11px] font-semibold uppercase tracking-wider',
          depth === 0
            ? 'pl-1 text-slate-300 hover:bg-slate-800/60'
            : 'pl-4 text-slate-400 hover:bg-slate-800/40',
        )}
        onClick={() => this.toggleGroup(key)}
      >
        {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        <span class="min-w-0 flex-1 truncate">{label}</span>
        {cur > 0 && <span class="text-sky-400">▶ {cur}</span>}
        <span class="text-slate-600">{entries.length}</span>
      </button>
    );
  }

  private roeCat(cat: RoeCat) {
    const all = cat.subs.flatMap((s) => s.entries);
    const collapsed = this.collapsed.value.has(`c${cat.id}`);
    return (
      <div key={cat.id}>
        {this.groupHeader(`c${cat.id}`, cat.name, all, 0)}
        {!collapsed &&
          cat.subs.map((s) => {
            const subCollapsed = this.collapsed.value.has(`s${s.id}`);
            return (
              <div key={s.id}>
                {this.groupHeader(`s${s.id}`, s.name, s.entries, 1)}
                {!subCollapsed && (
                  <div class="pl-5">{s.entries.map((e) => this.entryRow(e))}</div>
                )}
              </div>
            );
          })}
      </div>
    );
  }

  render() {
    const names = this.names.value;
    const j = this.api.journal.value;
    const sel = this.sel.value;
    const selEntry = this.selectedEntry.value;

    const activeOnly = this.activeOnly.value;
    const missionGroups = MISSION_ORDER.filter(
      (k) =>
        names?.mission_lines?.[k] &&
        (!activeOnly || hasActivity(j, names, 'mission', k)),
    );
    const questGroups = QUEST_ORDER.filter(
      (k) =>
        names?.quest_areas?.[k] &&
        (!activeOnly || hasActivity(j, names, 'quest', k)),
    );

    return (
      <div class="flex h-full min-h-0 overflow-hidden rounded border border-slate-800 bg-slate-900">
        <aside class="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-950/60">
          <label class="flex shrink-0 items-center gap-1.5 border-b border-slate-800 px-3 py-1.5 text-[10px] text-slate-400">
            <input
              type="checkbox"
              checked={this.activeOnly.value}
              onChange={(e) =>
                (this.activeOnly.value = e.currentTarget.checked)
              }
            />
            active only
          </label>
          <div class="flex-1 overflow-y-auto p-2">
            <p class="px-2 pb-1 pt-1 text-[10px] font-semibold tracking-wider text-slate-500">
              MISSIONS
            </p>
            {missionGroups.map((k) =>
              this.groupRow(
                'mission',
                k,
                names?.mission_lines?.[k]?.name ?? k,
                this.missionHint(k),
              ),
            )}
            {missionGroups.length === 0 && (
              <p class="px-2 text-[10px] text-slate-600">none active</p>
            )}
            <p class="px-2 pb-1 pt-3 text-[10px] font-semibold tracking-wider text-slate-500">
              QUESTS
            </p>
            {questGroups.map((k) =>
              this.groupRow(
                'quest',
                k,
                names?.quest_areas?.[k]?.name ?? k,
                this.questHint(k),
              ),
            )}
            {questGroups.length === 0 && (
              <p class="px-2 text-[10px] text-slate-600">none active</p>
            )}
            <p class="px-2 pb-1 pt-3 text-[10px] font-semibold tracking-wider text-slate-500">
              RECORDS OF EMINENCE
            </p>
            {(!activeOnly || hasActivity(j, names, 'roe', 'roe')) &&
              this.groupRow('roe', 'roe', 'Objectives', this.roeHint())}
            {activeOnly && !hasActivity(j, names, 'roe', 'roe') && (
              <p class="px-2 text-[10px] text-slate-600">none active</p>
            )}
          </div>
          <div class="border-t border-slate-800 p-2 text-[10px] text-slate-500">
            {j?.char ? (
              <span>
                {j.char} · updated{' '}
                {new Date((j.updated ?? 0) * 1000).toLocaleTimeString()}
              </span>
            ) : (
              <span>log in to populate the journal</span>
            )}
          </div>
        </aside>

        <section class="flex min-w-0 flex-1 flex-col">
          <header class="flex h-10 shrink-0 items-center gap-3 border-b border-slate-800 px-4">
            {(() => {
              // the selected category's tracker visibility — same group
              // key ('kind:key') the sidebar 'hidden' marker reports on
              const groupHidden = (j?.untracked ?? []).includes(
                groupKey(sel.kind, sel.key),
              );
              const groupLabel =
                (sel.kind === 'mission'
                  ? names?.mission_lines?.[sel.key]?.name
                  : sel.kind === 'quest'
                    ? names?.quest_areas?.[sel.key]?.name
                    : 'Objectives') ?? sel.key;
              return (
                <div class="flex min-w-0 flex-1 items-center gap-2">
                  <span class="truncate text-xs font-semibold text-slate-300">
                    {groupLabel}
                  </span>
                  <button
                    class={cn(
                      'rounded border px-1.5 py-0.5 text-[10px]',
                      groupHidden
                        ? 'border-sky-800/60 bg-sky-950/40 text-sky-300 hover:bg-sky-900/40'
                        : 'border-slate-700 bg-slate-900/60 text-slate-400 hover:bg-slate-800 hover:text-slate-200',
                    )}
                    title={
                      groupHidden
                        ? 'show this category in the tracker'
                        : 'hide this category from the tracker'
                    }
                    onClick={() =>
                      void this.api
                        .setTracked(sel.kind, sel.key, undefined, groupHidden)
                        .catch(
                          (err) => (this.roeError.value = String(err)),
                        )
                    }
                  >
                    {groupHidden ? 'show' : 'hide'}
                  </button>
                </div>
              );
            })()}
            <Input
              class="h-6 w-48 px-2 text-xs"
              placeholder="search…"
              value={this.query.value}
              onInput={(e) => (this.query.value = e.currentTarget.value)}
            />
            <label class="flex items-center gap-1 text-[10px] text-slate-400">
              <input
                type="checkbox"
                checked={this.showAll.value}
                onChange={(e) =>
                  (this.showAll.value = e.currentTarget.checked)
                }
              />
              show all
            </label>
            {host.inShell() && (
              <button
                class="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                title="open the quest tracker window"
                onClick={() => host.spawnWindow('/tracker')}
              >
                <ListTodo size={13} />
              </button>
            )}
          </header>
          {this.roeError.value && (
            <p class="border-b border-slate-800 bg-rose-950/40 px-4 py-1 text-[11px] text-rose-300">
              {this.roeError.value}
            </p>
          )}
          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            {this.filtered.value.length === 0 && (
              <p class="py-8 text-center text-xs text-slate-500">
                {j?.char
                  ? this.query.value
                    ? 'no matches'
                    : 'nothing logged yet — zone to refresh the journal'
                  : 'no journal data — log in and zone'}
              </p>
            )}
            {sel.kind === 'roe'
              ? this.roeGroups.value.map((cat) => this.roeCat(cat))
              : this.filtered.value.map((e) => this.entryRow(e))}
          </div>
        </section>

        {selEntry && this.detail(selEntry)}
      </div>
    );
  }
}
