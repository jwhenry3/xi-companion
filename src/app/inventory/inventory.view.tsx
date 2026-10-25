import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import { Sparkles } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import { FilterDropdown } from '@/components/ui/filter-dropdown';
import {
  host,
  detachedMode,
  tipAnchor,
  tooltipPinned,
  TooltipRef,
} from '../core/host';
import type { Bag, BagItem, ItemMeta } from '../core/types';
import { itemNameClass, flagDots } from '../core/item-flags';

const EQUIP_CATEGORIES = new Set(['Weapon', 'Armor']);

interface SelectedItem {
  bag: string;
  slot: number;
}

function isGear(meta?: ItemMeta) {
  return !!meta && (EQUIP_CATEGORIES.has(meta.category ?? '') || (meta.slots?.length ?? 0) > 0);
}

@Component()
export class InventoryView extends View {
  private api = inject(AddonApi);

  private q = signal('');
  private gearOnly = signal(false);
  private slotFilter = signal('');
  private catFilter = signal('');
  private equippedOnly = signal(false);
  private augOnly = signal(false);
  private bagFilter = signal('all');
  private sortKey = signal<'name' | 'level' | 'ilvl' | 'category' | 'subtype'>('name');
  private sortDir = signal<1 | -1>(1);
  private selected = signal<SelectedItem | null>(null);

  private catalog = computed(() => this.api.state.value?.catalog ?? {});
  private bags = computed(() => this.api.state.value?.bags ?? []);

  private allSlots = computed(() => {
    const set = new Set<string>();
    for (const meta of Object.values(this.catalog.value)) {
      for (const s of meta.slots ?? []) set.add(s);
    }
    return [...set].sort();
  });

  private allCategories = computed(() => {
    const set = new Set<string>();
    for (const meta of Object.values(this.catalog.value)) {
      if (meta.category) set.add(meta.category);
    }
    return [...set].sort();
  });

  private itemVisible(meta: ItemMeta | undefined, item: BagItem) {
    if (this.gearOnly.value && !isGear(meta)) return false;
    const sf = this.slotFilter.value;
    if (sf && !(meta?.slots ?? []).includes(sf)) return false;
    const cf = this.catFilter.value;
    if (cf && meta?.category !== cf) return false;
    if (this.equippedOnly.value && !item.equipped) return false;
    if (this.augOnly.value && !(item.augments && item.augments.length > 0)) return false;
    const q = this.q.value.trim().toLowerCase();
    if (q && !(meta?.name ?? `item ${item.id}`).toLowerCase().includes(q)) return false;
    return true;
  }

  private sortItems(items: BagItem[]): BagItem[] {
    const dir = this.sortDir.value;
    const cat = this.catalog.value;
    const val = (it: BagItem): string | number => {
      const meta = cat[it.id];
      switch (this.sortKey.value) {
        case 'level':
          return meta?.level ?? -1;
        case 'ilvl':
          return meta?.ilvl ?? -1;
        case 'category':
          return meta?.category ?? '';
        case 'subtype':
          return String(meta?.type ?? '');
        default:
          return (meta?.name ?? `item ${it.id}`).toLowerCase();
      }
    };
    return [...items].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb));
      return (
        c * dir ||
        (cat[a.id]?.name ?? '').localeCompare(cat[b.id]?.name ?? '') ||
        a.slot - b.slot
      );
    });
  }

  private sortBy(key: 'name' | 'level' | 'ilvl' | 'category' | 'subtype') {
    if (this.sortKey.value === key) this.sortDir.value = this.sortDir.value === 1 ? -1 : 1;
    else {
      this.sortKey.value = key;
      this.sortDir.value = 1;
    }
  }

  private sortHeader(key: 'name' | 'level' | 'ilvl' | 'category' | 'subtype', label: string, cls = '') {
    const active = this.sortKey.value === key;
    return (
      <th
        class={`cursor-pointer select-none px-2 py-1 hover:text-slate-300 ${cls}`}
        onClick={() => this.sortBy(key)}
        title="sort"
      >
        {label}
        {active && (
          <span class="ml-1 text-sky-400">{this.sortDir.value === 1 ? '▲' : '▼'}</span>
        )}
      </th>
    );
  }

  // storage picker: every bag the client reports, with counts. Unavailable
  // ones (locked wardrobes, Storage outside a mog house...) stay listed but
  // can't be picked — disabled, not hidden.
  private bagOptions = computed(() =>
    this.bags.value.map((b) => ({
      key: b.key,
      label:
        `${b.name} (${b.count ?? b.items.length}${b.max != null ? `/${b.max}` : ''})` +
        (b.enabled === false ? ' — unavailable' : ''),
      disabled: b.enabled === false,
    })),
  );

  private totalCount = computed(() =>
    this.bags.value.reduce((n, b) => n + (b.count ?? b.items.length), 0),
  );

  private visibleBags = computed(() => {
    const bf = this.bagFilter.value;
    const single = bf === 'all' ? undefined : this.bags.value.find((b) => b.key === bf);
    const shown = bf === 'all' ? this.bags.value : single ? [single] : [];
    return shown
      .map((bag) => ({
        bag,
        items: this.sortItems(
          bag.items.filter((it) => this.itemVisible(this.catalog.value[it.id], it)),
        ),
      }))
      // any section whose filtered item list is empty is hidden — the
      // "not available" hint above covers a disabled single-bag pick
      .filter(({ items }) => items.length > 0);
  });

  private bagAvailable = computed(() => {
    const bf = this.bagFilter.value;
    if (bf === 'all') return true;
    const b = this.bags.value.find((x) => x.key === bf);
    return b !== undefined && b.enabled !== false;
  });

  private itemRow(bag: Bag, item: BagItem) {
    const meta = this.catalog.value[item.id];
    const name = meta?.name ?? `item ${item.id}`;
    const isSel =
      this.selected.value?.bag === bag.key && this.selected.value?.slot === item.slot;
    const tip = (el: HTMLElement): TooltipRef => ({
      bag: bag.id,
      slot: item.slot,
      id: item.id,
      ...tipAnchor(el),
    });
    return (
      <tr
        key={`${bag.key}:${item.slot}`}
        onClick={(e) => {
          this.selected.value = { bag: bag.key, slot: item.slot };
          const el = e.currentTarget as HTMLElement;
          if (tooltipPinned.value) host.setTooltip(tip(el));
          else host.pinTooltip(tip(el));
        }}
        class={`cursor-pointer border-t border-slate-800 transition-colors ${
          isSel ? 'bg-sky-950/40' : 'hover:bg-slate-800/60'
        }`}
      >
        <td class="min-w-0 px-2 py-1">
          <span class="flex items-center gap-2">
            <img
              src={this.api.iconUrl(item.id)}
              class="h-6 w-6 shrink-0 rounded object-contain"
              // spawned WebView2 windows can start hidden/occluded —
              // lazy images never get their load scheduled there
              loading={detachedMode ? 'eager' : 'lazy'}
              alt=""
            />
            <span class={`truncate font-medium ${itemNameClass(meta) || 'text-slate-200'}`}>
              {item.equipped && <span class="mr-1 text-amber-400">*</span>}
              {name}
              {item.count > 1 && (
                <span class="ml-1 text-slate-500">×{item.count}</span>
              )}
              {flagDots(meta) && <span class="ml-1">{flagDots(meta)}</span>}
            </span>
          </span>
        </td>
        <td class="w-24 truncate px-2 py-1 text-slate-400">{meta?.category ?? ''}</td>
        <td class="w-10 px-2 py-1 text-slate-400">{meta?.level ?? ''}</td>
        <td class="w-10 px-2 py-1 text-indigo-300">{meta?.ilvl ?? ''}</td>
        <td class="w-10 px-2 py-1">
          {item.augments && (
            <span title="has augments — details in the item tooltip">
              <Sparkles size={11} class="inline text-fuchsia-300" />
            </span>
          )}
        </td>
      </tr>
    );
  }


  render() {
    const state = this.api.state.value;
    const connected = this.api.connected.value;
    return (
      <div class="flex h-full min-h-0 gap-4">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <div class="mb-4 flex flex-wrap items-center gap-3">
            <input
              class="w-64 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm placeholder:text-slate-600"
              placeholder="Search items…"
              value={this.q.value}
              onInput={(e) => (this.q.value = (e.target as HTMLInputElement).value)}
            />
            <FilterDropdown
              sections={[
                {
                  label: 'Slot',
                  value: this.slotFilter.value,
                  defaultValue: '',
                  options: [
                    { value: '', label: 'All slots' },
                    ...this.allSlots.value.map((s) => ({ value: s })),
                  ],
                  onChange: (v) => (this.slotFilter.value = v),
                },
                {
                  label: 'Type',
                  value: this.catFilter.value,
                  defaultValue: '',
                  options: [
                    { value: '', label: 'All types' },
                    ...this.allCategories.value.map((c) => ({ value: c })),
                  ],
                  onChange: (v) => (this.catFilter.value = v),
                },
                {
                  label: 'Storage',
                  value: this.bagFilter.value,
                  defaultValue: 'all',
                  options: [
                    { value: 'all', label: `All storage (${this.totalCount.value})` },
                    ...this.bagOptions.value.map((b) => ({
                      value: b.key,
                      label: b.label,
                      disabled: b.disabled,
                    })),
                  ],
                  onChange: (v) => (this.bagFilter.value = v),
                },
              ]}
              toggles={[
                {
                  label: 'Equipment only',
                  checked: this.gearOnly.value,
                  onChange: (v) => (this.gearOnly.value = v),
                },
                {
                  label: 'Equipped',
                  checked: this.equippedOnly.value,
                  onChange: (v) => (this.equippedOnly.value = v),
                },
                {
                  label: 'Augmented',
                  checked: this.augOnly.value,
                  onChange: (v) => (this.augOnly.value = v),
                },
              ]}
            />
            {!connected && (
              <span class="text-xs text-rose-400">addon disconnected — waiting…</span>
            )}
          </div>

          <div class="min-h-0 flex-1 overflow-auto pr-1">
            {!state && (
              <p class="text-sm text-slate-400">
                {connected
                  ? 'Loading inventory…'
                  : 'Not connected. Load the addon in game and it will stream inventory here.'}
              </p>
            )}

            {state && !this.bagAvailable.value && (
              <p class="text-sm text-rose-400">
                {this.bags.value.find((b) => b.key === this.bagFilter.value)?.name ??
                  this.bagFilter.value}{' '}
                is not available
              </p>
            )}

            {state && this.bagAvailable.value && this.visibleBags.value.length === 0 && (
              <p class="text-sm text-slate-400">No items match the current filters.</p>
            )}

            {this.visibleBags.value.map(({ bag, items }) => (
              <section key={bag.id} class="mb-6">
                <h2 class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {bag.name} <span class="font-normal">({items.length}/{bag.max})</span>
                  {bag.enabled === false && (
                    <span class="font-normal text-rose-400"> — unavailable</span>
                  )}
                </h2>
                {/* min-w keeps the fixed columns legible — narrow windows
                    scroll sideways instead of crushing the name column */}
                <table class="w-full min-w-[26rem] table-fixed text-left text-xs">
                  <thead>
                    <tr class="text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                      {this.sortHeader('name', 'Item')}
                      {this.sortHeader('category', 'Type', 'w-24')}
                      {this.sortHeader('level', 'Lv', 'w-10')}
                      {this.sortHeader('ilvl', 'iLv', 'w-10')}
                      <th class="w-10 px-2 py-1">Aug</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => this.itemRow(bag, it))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        </div>
      </div>
    );
  }
}
