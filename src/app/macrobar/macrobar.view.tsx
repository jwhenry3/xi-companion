// Detached macro bar — the 20 Ctrl/Alt cells of one palette as clickable
// buttons. A click POSTs /api/macros/run, which replays the macro's lines
// through the client's input line just like pressing the keybind would.
// No NAV entry; reached via "macro bar" on the Macros page or //xic
// macrobar. Char/book/page persist in localStorage so the bar reopens
// where it was.
import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { RefreshCw } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import type { MacroCharacter, MacroEntry } from '../core/types';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const NUM_BOOKS = 40;
const PALS_PER_BOOK = 10;
const NUM_MACROS = 20;
const LS_KEY = 'xic.macrobar';

const keyLabel = (i: number) =>
  `${i < 10 ? 'Ctrl' : 'Alt'}+${((i % 10) + 1) % 10}`;

@Component()
export class MacroBarView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);

  private charId = signal('');
  private book = signal(1);
  private page = signal(1);
  private running = signal<number | null>(null);
  private err = signal<string | null>(null);
  private timer = 0;
  private onFocus = () => void this.api.refreshMacros();

  private chars = computed(() => this.api.macros.value?.characters ?? []);
  private char = computed<MacroCharacter | null>(
    () =>
      this.chars.value.find((c) => c.id === this.charId.value) ??
      this.chars.value[0] ??
      null,
  );
  private titles = computed(() => this.char.value?.titles ?? []);
  private paletteIndex = computed(
    () => (this.book.value - 1) * PALS_PER_BOOK + (this.page.value - 1),
  );
  private macros = computed<MacroEntry[]>(
    () =>
      this.char.value?.palettes.find((p) => p.index === this.paletteIndex.value)
        ?.macros ?? [],
  );
  private palsWithContent = computed(
    () =>
      new Set(
        (this.char.value?.palettes ?? [])
          .filter((p) => p.book === this.book.value)
          .map((p) => p.palette),
      ),
  );

  onInit() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
      if (saved) {
        this.charId.value = String(saved.char ?? '');
        this.book.value = Number(saved.book) || 1;
        this.page.value = Number(saved.page) || 1;
      }
    } catch {
      // fresh state
    }
    void this.api.refreshMacros();
    // this window has its own api context — edits saved in the editor
    // window don't reach us, so refetch on focus + a slow poll
    this.timer = window.setInterval(this.onFocus, 15000);
    window.addEventListener('focus', this.onFocus);
  }

  onDestroy() {
    clearInterval(this.timer);
    window.removeEventListener('focus', this.onFocus);
  }

  private persist() {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        char: this.char.value?.id ?? '',
        book: this.book.value,
        page: this.page.value,
      }),
    );
  }

  private pickChar(id: string) {
    this.charId.value = id;
    this.book.value = 1;
    this.page.value = 1;
    this.persist();
  }

  /** drive the client's own palette to the bar's selection — the whole
   *  point of the pickers is to double as a quick in-game switcher.
   *  Book switches re-load the book client-side, so only send one when
   *  the book actually changed (rapid re-loads risk the PR #1892 wipe) */
  private syncInGame(bookChanged: boolean) {
    if (!this.api.macros.value?.logged_in) return;
    if (bookChanged) {
      void this.api.sendCommand(`input /macro book ${this.book.value}`);
    }
    void this.api.sendCommand(`input /macro set ${this.page.value}`);
  }

  private pickBook(b: number) {
    const changed = b !== this.book.value;
    this.book.value = b;
    this.persist();
    this.syncInGame(changed);
  }

  private pickPage(p: number) {
    this.page.value = p;
    this.persist();
    this.syncInGame(false);
  }

  private stepPage(d: -1 | 1) {
    this.pickPage(((this.page.value - 1 + d + PALS_PER_BOOK) % PALS_PER_BOOK) + 1);
  }

  private async run(i: number) {
    const c = this.char.value;
    if (!c || this.running.value != null) return;
    this.running.value = i;
    this.err.value = null;
    try {
      await this.api.runMacro(c.id, this.paletteIndex.value, i);
    } catch (e) {
      this.err.value = String(e);
    } finally {
      this.running.value = null;
    }
  }

  render() {
    const st = this.api.macros.value;
    if (st == null) {
      return <p class="p-1 text-xs text-slate-400">loading…</p>;
    }
    if (this.chars.value.length === 0) {
      return <p class="p-1 text-xs text-slate-400">no macro files found</p>;
    }
    const c = this.char.value;
    const macros = this.macros.value;
    return (
      <div class="flex h-full flex-col gap-2.5">
        {/* pickers */}
        <div class="flex items-center gap-2">
          {this.chars.value.length > 1 && (
            <Select
              className="h-7 w-24 text-xs"
              value={c?.id ?? ''}
              options={this.chars.value.map((x) => ({ value: x.id, label: x.id }))}
              onChange={(v) => this.pickChar(v)}
            />
          )}
          <Select
            className="h-7 w-40 text-xs"
            filterable
            value={String(this.book.value)}
            options={Array.from({ length: NUM_BOOKS }, (_, i) => {
              const b = i + 1;
              return {
                value: String(b),
                label: this.titles.value[i] || `Book ${b}`,
              };
            })}
            onChange={(v) => this.pickBook(Number(v))}
          />
          <button
            class="h-7 w-4 rounded border border-slate-700 text-[10px] text-slate-400 transition-colors hover:bg-slate-800"
            title="previous page"
            onClick={() => this.stepPage(-1)}
          >
            ‹
          </button>
          {Array.from({ length: PALS_PER_BOOK }, (_, i) => {
            const p = i + 1;
            const has = this.palsWithContent.value.has(p);
            return (
              <button
                key={p}
                class={cn(
                  'h-7 w-6 rounded border text-[10px] transition-colors',
                  p === this.page.value
                    ? 'border-sky-500 bg-sky-500/15 text-sky-200'
                    : 'border-slate-700 text-slate-400 hover:bg-slate-800',
                )}
                title={has ? `page ${p} (has macros)` : `page ${p} (empty)`}
                onClick={() => this.pickPage(p)}
              >
                {has ? <strong>{p}</strong> : p}
              </button>
            );
          })}
          <button
            class="h-7 w-4 rounded border border-slate-700 text-[10px] text-slate-400 transition-colors hover:bg-slate-800"
            title="next page"
            onClick={() => this.stepPage(1)}
          >
            ›
          </button>
          <button
            class="ml-auto flex h-7 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            title="reload macro files"
            onClick={this.onFocus}
          >
            <RefreshCw size={12} />
          </button>
        </div>

        {/* ctrl + alt rows */}
        {([0, 10] as const).map((rowStart) => (
          <div class="flex items-center gap-1.5" key={rowStart}>
            <span class="w-7 shrink-0 text-[10px] text-slate-500">
              {rowStart === 0 ? 'Ctrl' : 'Alt'}
            </span>
            {Array.from({ length: 10 }, (_, k) => {
              const i = rowStart + k;
              const m = macros[i];
              const empty =
                !m || (m.name === '' && m.lines.every((l) => l === ''));
              const tip = m
                ? `${keyLabel(i)} — ${m.name || '(empty)'}\n` +
                  m.lines.filter((l) => l !== '').join('\n')
                : keyLabel(i);
              return (
                <button
                  key={i}
                  class={cn(
                    'h-9 min-w-0 flex-1 truncate rounded border px-1 text-[0.7rem] leading-tight transition-colors',
                    this.running.value === i
                      ? 'border-emerald-500 bg-emerald-500/20 text-emerald-100'
                      : empty
                        ? 'border-slate-800 text-slate-600'
                        : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:border-sky-500 hover:bg-sky-500/10',
                  )}
                  disabled={empty}
                  title={tip}
                  onClick={() => void this.run(i)}
                >
                  {m?.name || '·'}
                </button>
              );
            })}
          </div>
        ))}
        {this.err.value && (
          <p class="truncate text-[10px] text-rose-400" title={this.err.value}>
            {this.err.value}
          </p>
        )}
      </div>
    );
  }
}
