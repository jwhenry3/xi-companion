import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import {
 SetsStore,
 EQUIP_SLOTS,
 setLabel,
 resolveItem,
 itemMatches,
 normAugs,
} from './sets.store';
import type { GearSetDef } from './sets.store';
import type { Bag, BagItem } from '../core/types';
import { itemNameClass, flagDots } from '../core/item-flags';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PencilIcon, Trash2Icon } from 'lucide-preact';
import { PanelShell, PanelSidebar } from '../core/panel';

import { host, detachedMode, tipAnchorOutside, tooltipPinned, TooltipRef } from '../core/host';

@Component()
export class SetsView extends View implements OnInit {
 private api = inject(AddonApi);
 private store = inject(SetsStore);

 private selectedSlot = signal('main');
 private pickerBag = signal('all');
 private pickerQuery = signal('');
 private newSetName = signal('');
 private addOpen = signal(false);
 private renameId = signal<string | null>(null);
 private renameDraft = signal('');
 private deleteId = signal<string | null>(null);

 /** click pins the tooltip (or retargets an already-pinned window) */
 private tipClick(e: Event, tip: (el: HTMLElement) => TooltipRef | null) {
 const t = tip(e.currentTarget as HTMLElement);
 if (!t) return;
 if (tooltipPinned.value) host.setTooltip(t);
 else host.pinTooltip(t);
 }

 private catalog = computed(() => this.api.state.value?.catalog ?? {});
 private bags = computed(() => this.api.state.value?.bags ?? []);
 private st = computed(() => this.api.state.value);

 onInit() {
 if (this.api.files.value == null) void this.api.refreshFiles();
 // read the active profile's sets.* when its scope is still empty
 this.store.init();
 }

 private slotDef(key: string) {
 return EQUIP_SLOTS.find((s) => s.key === key)!;
 }

 private pickerBags = computed(() => {
 const slot = this.slotDef(this.selectedSlot.value);
 const q = this.pickerQuery.value.trim().toLowerCase();
 const bagFilter = this.pickerBag.value;
 return this.bags.value
 .filter((b) => bagFilter === 'all' || b.key === bagFilter)
 .map((bag) => ({
 bag,
 items: bag.items.filter((it) => {
 const meta = this.catalog.value[it.id];
 if (!(meta?.slots ?? []).includes(slot.res)) return false;
 if (q && !(meta?.name ?? `item ${it.id}`).toLowerCase().includes(q)) return false;
 return true;
 }),
 }))
 .filter(({ items }) => items.length > 0);
 });

 private bagNames = computed(() => this.bags.value.map((b) => ({ key: b.key, name: b.name })));

 private assign(item: BagItem, bag: Bag) {
 const set = this.store.activeSet();
 if (!set) return;
 const meta = this.catalog.value[item.id];
 this.store.assign(set.id, this.selectedSlot.value, {
 bag: bag.key,
 slot: item.slot,
 id: item.id,
 name: meta?.name ?? `item ${item.id}`,
 aug: normAugs(item.augments),
 });
 }

 private async equip(set: GearSetDef) {
 const key = this.store.bindingsOf(set.id)[0];
 if (key === undefined) return;
 try {
 await this.api.sendCommand(`gs equip sets.${key}`);
 this.store.flash(
 `gs equip sets.${key}` + (this.store.dirty.value ? ' — unsaved edits not included' : ''),
 );
 } catch (e) {
 this.store.flash(`equip failed: ${e}`);
 }
 }

 private icon(id: number | undefined, cls = 'h-9 w-9') {
 if (id === undefined || id <= 0) {
 return <span class={`${cls} inline-block rounded bg-slate-800`} />;
 }
 return (
 <img
 src={this.api.iconUrl(id)}
 class={`${cls} rounded object-contain`}
 loading={detachedMode ? 'eager' : 'lazy'}
 alt=""
 />
 );
 }

 // ---- middle column ---------------------------------------------------------

 private slotCell(key: string) {
 const set = this.store.activeSet();
 const def = this.slotDef(key);
 const ref = set?.slots[key];
 const resolved = ref && this.st.value ? resolveItem(this.st.value, ref) : null;
 const missing = !!ref && !resolved?.item;
 const sel = this.selectedSlot.value === key;
 const iconId = resolved?.item?.id ?? ref?.id;
 const tip = (el: HTMLElement): TooltipRef | null => {
 if (resolved?.item && resolved?.bag)
 return {
 bag: resolved.bag.id,
 slot: resolved.item.slot,
 id: resolved.item.id,
 ...tipAnchorOutside(el),
 };
 if (iconId) return { bag: -1, slot: -1, id: iconId, name: ref?.name, ...tipAnchorOutside(el) };
 return null;
 };
 return (
 <div
 key={key}
 onClick={(e) => {
 this.selectedSlot.value = key;
 this.tipClick(e, tip);
 }}
 class={`group relative aspect-square rounded border p-1 transition-colors ${
 sel
 ? 'border-sky-500 bg-sky-950/50'
 : ref
 ? 'border-emerald-800 bg-slate-900 hover:border-slate-500'
 : 'border-slate-800 bg-slate-950 hover:border-slate-600'
 }`}
 title={ref ? `${def.res}: ${ref.name}` : `${def.res}: empty`}
 >
 <span class="absolute left-1 top-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
 {def.label}
 </span>
 <div class="flex h-full items-center justify-center pt-2">
 {ref ? (
 this.icon(iconId, 'h-3/5 w-3/5')
 ) : (
 <span class="text-sm text-slate-700">–</span>
 )}
 </div>
 {missing && (
 <span class="absolute bottom-0.5 right-1 text-[10px] font-bold text-rose-400">!</span>
 )}
 {ref && set && (
 <button
 class="absolute right-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded text-[10px] leading-none text-slate-500 hover:bg-slate-700 hover:text-rose-300 group-hover:flex"
 onClick={(e) => {
 e.stopPropagation();
 this.store.assign(set.id, key, null);
 }}
 title={`clear ${def.label}`}
 >
 ×
 </button>
 )}
 </div>
 );
 }

 // ---- right column ------------------------------------------------------------

 private pickerItem(bag: Bag, item: BagItem) {
 const meta = this.catalog.value[item.id];
 const set = this.store.activeSet();
 const st = this.st.value;
 const usedSlot =
 set && st
 ? Object.entries(set.slots).find(
 ([, r]) => r && itemMatches(st, item, r),
 )?.[0]
 : undefined;
 const tip = (el: HTMLElement): TooltipRef => ({
 bag: bag.id,
 slot: item.slot,
 id: item.id,
 ...tipAnchorOutside(el),
 });
 return (
 <button
 key={`${bag.key}:${item.slot}`}
 onClick={(e) => {
 this.assign(item, bag);
 this.tipClick(e, tip);
 }}
 class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-slate-300 hover:bg-slate-800"
 >
 {this.icon(item.id, 'h-7 w-7 shrink-0')}
 <span
 class={`min-w-0 flex-1 leading-tight ${itemNameClass(meta)}`}
 >
 {item.equipped && <span class="mr-1 text-amber-400">*</span>}
 {meta?.name ?? `item ${item.id}`}
 {flagDots(meta) && <span class="ml-1">{flagDots(meta)}</span>}
 </span>
 {usedSlot && (
 <span class="rounded bg-sky-950 px-1 py-0.5 text-[9px] text-sky-300">{usedSlot}</span>
 )}
 {meta?.ilvl != null && (
 <span class="rounded bg-indigo-900 px-1 py-0.5 text-[9px] text-indigo-200">
 i{meta.ilvl}
 </span>
 )}
 {item.augments && (
 <span class="rounded bg-fuchsia-950 px-1 py-0.5 text-[9px] text-fuchsia-300">aug</span>
 )}
 <span class="text-[11px] text-slate-600">[{item.slot}]</span>
 </button>
 );
 }


 // ---- root ---------------------------------------------------------------------

 render() {
 const store = this.store;
 const set = store.activeSet();
 const sel = this.slotDef(this.selectedSlot.value);
 const connected = this.api.connected.value;
 return (
 <PanelShell>

 <div class="flex min-h-0 flex-1 gap-4 pr-3">
 {/* left: set list */}
 <PanelSidebar class="w-44">
 <div class="flex items-center justify-between border-b border-slate-800 px-2 py-1">
 <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
 sets
 </span>
 <Button
 variant="secondary"
 size="xs"
 title="new set"
 disabled={store.activeFile.value == null}
 onClick={() => {
 this.newSetName.value = '';
 this.addOpen.value = true;
 }}
 >
 +
 </Button>
 </div>
 <div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1">
 {store.sets().map((s) => {
 const bound = store.bindingsOf(s.id);
 const active = s.id === store.activeId.value;
 return (
 <div
 key={s.id}
 onClick={() => store.setActive(s.id)}
 class={`group flex items-center gap-1 rounded px-2 py-1.5 text-xs leading-tight ${
 active
 ? 'bg-sky-950 text-sky-200'
 : 'text-slate-300 hover:bg-slate-800'
 }`}
 >
 <span class="min-w-0 flex-1">
 <span class="block truncate font-medium">{setLabel(s)}</span>
 {bound.length > 0 && (
 <span
 class={`block truncate text-[10px] ${active ? 'text-sky-400' : 'text-slate-500'}`}
 >
 {bound.join(', ')}
 </span>
 )}
 </span>
 <button
 title="rename"
 class="hidden shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-700 hover:text-slate-200 group-hover:block"
 onClick={(e) => {
 e.stopPropagation();
 this.renameDraft.value = s.name;
 this.renameId.value = s.id;
 }}
 >
 <PencilIcon class="size-3.5" />
 </button>
 <button
 title="delete"
 class="hidden shrink-0 rounded p-0.5 text-slate-500 hover:bg-slate-700 hover:text-rose-300 group-hover:block"
 onClick={(e) => {
 e.stopPropagation();
 this.deleteId.value = s.id;
 }}
 >
 <Trash2Icon class="size-3.5" />
 </button>
 </div>
 );
 })}
 {store.sets().length === 0 && (
 <p class="px-2 py-1 text-xs text-slate-600">no sets yet</p>
 )}
 </div>
 </PanelSidebar>

 {/* middle: rename/actions + grid */}
 <div class="min-h-0 w-80 shrink-0 overflow-y-auto pr-3">
 {set ? (
 <div class="mb-2 flex items-center gap-1">
 <span class="min-w-0 flex-1 truncate px-1 text-xs font-semibold text-slate-200">
 {setLabel(set)}
 </span>
 <Button
 variant="secondary"
 size="xs"
 disabled={store.bindingsOf(set.id).length === 0}
 title={
 store.bindingsOf(set.id).length === 0
 ? 'bind it in the Bindings tab first'
 : `gs equip sets.${store.bindingsOf(set.id)[0]}`
 }
 onClick={() => void this.equip(set)}
 >
 equip
 </Button>
 </div>
 ) : null}
 <div class="mx-auto grid w-64 grid-cols-4 gap-1.5">
 {EQUIP_SLOTS.map((s) => this.slotCell(s.key))}
 </div>
 </div>

 {/* right: item picker + detail */}
 <div class="flex min-h-0 min-w-0 flex-1 flex-col">
 <div class="mb-2 flex items-center gap-2">
 <span class="flex-1" />
 <Input
 class="w-40"
 placeholder="filter…"
 value={this.pickerQuery.value}
 onInput={(e) => (this.pickerQuery.value = (e.target as HTMLInputElement).value)}
 />
 <Select
 className="w-40"
 value={this.pickerBag.value}
 options={[
 { value: 'all', label: 'all storage' },
 ...this.bagNames.value.map((b) => ({ value: b.key, label: b.name })),
 ]}
 onChange={(v) => (this.pickerBag.value = v)}
 />
 </div>
 {!connected && (
 <p class="text-xs text-rose-400">addon disconnected — inventory unavailable</p>
 )}
 <div class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
 {this.pickerBags.value.map(({ bag, items }) => (
 <section key={bag.key}>
 <h3 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
 {bag.name} ({items.length})
 </h3>
 <div class="rounded border border-slate-800 bg-slate-900 p-1">
 {items.map((it) => this.pickerItem(bag, it))}
 </div>
 </section>
 ))}
 {connected && this.pickerBags.value.length === 0 && (
 <p class="text-xs text-slate-500">No items fit the {sel.res} slot.</p>
 )}
 </div>
 </div>
 </div>

 {/* new-set dialog */}
 {this.addOpen.value && (
 <div
 class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
 onClick={() => (this.addOpen.value = false)}
 >
 <div
 class="w-72 rounded border border-slate-600 bg-slate-900 p-4 shadow-xl"
 onClick={(e) => e.stopPropagation()}
 >
 <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
 New set
 </h3>
 <Input
 autofocus
 placeholder="set name"
 value={this.newSetName.value}
 onInput={(e) =>
 (this.newSetName.value = (e.target as HTMLInputElement).value)
 }
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 store.create(this.newSetName.value);
 this.newSetName.value = '';
 this.addOpen.value = false;
 } else if (e.key === 'Escape') {
 this.addOpen.value = false;
 }
 }}
 />
 <div class="mt-3 flex justify-end gap-2">
 <Button
 variant="ghost"
 size="sm"
 onClick={() => (this.addOpen.value = false)}
 >
 cancel
 </Button>
 <Button
 size="sm"
 onClick={() => {
 store.create(this.newSetName.value);
 this.newSetName.value = '';
 this.addOpen.value = false;
 }}
 >
 create
 </Button>
 </div>
 </div>
 </div>
 )}

 {/* rename dialog */}
 {this.renameId.value != null && (
 <div
 class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
 onClick={() => (this.renameId.value = null)}
 >
 <div
 class="w-72 rounded border border-slate-600 bg-slate-900 p-4 shadow-xl"
 onClick={(e) => e.stopPropagation()}
 >
 <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
 Rename set
 </h3>
 <Input
 autofocus
 placeholder="set name"
 value={this.renameDraft.value}
 onInput={(e) =>
 (this.renameDraft.value = (e.target as HTMLInputElement).value)
 }
 onKeyDown={(e) => {
 if (e.key === 'Enter') {
 store.rename(this.renameId.value!, this.renameDraft.value);
 this.renameId.value = null;
 } else if (e.key === 'Escape') {
 this.renameId.value = null;
 }
 }}
 />
 <div class="mt-3 flex justify-end gap-2">
 <Button
 variant="ghost"
 size="sm"
 onClick={() => (this.renameId.value = null)}
 >
 cancel
 </Button>
 <Button
 size="sm"
 onClick={() => {
 store.rename(this.renameId.value!, this.renameDraft.value);
 this.renameId.value = null;
 }}
 >
 rename
 </Button>
 </div>
 </div>
 </div>
 )}

 {/* delete confirmation */}
 {this.deleteId.value != null && (
 <div
 class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
 onClick={() => (this.deleteId.value = null)}
 >
 <div
 class="w-72 rounded border border-slate-600 bg-slate-900 p-4 shadow-xl"
 onClick={(e) => e.stopPropagation()}
 >
 <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
 Delete set
 </h3>
 <p class="text-xs text-slate-300">
 Delete{' '}
 <span class="font-semibold text-slate-100">
 {setLabel(
 store.sets().find((s) => s.id === this.deleteId.value) ?? {
 id: '',
 name: '',
 slots: {},
 },
 )}
 </span>
 ? Its bindings go with it.
 </p>
 <div class="mt-4 flex justify-end gap-2">
 <Button
 variant="ghost"
 size="sm"
 onClick={() => (this.deleteId.value = null)}
 >
 cancel
 </Button>
 <Button
 variant="destructive"
 size="sm"
 onClick={() => {
 store.remove(this.deleteId.value!);
 this.deleteId.value = null;
 }}
 >
 delete
 </Button>
 </div>
 </div>
 </div>
 )}
 </PanelShell>
 );
 }
}
