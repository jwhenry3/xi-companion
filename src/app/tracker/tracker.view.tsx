// Quest tracker: the fab-layer overlay window (/tracker?window=1).
// A compact, mostly-transparent list of what's actually in progress —
// current missions, accepted quests, tracked RoE objectives — fed live
// by the same `journal` SSE signal as the journal view. Clicking a row
// posts xic:main:<path> so the main window surfaces on that journal
// entry; the tracker itself stays up.
import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import type { JournalNames } from '../core/types';
import {
  MISSION_ORDER,
  QUEST_ORDER,
  groupKey,
  hasActivity,
  trackKey,
} from '../journal/activity';
import { cn } from '@/lib/utils';

interface TrackItem {
  kind: 'mission' | 'quest' | 'roe' | 'valor';
  /** group key for the journal deep link (storyline / quest area) */
  key: string;
  id: number;
  /** section label — storyline or area name */
  group: string;
  name: string;
  progress?: number;
  target?: number;
  limited?: boolean;
}

@Component()
export class TrackerView extends View implements OnInit {
  private api = inject(AddonApi);
  private names = signal<JournalNames | null>(null);

  onInit() {
    void Promise.all([this.api.refreshJournal(), this.api.journalNames()]).then(
      ([, n]) => (this.names.value = n),
    );
  }

  private items = computed<TrackItem[]>(() => {
    const j = this.api.journal.value;
    const names = this.names.value;
    // entries the player hid from the tracker on the journal page —
    // 'kind:key:id' singles, or 'kind:key' to suppress a whole group
    // (new items in it stay hidden too)
    const hidden = new Set(j?.untracked ?? []);
    const out: TrackItem[] = [];

    for (const key of MISSION_ORDER) {
      const grp = names?.mission_lines?.[key];
      if (!grp || !hasActivity(j, names, 'mission', key)) continue;
      if (hidden.has(groupKey('mission', key))) continue;
      const id = j!.missions[key].current!;
      if (hidden.has(trackKey('mission', key, id))) continue;
      out.push({
        kind: 'mission',
        key,
        id,
        group: grp.name,
        name: grp.ids?.[String(id)]?.n ?? `Mission #${id}`,
      });
    }

    for (const key of QUEST_ORDER) {
      const grp = names?.quest_areas?.[key];
      const area = j?.quests?.[key];
      if (!grp || !area || hidden.has(groupKey('quest', key))) continue;
      const done = new Set(area.done ?? []);
      for (const id of area.current ?? []) {
        if (done.has(id) || hidden.has(trackKey('quest', key, id))) continue;
        out.push({
          kind: 'quest',
          key,
          id,
          group: grp.name,
          name: grp.ids?.[String(id)]?.n ?? `Quest #${id}`,
        });
      }
    }

    const doneRoe = new Set(j?.roe?.done ?? []);
    const roeActive = hidden.has(groupKey('roe', 'roe'))
      ? []
      : (j?.roe?.active ?? []);
    for (const a of roeActive) {
      if (doneRoe.has(a.id) || hidden.has(trackKey('roe', 'roe', a.id)))
        continue;
      const meta = names?.roe?.[String(a.id)];
      out.push({
        kind: 'roe',
        key: 'roe',
        id: a.id,
        group:
          (meta?.c != null && names?.roe_categories?.[String(meta.c)]) ||
          'RoE',
        name: meta?.n ?? `Objective #${a.id}`,
        progress: a.progress,
        target: meta?.t,
        limited: a.limited,
      });
    }

    // active training regime — a single row; 'valor:valor' hides it
    const v = j?.valor;
    if (v && !hidden.has(groupKey('valor', 'valor'))) {
      const progress = (v.killed ?? []).reduce((a, b) => a + b, 0);
      const target = (v.needs ?? []).reduce((a, b) => a + b, 0);
      out.push({
        kind: 'valor',
        key: 'valor',
        id: 0,
        group: v.kind === 'fov' ? 'Fields of Valor' : 'Grounds of Valor',
        name:
          `${v.zone_name ?? `zone ${v.zone}`} — Page ${v.page}` +
          (v.done ? ' ✓' : ''),
        progress: target > 0 ? progress : v.last?.killed,
        target: target > 0 ? target : v.last?.needed,
      });
    }
    return out;
  });

  private open(it: TrackItem) {
    const id = it.kind === 'valor' ? '' : `&id=${it.id}`;
    host.showInMain(`/journal?g=${it.kind}&s=${it.key}${id}`);
  }

  private row(it: TrackItem) {
    return (
      <button
        key={`${it.kind}:${it.key}:${it.id}`}
        class="w-full rounded px-2 py-1 text-left hover:bg-slate-800"
        title="show in journal"
        onClick={() => this.open(it)}
      >
        <span class="block truncate text-[9px] font-semibold uppercase tracking-wider text-sky-400/80">
          {it.group}
          {it.limited && <span class="text-amber-400/80"> · limited</span>}
        </span>
        <span class="flex items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate text-xs text-slate-100">
            {it.name}
          </span>
          {it.progress != null && (
            <span class="w-10 shrink-0 text-right text-[9px] tabular-nums text-slate-300">
              {it.target ? `${Math.min(it.progress, it.target)}/${it.target}` : it.progress}
            </span>
          )}
        </span>
        {it.progress != null && (
          <span class="mt-0.5 block h-1 overflow-hidden rounded bg-slate-800/80">
            <span
              class="block h-full rounded bg-sky-400/80"
              style={`width:${Math.min(
                100,
                it.target
                  ? (it.progress / it.target) * 100
                  : it.progress
                    ? 100
                    : 0,
              )}%`}
            />
          </span>
        )}
      </button>
    );
  }

  render() {
    const items = this.items.value;
    const missions = items.filter((i) => i.kind === 'mission');
    const quests = items.filter((i) => i.kind === 'quest');
    const roe = items.filter((i) => i.kind === 'roe');
    const valor = items.filter((i) => i.kind === 'valor');
    const section = (label: string, list: TrackItem[]) =>
      list.length > 0 && (
        <div class="mb-1">
          <p class="px-1 pb-0.5 text-[9px] font-bold tracking-widest text-slate-400/70">
            {label}
          </p>
          <div class="space-y-0.5">{list.map((it) => this.row(it))}</div>
        </div>
      );
    return (
      <div
        class={cn(
          // opaque card (provided by the shell chrome) — never scrolls
          // sideways
          'h-full overflow-y-auto overflow-x-hidden p-1',
          items.length === 0 && 'flex items-center justify-center',
        )}
      >
        {items.length === 0 ? (
          <p class="px-2 py-1 text-[10px] text-slate-400">
            {this.api.journal.value?.char
              ? 'nothing in progress'
              : 'log in to track'}
          </p>
        ) : (
          <>
            {section('Missions', missions)}
            {section('Quests', quests)}
            {section('Objectives', roe)}
            {section('Training', valor)}
          </>
        )}
      </div>
    );
  }
}
