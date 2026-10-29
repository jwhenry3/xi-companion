import { Component, View, inject, signal, computed, effect } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { FilterDropdown } from '@/components/ui/filter-dropdown';
import { Input } from '@/components/ui/input';
import { TabBar, Tab } from '../core/tabs';
import {
 host,
 detachedMode,
 tipAnchorOutside,
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

const FILTER_KEY = 'xicompanion.inv.filters';

@Component()
export class InventoryView extends View implements OnInit, OnDestroy {
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
 private disposeFx?: () => void;

 onInit() {
 try {
 const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null');
 if (f) {
 if (typeof f.q === 'string') this.q.value = f.q;
 this.gearOnly.value = !!f.gearOnly;
 this.equippedOnly.value = !!f.equippedOnly;
 this.augOnly.value = !!f.augOnly;
 if (typeof f.slotFilter === 'string') this.slotFilter.value = f.slotFilter;
 if (typeof f.catFilter === 'string') this.catFilter.value = f.catFilter;
 if (typeof f.bagFilter === 'string') this.bagFilter.value = f.bagFilter;
 if (typeof f.sortKey === 'string')
 this.sortKey.value = f.sortKey as typeof this.sortKey.value;
 this.sortDir.value = f.sortDir === -1 ? -1 : 1;
 }
 } catch {
 // fresh state
 }
 this.disposeFx = effect(() => {
 localStorage.setItem(
 FILTER_KEY,
 JSON.stringify({
 q: this.q.value,
 gearOnly: this.gearOnly.value,
 equippedOnly: this.equippedOnly.value,
 augOnly: this.augOnly.value,
 slotFilter: this.slotFilter.value,
 catFilter: this.catFilter.value,
 bagFilter: this.bagFilter.value,
 sortKey: this.sortKey.value,
 sortDir: this.sortDir.value,
 }),
 );
 });
 }

 onDestroy() {
 this.disposeFx?.();
 }

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
 // Weapon + Armor collapse into one 'Equipment' bucket —
 // filtering one at a time was never useful, they overlap
 // every slot anyway
 if (meta.category)
   set.add(EQUIP_CATEGORIES.has(meta.category) ? 'Equipment' : meta.category);
 }
 return [...set].sort();
 });

 private itemVisible(meta: ItemMeta | undefined, item: BagItem) {
 if (this.gearOnly.value && !isGear(meta)) return false;
 const sf = this.slotFilter.value;
 if (sf && !(meta?.slots ?? []).includes(sf)) return false;
 const cf = this.catFilter.value;
 if (cf === 'Equipment'
   ? !EQUIP_CATEGORIES.has(meta?.category ?? '')
   : cf && meta?.category !== cf)
   return false;
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
 class={` select-none px-2 py-1 hover:text-slate-300 ${cls}`}
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

 /** per-bag selected type tab — '' shows every group stacked */
 private typeTabs = signal<Record<string, string>>({});

 private bagAvailable = computed(() => {
 const bf = this.bagFilter.value;
 if (bf === 'all') return true;
 const b = this.bags.value.find((x) => x.key === bf);
 return b !== undefined && b.enabled !== false;
 });

 /** items bucketed by catalog category, groups alphabetical —
 * members keep the table sort order */
 private groupedItems(items: BagItem[]): [string, BagItem[]][] {
 const cat = this.catalog.value;
 const map = new Map<string, BagItem[]>();
 for (const it of items) {
 const c = cat[it.id]?.category ?? '';
 const g = map.get(c);
 if (g) g.push(it);
 else map.set(c, [it]);
 }
 return [...map.entries()].sort(
 ([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)),
 );
 }

 private itemRow(bag: Bag, item: BagItem) {
 const meta = this.catalog.value[item.id];
 const name = meta?.name ?? `item ${item.id}`;
 const isSel =
 this.selected.value?.bag === bag.key && this.selected.value?.slot === item.slot;
 const tip = (el: HTMLElement): TooltipRef => ({
 bag: bag.id,
 slot: item.slot,
 id: item.id,
 ...tipAnchorOutside(el),
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
 class={` border-t border-slate-800 transition-colors ${
 isSel ? 'bg-sky-950/40' : 'hover:bg-slate-800/60'
 }`}
 >
 <td class="w-14 whitespace-nowrap px-2 py-1 text-[11px] tabular-nums text-slate-400">
 {meta?.level ?? ''}
 {/* ilvl sorts from its own number — the column header sorts
 by level */}
 {meta?.ilvl != null && (
 <span
 class=" text-indigo-300 hover:text-indigo-200"
 title="sort by item level"
 onClick={(e) => {
 e.stopPropagation();
 this.sortBy('ilvl');
 }}
 >
 /{meta.ilvl}
 </span>
 )}
 </td>
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
 <Input
 class="w-64"
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
 {(() => {
 const groups = this.groupedItems(items);
 const picked = this.typeTabs.value[bag.key] ?? '';
 // a picked type can vanish under the filters — fall
 // back to 'all' instead of showing nothing
 const sel =
 picked === '' || groups.some(([c]) => c === picked)
 ? picked
 : '';
 const setTab = (v: string) =>
 (this.typeTabs.value = {
 ...this.typeTabs.value,
 [bag.key]: v,
 });
 const shown =
 sel === '' ? groups : groups.filter(([c]) => c === sel);
 return (
 <>
 <TabBar class="mb-3">
 <Tab active={sel === ''} onClick={() => setTab('')}>
 all
 </Tab>
 {groups.map(([cat, g]) => (
 <Tab
 key={cat || '__other'}
 active={sel === cat}
 onClick={() => setTab(cat)}
 >
 {cat || 'other'} ({g.length})
 </Tab>
 ))}
 </TabBar>
 {shown.map(([cat, group]) => (
 <div key={cat || '__other'} class="mb-4 last:mb-0">
 {/* the active tab already names the type — only
 label groups in the stacked 'all' view */}
 {sel === '' && (
 <h3 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
 {cat || 'other'}{' '}
 <span class="font-normal">({group.length})</span>
 </h3>
 )}
 {/* min-w keeps the fixed columns legible —
 narrow windows scroll sideways instead of
 crushing the name column */}
 <table class="w-full table-fixed text-left text-xs">
 <thead>
 <tr class="text-[10px] font-semibold uppercase tracking-wider text-slate-600">
 {this.sortHeader('level', 'Lv/iLv', 'w-14')}
 {this.sortHeader('name', 'Item')}
 </tr>
 </thead>
 <tbody>
 {group.map((it) => this.itemRow(bag, it))}
 </tbody>
 </table>
 </div>
 ))}
 </>
 );
 })()}
 </section>
 ))}
 </div>
 </div>
 </div>
 );
 }
}
