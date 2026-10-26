import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { bindQuery } from '../core/query';
import { host, TooltipRef } from '../core/host';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { augmentText, cmdStr, equipCmdSlot, equipSlots } from '../core/item-utils';
import type { BagItem, ItemMeta } from '../core/types';
import { itemNameClass, flagDots } from '../core/item-flags';

declare global {
  interface Window {
    __xicTooltip?: (p: TooltipRef) => void;
  }
}

/** The floating item-tooltip window (?tooltip=1). Peek mode is
 *  click-through at the OS level — this page only needs to render.
 *  When pinned the shell makes the window interactive, so the title
 *  bar (drag + ×) and the action buttons only render then. */
@Component()
export class TooltipView extends View {
  private api = inject(AddonApi);
  private payload = signal<TooltipRef | null>(null);
  private flash = signal<string | null>(null);

  onInit() {
    document.body.classList.add('tooltip-mode');
    const q = new URLSearchParams(location.search);
    const p = this.fromQuery(q);
    if (p) this.payload.value = p;
    // subsequent updates land via the shell's ExecJS — no reload flicker
    window.__xicTooltip = (p) => (this.payload.value = p);
  }

  onDestroy() {
    document.body.classList.remove('tooltip-mode');
    delete window.__xicTooltip;
    this.descQ.dispose();
  }

  private fromQuery(q: URLSearchParams): TooltipRef | null {
    const id = Number(q.get('id'));
    if (!id) return null;
    return {
      bag: Number(q.get('bag') ?? -1),
      slot: Number(q.get('slot') ?? -1),
      id,
      name: q.get('name') ?? undefined,
      x: 0,
      y: 0,
      pinned: q.get('pinned') === '1',
    };
  }

  private resolved = computed(() => {
    const p = this.payload.value;
    const st = this.api.state.value;
    if (!p || !st || p.bag < 0) return null;
    const bag = st.bags.find((b) => b.id === p.bag);
    const it = bag?.items.find((i) => i.slot === p.slot && i.id === p.id);
    if (bag && it) return { bag, item: it };
    // moved out of its origin slot (or something else landed there) —
    // follow the item by id so actions keep working after a storage move
    for (const b of st.bags) {
      const found = b.items.find((i) => i.id === p.id);
      if (found) return { bag: b, item: found };
    }
    return null;
  });

  private item = computed<BagItem | null>(() => this.resolved.value?.item ?? null);

  private meta = computed<ItemMeta | undefined>(() => {
    const it = this.item.value;
    const id = it?.id ?? this.payload.value?.id;
    return id ? this.api.state.value?.catalog?.[id] : undefined;
  });

  // the full client description (stats/passives) isn't in the catalog —
  // it's served per-id. Reactive query: hovering a different item re-keys
  // and refetches; results are cached by the api service.
  private descQ = bindQuery<ItemMeta | undefined>(() => {
    const id = this.item.value?.id ?? this.payload.value?.id;
    return {
      queryKey: ['itemmeta', id ?? 0],
      // fetchItemMeta, not itemMeta — the latter nests fetchQuery on this
      // same key and a queryFn awaiting its own in-flight query deadlocks
      queryFn: () => this.api.fetchItemMeta(id!).catch(() => undefined),
      enabled: !!id,
      staleTime: Infinity,
      gcTime: Infinity,
    };
  });

  // ---- actions (pinned only — the window is click-through while peeking)

  private async run(cmd: string, echo?: string) {
    try {
      await this.api.sendCommand(cmd);
      this.note(echo ?? cmd);
    } catch (e) {
      this.note(`failed: ${e}`);
    }
  }

  private note(msg: string) {
    this.flash.value = msg;
    setTimeout(() => {
      if (this.flash.value === msg) this.flash.value = null;
    }, 3000);
  }

  private equip(resName: string) {
    const it = this.item.value;
    const name = this.meta.value?.name ?? `item ${it?.id}`;
    if (!it) return;
    const slot = equipCmdSlot(resName);
    void this.run(`input /equip ${slot} ${cmdStr(name)}`, `/equip ${slot} ${name}`);
  }

  private async unequip() {
    const it = this.item.value;
    if (!it?.equip_slot) return;
    try {
      // no /unequip client command — the addon injects a 0x050 equip
      // packet with inv_slot 0
      await this.api.itemAction({ action: 'unequip', slot: it.equip_slot });
      this.note(`unequipped ${it.equip_slot}`);
    } catch (e) {
      this.note(`unequip failed: ${e}`);
    }
  }

  private use() {
    const it = this.item.value;
    const name = this.meta.value?.name ?? `item ${it?.id}`;
    if (!it) return;
    void this.run(`input /item ${cmdStr(name)} <me>`, `/item ${name} <me>`);
  }

  private async move(target: number) {
    const cur = this.resolved.value;
    const it = cur?.item;
    if (!cur || !it) return;
    try {
      await this.api.itemAction({
        action: 'move',
        bag: cur.bag.id,
        index: it.slot,
        count: it.count,
        target,
      });
      this.note(`moved ${this.meta.value?.name ?? 'item'}`);
    } catch (e) {
      this.note(`move failed: ${e}`);
    }
  }

  private async drop() {
    const cur = this.resolved.value;
    const it = cur?.item;
    if (!cur || !it) return;
    try {
      await this.api.itemAction({
        action: 'drop',
        bag: cur.bag.id,
        index: it.slot,
        count: it.count,
      });
      this.note(`dropped ${this.meta.value?.name ?? 'item'}`);
      host.closeTooltip();
    } catch (e) {
      this.note(`drop failed: ${e}`);
    }
  }

  private copy(cmd: string) {
    navigator.clipboard
      .writeText(cmd)
      .then(() => this.note(`copied ${cmd}`))
      .catch(() => this.note('copy failed'));
  }

  /** blue-text stat line → dim label + brighter, spaced-out value tokens
   *  (matches the Type/Level dl styling); prose lines render plain */
  private descLine(line: string) {
    // "Magic Def. Bonus"+5 / DEF:45 / STR+6 / Enmity-5 / Delay:-8
    const RE =
      /("(?:[^"]+)"|[A-Za-zÀ-ÿ0-9.' ]*?[A-Za-z])\s*([:+-])\s*(-?\d+(?:\.\d+)?%?)/g;
    const parts: any[] = [];
    let last = 0;
    for (const m of line.matchAll(RE)) {
      if (m.index! > last) parts.push(line.slice(last, m.index));
      const sep = m[2];
      parts.push(
        <span key={parts.length} class="mr-2.5 inline-block whitespace-nowrap">
          <span class="text-slate-500">
            {m[1].replace(/^"|"$/g, '').trim()}
            {sep === ':' ? ':' : ''}
          </span>
          <span class="text-slate-300">
            {sep === ':' ? ` ${m[3]}` : `${sep}${m[3]}`}
          </span>
        </span>,
      );
      last = m.index! + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts.length ? parts : line;
  }

  render() {
    const p = this.payload.value;
    if (!p) return <div id="tip" class="p-2 text-xs text-slate-500">…</div>;
    const cur = this.resolved.value;
    const it = cur?.item ?? null;
    const meta = this.meta.value;
    const desc = this.descQ.data.value?.description;
    const name = it ? (meta?.name ?? `item ${it.id}`) : (p.name ?? `item ${p.id}`);
    const pinned = !!p.pinned;
    const bag = cur?.bag ?? this.api.state.value?.bags.find((b) => b.id === p.bag);
    const moveTargets =
      this.api.state.value?.bags.filter(
        (b) => b.enabled !== false && b.id !== cur?.bag.id,
      ) ?? [];

    const equipOpts = equipSlots(meta?.slots);
    const canEquip = !!it && !it.equipped && equipOpts.length > 0;
    const canUnequip = !!it?.equipped && !!it?.equip_slot;
    const canUse = meta?.category === 'Usable';
    const canDrop = it != null && cur?.bag.id === 0 && !it.equipped && !meta?.ex;
    // macro-ready lines — the same strings the equip/use buttons fire,
    // one per valid slot so multi-slot items (ear/ring/main+sub) each
    // get their own line; click copies (pinned windows only — peek is
    // click-through)
    const itemName = meta?.name ?? p.name;
    const macroCmds: string[] = itemName
      ? [
          ...equipOpts.map(
            (s) => `/equip ${equipCmdSlot(s)} ${cmdStr(itemName)}`,
          ),
          ...(canUse ? [`/item ${cmdStr(itemName)} <me>`] : []),
        ]
      : [];
    const elsewhere =
      it && cur
        ? (this.api.state.value?.bags ?? []).flatMap((b) =>
            b.items
              .filter(
                (x) =>
                  x.id === it.id && !(b.id === cur.bag.id && x.slot === it.slot),
              )
              .map((x) => `${b.name} [${x.slot}]`),
          )
        : [];

    return (
      // fixed-size window: the card fills it, the body scrolls
      <div
        id="tip"
        class="ffxi-panel flex h-full w-full flex-col"
      >
        {pinned && (
          <div
            class="ffxi-panel-title flex h-6 items-center gap-1 pl-2 pr-1"
            style={{ '--wails-draggable': 'drag' }}
          >
            <span
              class={`min-w-0 flex-1 truncate text-[10px] font-medium ${itemNameClass(meta) || 'text-indigo-100'}`}
            >
              {name}
            </span>
            <button
              class="flex h-4 w-4 items-center justify-center rounded text-[11px] leading-none text-indigo-200/70 hover:bg-indigo-300/20 hover:text-white"
              style={{ '--wails-draggable': 'no-drag' }}
              onClick={() => host.closeTooltip()}
            >
              ×
            </button>
          </div>
        )}
        <div class="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div class="flex items-start gap-2">
            <img
              src={this.api.iconUrl(it?.id ?? p.id)}
              class="h-8 w-8 shrink-0 rounded object-contain"
              alt=""
            />
            <div class="min-w-0 flex-1">
              <h3 class="text-xs font-semibold leading-tight text-slate-200">
                {name}
              </h3>
              <p class="text-[10px] text-slate-500">
                {it && bag
                  ? `${bag.name} [${it.slot}] · id ${it.id}${meta?.ilvl != null ? ` · i${meta.ilvl}` : ''}${it.equipped ? ' · equipped' : ''}`
                  : 'not found in inventory'}
              </p>
            </div>
          </div>

          <dl class="mt-2 space-y-0.5 text-[11px] text-slate-300">
            {meta?.category && (
              <div>
                <dt class="inline text-slate-500">Type: </dt>
                <dd class="inline">
                  {meta.category}
                  {meta.type ? ` / ${meta.type}` : ''}
                </dd>
              </div>
            )}
            {meta?.level != null && (
              <div>
                <dt class="inline text-slate-500">Level: </dt>
                <dd class="inline">
                  {meta.level}
                  {meta.ilvl ? ` (iLv ${meta.ilvl})` : ''}
                </dd>
              </div>
            )}
            {(meta?.slots?.length ?? 0) > 0 && (
              <div>
                <dt class="inline text-slate-500">Slots: </dt>
                <dd class="inline">{meta!.slots!.join(', ')}</dd>
              </div>
            )}
            {meta?.jobs && (
              <div>
                <dt class="inline text-slate-500">Jobs: </dt>
                <dd class="inline">
                  {meta.all_jobs ? 'All jobs' : meta.jobs.join(', ')}
                </dd>
              </div>
            )}
            {(meta?.rare || meta?.ex) && (
              <div>
                <dt class="inline text-slate-500">Flags: </dt>
                <dd class="inline">
                  {meta?.rare && <span class="text-amber-300">Rare</span>}
                  {meta?.rare && meta?.ex && ', '}
                  {meta?.ex && <span class="text-emerald-300">Ex</span>}{' '}
                  {flagDots(meta)}
                </dd>
              </div>
            )}
            {it?.equip_slot && (
              <div>
                <dt class="inline text-slate-500">Equipped: </dt>
                <dd class="inline">{it.equip_slot}</dd>
              </div>
            )}
            {elsewhere.length > 0 && (
              <div>
                <dt class="inline text-slate-500">Duplicates: </dt>
                <dd class="inline">{elsewhere.join(', ')}</dd>
              </div>
            )}
          </dl>

          {desc && (
            <div class="mt-1.5 border-t border-slate-800 pt-1.5 text-[11px] leading-relaxed text-slate-300">
              {desc.split('\n').map((line, li) => (
                <div key={li}>{this.descLine(line)}</div>
              ))}
            </div>
          )}

          {(it?.augments?.length ?? 0) > 0 && (
            <ul class="mt-1.5 space-y-0.5 border-t border-slate-800 pt-1.5 text-[11px] text-sky-300">
              {it!.augments!.map((a, i) => (
                <li key={i}>· {augmentText(a)}</li>
              ))}
            </ul>
          )}

          {pinned && it && (
            <div class="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-800 pt-2">
              {canEquip &&
                // multi-slot items (weapons: main/sub, rings: left/right…)
                // need the explicit slot — the unordered slots[] can't
                // be trusted to pick the right hand
                equipOpts.map((s) => (
                  <Button
                    key={s}
                    size="xs"
                    variant="secondary"
                    onClick={() => this.equip(s)}
                  >
                    {equipOpts.length > 1 ? `equip ${equipCmdSlot(s)}` : 'equip'}
                  </Button>
                ))}
              {canUnequip && (
                <Button size="xs" variant="secondary" onClick={() => this.unequip()}>
                  unequip
                </Button>
              )}
              {canUse && (
                <Button size="xs" variant="secondary" onClick={() => this.use()}>
                  use
                </Button>
              )}
              {moveTargets.length > 0 && !it.equipped && (
                <Select
                  className="w-28"
                  value=""
                  placeholder="move to…"
                  options={moveTargets.map((b) => ({
                    value: String(b.id),
                    label: b.name,
                  }))}
                  onChange={(v) => void this.move(Number(v))}
                />
              )}
              {canDrop && (
                <Button size="xs" variant="destructive" onClick={() => void this.drop()}>
                  drop
                </Button>
              )}
            </div>
          )}
          {macroCmds.length > 0 && (
            <div class="mt-2 space-y-0.5 border-t border-slate-800 pt-1.5">
              {macroCmds.map((cmd) => (
                <button
                  key={cmd}
                  class="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[10px] text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                  title={pinned ? 'click to copy' : cmd}
                  onClick={() => this.copy(cmd)}
                >
                  {cmd}
                </button>
              ))}
            </div>
          )}
          {this.flash.value && (
            <p class="mt-1.5 text-[10px] text-emerald-400">{this.flash.value}</p>
          )}
        </div>
      </div>
    );
  }
}
