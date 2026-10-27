import { Component, View, inject, signal } from '@preact-mvc/core';
import type { OnInit } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { SetsStore, GROUP_OPTIONS, setLabel } from '../sets/sets.store';
import { Select, type SelectOption } from '@/components/ui/select';
import { Button } from '@/components/ui/button';

// Segment picker options per path depth, derived from GROUP_OPTIONS' dotted
// values: 'precast.FC.Trust' contributes root 'precast', child 'FC' under
// 'precast', and 'Trust' under 'precast.FC'. Custom segments (spell names
// like 'Cure IV') are typed via the combobox filter.
const TYPE_TREE = (() => {
  const roots = new Set<string>();
  const children = new Map<string, Set<string>>();
  for (const s of GROUP_OPTIONS) {
    for (const v of s.values) {
      const segs = v.split('.').filter(Boolean);
      segs.forEach((seg, i) => {
        if (i === 0) {
          roots.add(seg);
        } else {
          const parent = segs.slice(0, i).join('.');
          let set = children.get(parent);
          if (!set) children.set(parent, (set = new Set()));
          set.add(seg);
        }
      });
    }
  }
  return { roots: [...roots].sort(), children };
})();

function segOptions(path: string[]): SelectOption[] {
  const list =
    path.length === 0
      ? TYPE_TREE.roots
      : [...(TYPE_TREE.children.get(path.join('.')) ?? [])];
  return list.map((v) => ({ value: v }));
}

function joinSegs(segs: string[]): string {
  return segs.filter((s) => s.trim() !== '').join('.');
}

@Component()
export class BindingsView extends View implements OnInit {
  private api = inject(AddonApi);
  private store = inject(SetsStore);

  /** key whose row is picking an extra trailing segment */
  private tailEdit = signal<string | null>(null);
  /** draft rule under construction */
  private draftSegs = signal<string[]>([]);
  private draftSet = signal('');

  onInit() {
    if (this.api.files.value == null) void this.api.refreshFiles();
    this.store.init();
  }

  private setOptions(): SelectOption[] {
    return this.store.sets().map((s) => ({ value: s.id, label: setLabel(s) }));
  }

  private segPicker(
    pathPrefix: string[],
    value: string,
    key: string,
    onPick: (v: string) => void,
    w = 'w-32',
  ) {
    return (
      <Select
        key={key}
        className={w}
        value={value}
        placeholder="type…"
        filterable
        allowCustom
        options={segOptions(pathPrefix)}
        onChange={onPick}
      />
    );
  }

  private ruleRow(key: string) {
    const segs = key.split('.').filter(Boolean);
    const bound = this.store.curFile()?.bindings[key];
    const rekey = (next: string[]) => {
      const nk = joinSegs(next);
      if (nk !== '' && this.store.rebind(key, nk)) this.tailEdit.value = null;
    };
    return (
      <div
        key={key}
        class="flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900 px-3 py-2"
      >
        <span class="w-10 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          when
        </span>
        {segs.map((seg, i) => (
          <span key={`${key}:${i}`} class="flex items-center gap-1.5">
            {i > 0 && <span class="text-slate-600">›</span>}
            {this.segPicker(segs.slice(0, i), seg, `${key}:${i}`, (v) =>
              rekey([...segs.slice(0, i), v, ...segs.slice(i + 1)]),
            )}
          </span>
        ))}

        {this.tailEdit.value === key ? (
          this.segPicker(segs, '', 'tail', (v) => {
            this.tailEdit.value = null;
            rekey([...segs, v]);
          })
        ) : (
          <button
            class="rounded px-1 text-xs text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            title="add a deeper segment"
            onClick={() => (this.tailEdit.value = key)}
          >
            +
          </button>
        )}
        {segs.length > 1 && (
          <button
            class="rounded px-1 text-xs text-slate-500 hover:bg-slate-800 hover:text-rose-300"
            title={`drop last segment → ${segs.slice(0, -1).join('.')}`}
            onClick={() => rekey(segs.slice(0, -1))}
          >
            −
          </button>
        )}

        <span class="flex-1" />
        <span class="w-10 shrink-0 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          equip
        </span>
        <Select
          className="w-48"
          value={bound ?? ''}
          placeholder={bound === undefined ? '(missing)' : 'set…'}
          options={this.setOptions()}
          onChange={(v) => this.store.bind(key, v)}
        />
        <button
          class="rounded px-1 text-xs text-slate-500 hover:bg-slate-800 hover:text-rose-300"
          title={`unbind ${key}`}
          onClick={() => this.store.unbind(key)}
        >
          ×
        </button>
      </div>
    );
  }

  private draftRow() {
    const segs = this.draftSegs.value;
    const ready = segs.length > 0 && segs.every((s) => s.trim() !== '') && this.draftSet.value !== '';
    const setSeg = (i: number, v: string) => {
      const next = [...segs];
      next[i] = v;
      this.draftSegs.value = next;
    };
    return (
      <div class="flex items-center gap-1.5 rounded border border-dashed border-slate-600 bg-slate-900/60 px-3 py-2">
        <span class="w-10 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          when
        </span>
        {(segs.length === 0 ? [''] : segs).map((seg, i) => (
          <span key={i} class="flex items-center gap-1.5">
            {i > 0 && <span class="text-slate-600">›</span>}
            {this.segPicker(segs.slice(0, i), seg, `draft:${i}`, (v) => setSeg(i, v))}
          </span>
        ))}
        {segs.length > 0 && segs.every((s) => s.trim() !== '') && (
          <button
            class="rounded px-1 text-xs text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            title="add a deeper segment"
            onClick={() => (this.draftSegs.value = [...segs, ''])}
          >
            +
          </button>
        )}

        <span class="flex-1" />
        <span class="w-10 shrink-0 text-right text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          equip
        </span>
        <Select
          className="w-48"
          value={this.draftSet.value}
          placeholder="set…"
          options={this.setOptions()}
          onChange={(v) => (this.draftSet.value = v)}
        />
        <Button
          variant="secondary"
          size="xs"
          disabled={!ready}
          onClick={() => {
            this.store.bind(joinSegs(segs), this.draftSet.value);
            this.draftSegs.value = [];
            this.draftSet.value = '';
          }}
        >
          bind
        </Button>
        <button
          class="rounded px-1 text-xs text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          onClick={() => {
            this.draftSegs.value = [];
            this.draftSet.value = '';
          }}
        >
          ×
        </button>
      </div>
    );
  }

  render() {
    const store = this.store;
    const noFile = store.activeFile.value == null;
    const keys = store.bindingKeys();
    const drafting = this.draftSegs.value.length > 0 || this.draftSet.value !== '';
    return (
      <div class="flex h-full min-h-0 flex-col">
        <div class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3">
          {noFile && (
            <p class="text-sm text-slate-500">
              Select a GearSwap profile above — bindings map set types like
              <code class="mx-1 text-sky-300">idle.Town</code> or
              <code class="mx-1 text-sky-300">midcast.Cure IV</code> to that
              profile's sets.
            </p>
          )}
          {!noFile && keys.length === 0 && !drafting && (
            <p class="text-sm text-slate-500">
              No bindings in {store.activeFile.value} yet. Add a rule below —
              each is a set-type path (deeper = more specific) bound to a set.
            </p>
          )}
          {keys.map((key) => this.ruleRow(key))}
          {drafting ? (
            this.draftRow()
          ) : (
            !noFile && (
              <button
                class="rounded border border-dashed border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
                onClick={() => (this.draftSegs.value = [''])}
              >
                + new rule
              </button>
            )
          )}
        </div>
      </div>
    );
  }
}
