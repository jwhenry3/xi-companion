import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import type { MacroCharacter, MacroEntry } from '../core/types';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const NUM_MACROS = 20;
const NUM_LINES = 6;
const NAME_BYTES = 8;
const LINE_BYTES = 60;
const NUM_BOOKS = 40;
const PALS_PER_BOOK = 10;

const blank = (): MacroEntry => ({
  name: '',
  lines: Array.from({ length: NUM_LINES }, () => ''),
});
const blankPalette = () => Array.from({ length: NUM_MACROS }, blank);
const clone = (m: MacroEntry[]): MacroEntry[] =>
  m.map((e) => ({ name: e.name, lines: [...e.lines] }));
const norm = (m: MacroEntry[] | undefined): MacroEntry[] => {
  const out = blankPalette();
  (m ?? []).slice(0, NUM_MACROS).forEach((e, i) => {
    out[i] = { name: e.name ?? '', lines: [...(e.lines ?? [])] };
    while (out[i].lines.length < NUM_LINES) out[i].lines.push('');
  });
  return out;
};

// Byte length of an encoded line: "[AT:xxxxxxxx]" = 6 bytes, "\xNN" = 1.
// Mirrors the encoder in addon macros.lua; non-ASCII chars count as 1
// (approximation — the server enforces the real limit on save).
function byteLen(s: string): number {
  let n = 0;
  let i = 0;
  while (i < s.length) {
    if (/^\[AT:[0-9a-fA-F]{8}\]/.test(s.slice(i))) {
      n += 6;
      i += 13;
    } else if (/^\\x[0-9a-fA-F]{2}/.test(s.slice(i))) {
      n += 1;
      i += 4;
    } else {
      n += 1;
      i += 1;
    }
  }
  return n;
}

@Component()
export class MacrosView extends View implements OnInit {
  private api = inject(AddonApi);

  private charId = signal('');
  private book = signal(1);
  private palette = signal(1);
  private cell = signal(0); // 0-9 ctrl row, 10-19 alt row
  private draft = signal<MacroEntry[]>(blankPalette());
  private baseline = signal<MacroEntry[]>(blankPalette());
  private clipboard = signal<MacroEntry[] | null>(null);
  private titleDraft = signal('');
  private busy = signal(false);
  private message = signal<{ text: string; ok: boolean } | null>(null);
  private initialized = false;

  private chars = computed(() => this.api.macros.value?.characters ?? []);
  private char = computed<MacroCharacter | null>(
    () =>
      this.chars.value.find((c) => c.id === this.charId.value) ??
      this.chars.value[0] ??
      null,
  );
  private titles = computed(() => this.char.value?.titles ?? []);
  private paletteIndex = computed(
    () => (this.book.value - 1) * PALS_PER_BOOK + (this.palette.value - 1),
  );
  private loaded = computed(() =>
    this.char.value?.palettes.find((p) => p.index === this.paletteIndex.value),
  );
  private dirty = computed(
    () => JSON.stringify(this.draft.value) !== JSON.stringify(this.baseline.value),
  );
  private booksWithContent = computed(
    () => new Set(this.char.value?.palettes.map((p) => p.book) ?? []),
  );
  private palsWithContent = computed(
    () =>
      new Set(
        (this.char.value?.palettes ?? [])
          .filter((p) => p.book === this.book.value)
          .map((p) => p.palette),
      ),
  );
  private loggedIn = computed(() => this.api.macros.value?.logged_in ?? false);

  onInit() {
    void this.api.refreshMacros().then(() => {
      if (!this.initialized) {
        this.initialized = true;
        this.syncSelection();
      }
    });
  }

  private syncSelection() {
    this.draft.value = norm(this.loaded.value?.macros);
    this.baseline.value = clone(this.draft.value);
    this.titleDraft.value = this.titles.value[this.book.value - 1] ?? '';
    this.cell.value = 0;
  }

  private pickBook(b: number) {
    this.book.value = b;
    this.palette.value = 1;
    this.syncSelection();
  }

  private pickPalette(p: number) {
    this.palette.value = p;
    this.syncSelection();
  }

  private pickChar(id: string) {
    this.charId.value = id;
    this.book.value = 1;
    this.palette.value = 1;
    this.syncSelection();
  }

  private setLine(i: number, v: string) {
    const d = clone(this.draft.value);
    d[this.cell.value].lines[i] = v;
    this.draft.value = d;
  }

  private setName(v: string) {
    const d = clone(this.draft.value);
    d[this.cell.value].name = v;
    this.draft.value = d;
  }

  private cellEdited(i: number) {
    const d = this.draft.value[i];
    const b = this.baseline.value[i];
    return JSON.stringify(d) !== JSON.stringify(b);
  }

  private async save() {
    const c = this.char.value;
    if (!c) return;
    this.busy.value = true;
    this.message.value = null;
    try {
      const res = await this.api.savePalette(
        c.id,
        this.paletteIndex.value,
        this.draft.value,
        this.loggedIn.value, // apply: force the client to re-read via book switch
      );
      this.baseline.value = clone(this.draft.value);
      // tell sibling windows (the detached macro bar) data changed —
      // storage events only fire in OTHER windows, which is exactly
      // where the stale palette lives
      localStorage.setItem('xicompanion.macros.saved', String(Date.now()));
      this.message.value = {
        text: res.applied
          ? `saved ${res.file} — applying in-game via book switch (~5s)`
          : `saved ${res.file}`,
        ok: true,
      };
    } catch (e) {
      this.message.value = { text: `save failed: ${e}`, ok: false };
    } finally {
      this.busy.value = false;
    }
  }

  private async saveTitle() {
    const c = this.char.value;
    if (!c) return;
    this.busy.value = true;
    this.message.value = null;
    try {
      await this.api.saveMacroTitle(c.id, this.book.value, this.titleDraft.value);
      this.message.value = { text: 'book title saved', ok: true };
    } catch (e) {
      this.message.value = { text: `save failed: ${e}`, ok: false };
    } finally {
      this.busy.value = false;
    }
  }

  private revert() {
    this.draft.value = clone(this.baseline.value);
  }

  private copyPalette() {
    this.clipboard.value = clone(this.draft.value);
    this.message.value = { text: 'palette copied', ok: true };
  }

  private pastePalette() {
    const c = this.clipboard.value;
    if (!c) return;
    this.draft.value = clone(c);
    this.message.value = {
      text: 'pasted — save to write it to this book/page',
      ok: true,
    };
  }

  private clearPalette() {
    this.draft.value = blankPalette();
  }

  private keyLabel(i: number) {
    const row = i < 10 ? 'Ctrl' : 'Alt';
    const num = ((i % 10) + 1) % 10; // 1..9,0 like the client bar
    return `${row}+${num}`;
  }

  render() {
    const st = this.api.macros.value;
    const c = this.char.value;
    const draft = this.draft.value;
    const cur = draft[this.cell.value];

    if (st == null) {
      return <p class="text-sm text-slate-400">loading macros…</p>;
    }
    if (this.chars.value.length === 0) {
      return (
        <div class="text-sm text-slate-400">
          <p>No macro files found under the FFXI USER directory.</p>
        </div>
      );
    }

    const sel = this.cell.value;
    return (
      <div class="flex h-full gap-4 overflow-hidden">
        {/* sidebar: char + vertical book list (same shape as the journal's
            group column) */}
        <aside class="flex w-52 shrink-0 flex-col gap-2">
          {this.chars.value.length > 1 && (
            <Select
              value={c?.id ?? ''}
              options={this.chars.value.map((x) => ({ value: x.id, label: `char ${x.id}` }))}
              onChange={(v) => this.pickChar(v)}
            />
          )}
          <div class="min-h-0 flex-1 overflow-y-auto pr-1">
            {Array.from({ length: NUM_BOOKS }, (_, i) => {
              const b = i + 1;
              const t = this.titles.value[i];
              const has = this.booksWithContent.value.has(b);
              const active = b === this.book.value;
              return (
                <button
                  key={b}
                  class={cn(
                    'flex w-full flex-col rounded px-2 py-1 text-left',
                    active
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200',
                    !has && 'opacity-70',
                  )}
                  onClick={() => this.pickBook(b)}
                >
                  <span class="flex items-center gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-sm">
                      {t || `Book ${b}`}
                    </span>
                    {has && <span class="text-[9px] text-sky-400">●</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* main pane */}
        <div class="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
        {/* header row: book title rename + in-game switch */}
        <div class="flex flex-wrap items-center gap-3">
          <strong class="text-sm">Book {this.book.value}</strong>
          <Input
            className="w-40"
            value={this.titleDraft.value}
            placeholder="book title"
            onInput={(e) => (this.titleDraft.value = (e.target as HTMLInputElement).value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={this.busy.value || this.titleDraft.value === (this.titles.value[this.book.value - 1] ?? '')}
            onClick={() => void this.saveTitle()}
          >
            rename book
          </Button>
          <span class="flex-1" />
          {host.inShell() && (
            <Button
              variant="outline"
              size="sm"
              title="open the clickable macro bar in its own window"
              onClick={() => host.spawnWindow('/macrobar')}
            >
              macro bar
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void this.api.sendCommand(`input /macro book ${this.book.value}`)}
          >
            switch to this book in-game
          </Button>
        </div>

        {/* page picker */}
        <div class="flex items-center gap-1.5">
          <span class="w-14 text-xs text-slate-500">page</span>
          {Array.from({ length: PALS_PER_BOOK }, (_, i) => {
            const p = i + 1;
            const has = this.palsWithContent.value.has(p);
            const active = p === this.palette.value;
            return (
              <button
                class={cn(
                  'h-7 w-9 rounded-md border text-xs transition-colors',
                  active
                    ? 'border-sky-500 bg-sky-500/15 text-sky-200'
                    : 'border-slate-700 text-slate-400 hover:bg-slate-800',
                )}
                onClick={() => this.pickPalette(p)}
                title={has ? `page ${p} (has macros)` : `page ${p} (empty)`}
              >
                {has ? <strong>{p}</strong> : p}
              </button>
            );
          })}
          <span class="ml-3 text-xs text-slate-500">
            book {this.book.value} · page {this.palette.value} · mcr{this.paletteIndex.value || ''}.dat
          </span>
        </div>

        {/* macro grid: ctrl row + alt row */}
        <div class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
          {([0, 10] as const).map((rowStart) => (
            <div class="mb-1.5 flex items-center gap-1" key={rowStart}>
              <span class="w-10 text-xs text-slate-500">{rowStart === 0 ? 'Ctrl' : 'Alt'}</span>
              {Array.from({ length: 10 }, (_, k) => {
                const i = rowStart + k;
                const m = draft[i];
                const empty = m.name === '' && m.lines.every((l) => l === '');
                return (
                  <button
                    key={i}
                    class={cn(
                      'h-9 w-[4.7rem] truncate rounded-md border px-1 text-[0.72rem] leading-tight transition-colors',
                      i === sel
                        ? 'border-sky-500 bg-sky-500/20 text-sky-100'
                        : empty
                          ? 'border-slate-800 text-slate-600 hover:bg-slate-800/60'
                          : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:border-slate-500',
                    )}
                    title={`${this.keyLabel(i)} — ${m.name || '(empty)'}`}
                    onClick={() => (this.cell.value = i)}
                  >
                    {this.cellEdited(i) && <span class="text-amber-400">● </span>}
                    {m.name || (empty ? '·' : '?')}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* selected macro editor */}
        <div class="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <div class="mb-3 flex items-center gap-3">
            <strong class="text-sm">{this.keyLabel(sel)}</strong>
            <Input
              className="w-36"
              value={cur.name}
              placeholder="label"
              maxLength={NAME_BYTES}
              onInput={(e) => this.setName((e.target as HTMLInputElement).value)}
            />
            <span class="text-[0.68rem] text-slate-500">
              label ≤ {NAME_BYTES} bytes · lines ≤ {LINE_BYTES} bytes
            </span>
          </div>
          <div class="flex flex-col gap-1.5">
            {cur.lines.map((line, i) => {
              const len = byteLen(line);
              const over = len > LINE_BYTES;
              return (
                <div class="flex items-center gap-2" key={i}>
                  <span class="w-4 text-right text-xs text-slate-600">{i + 1}</span>
                  <Input
                    className={cn('font-mono text-xs', over && 'border-rose-500')}
                    value={line}
                    placeholder="/command"
                    onInput={(e) =>
                      this.setLine(i, (e.target as HTMLInputElement).value)
                    }
                  />
                  <span
                    class={cn(
                      'w-10 text-right text-[0.68rem]',
                      over ? 'text-rose-400' : 'text-slate-600',
                    )}
                  >
                    {len}/{LINE_BYTES}
                  </span>
                </div>
              );
            })}
          </div>
          <p class="mt-2 text-[0.68rem] text-slate-600">
            auto-translate phrases show as [AT:xxxxxxxx] — keep the whole token
            intact or delete it entirely. Raw bytes appear as \xNN.
          </p>
        </div>

        {this.loggedIn.value && (
          <p class="rounded-md border border-sky-700/60 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
            character is logged in — saving applies live: the client is
            switched to another book, the file lands while the book is
            unloaded, then it switches back (~5s). Your macro bar will
            flicker books briefly.
          </p>
        )}

        {/* actions */}
        <div class="flex items-center gap-2">
          <Button disabled={!this.dirty.value || this.busy.value} onClick={() => void this.save()}>
            {this.loggedIn.value ? 'save & apply' : 'save palette'}
          </Button>
          <Button variant="outline" disabled={!this.dirty.value} onClick={() => this.revert()}>
            revert
          </Button>
          <span class="mx-1 h-5 w-px bg-slate-800" />
          <Button variant="outline" size="sm" onClick={() => this.copyPalette()}>
            copy palette
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={this.clipboard.value == null}
            onClick={() => this.pastePalette()}
          >
            paste
          </Button>
          <Button variant="ghost" size="sm" onClick={() => this.clearPalette()}>
            clear
          </Button>
          {this.message.value && (
            <span
              class={cn(
                'ml-2 text-xs',
                this.message.value.ok ? 'text-emerald-400' : 'text-rose-400',
              )}
            >
              {this.message.value.text}
            </span>
          )}
        </div>
        </div>
      </div>
    );
  }
}
