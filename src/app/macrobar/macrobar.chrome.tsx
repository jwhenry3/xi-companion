// Title-bar controls for a detached macro bar: char/book pickers plus a
// ‹ page › input group, a "+" to spawn another bar, and reload. Rendered
// inside the shell's panel header for /macrobar windows — shares the
// view's state through macrobar.state (per-window module signals).
import { Component, View, inject, computed, signal } from '@preact-mvc/core';
import { ChevronDown, ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-preact';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { barBook, barChar, barPage, barPersist, PALS_PER_BOOK } from './macrobar.state';

const NUM_BOOKS = 40;

@Component()
export class MacroBarChrome extends View {
  private api = inject(AddonApi);

  private bookOpen = signal(false);
  private chars = computed(() => this.api.macros.value?.characters ?? []);
  private char = computed(
    () =>
      this.chars.value.find((c) => c.id === barChar.value) ??
      this.chars.value[0] ??
      null,
  );
  private titles = computed(() => this.char.value?.titles ?? []);

  /** drive the client's palette to the bar's selection — picking still
   *  doubles as an in-game switcher (book loads re-read files, so only
   *  send the book command when it actually changed) */
  private syncInGame(bookChanged: boolean) {
    if (!this.api.macros.value?.logged_in) return;
    if (bookChanged) {
      void this.api.sendCommand(`input /macro book ${barBook.value}`);
    }
    void this.api.sendCommand(`input /macro set ${barPage.value}`);
  }

  private pickChar(id: string) {
    barChar.value = id;
    barBook.value = 1;
    barPage.value = 1;
    barPersist();
  }

  private pickBook(b: number) {
    const changed = b !== barBook.value;
    barBook.value = b;
    barPersist();
    this.syncInGame(changed);
  }

  private pickPage(p: number) {
    barPage.value = p;
    barPersist();
    this.syncInGame(false);
  }

  private stepPage(d: -1 | 1) {
    this.pickPage(((barPage.value - 1 + d + PALS_PER_BOOK) % PALS_PER_BOOK) + 1);
  }

  render() {
    return (
      <>
        {this.chars.value.length > 1 && (
          <Select
            className="h-5 w-20 text-[10px]"
            value={this.char.value?.id ?? ''}
            options={this.chars.value.map((x) => ({ value: x.id, label: x.id }))}
            onChange={(v) => this.pickChar(v)}
          />
        )}
        {/* book picker — opens a full-window grid of the 40 books so
            titles get real room (a flat select list truncated them) */}
        <button
          class="flex h-5 max-w-44 items-center gap-1 whitespace-nowrap rounded border border-input bg-card px-1.5 text-[10px] text-foreground hover:bg-accent"
          onClick={() => (this.bookOpen.value = !this.bookOpen.value)}
        >
          <span class="truncate">
            {this.titles.value[barBook.value - 1] || `Book ${barBook.value}`}
          </span>
          <ChevronDown size={10} class="shrink-0 text-muted-foreground" />
        </button>
        {this.bookOpen.value && (
          <div class="fixed inset-0 z-50 flex flex-col bg-popover">
            <div class="flex h-6 shrink-0 items-center justify-between border-b border-border px-2">
              <span class="text-[10px] text-muted-foreground">macro books</span>
              <button
                class="flex h-5 w-5 items-center justify-center rounded text-xs leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => (this.bookOpen.value = false)}
              >
                ×
              </button>
            </div>
            <div class="grid min-h-0 flex-1 grid-cols-4 gap-1 overflow-y-auto p-1.5">
              {Array.from({ length: NUM_BOOKS }, (_, i) => {
                const b = i + 1;
                const title = this.titles.value[i];
                return (
                  <button
                    key={b}
                    class={cn(
                      'flex min-w-0 flex-col rounded border px-1.5 py-1 text-left transition-colors',
                      b === barBook.value
                        ? 'border-sky-500 bg-sky-500/15'
                        : 'border-slate-700 bg-slate-800/80 hover:border-sky-500 hover:bg-sky-500/10',
                    )}
                    onClick={() => {
                      this.pickBook(b);
                      this.bookOpen.value = false;
                    }}
                  >
                    <span class="text-[9px] leading-tight text-slate-500">
                      {b}
                    </span>
                    <span class="truncate text-[10px] leading-tight text-slate-200">
                      {title || '·'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {/* page input group — ‹ n › joined like the chat composer */}
        <div class="flex h-5 items-stretch">
          <button
            class="flex w-5 items-center justify-center rounded-l border border-r-0 border-input bg-card text-muted-foreground hover:bg-accent"
            title="previous page"
            onClick={() => this.stepPage(-1)}
          >
            <ChevronLeft size={12} />
          </button>
          <span class="flex h-5 w-7 items-center justify-center border-y border-input bg-card text-[10px] leading-none text-foreground select-none">
            {barPage.value}
          </span>
          <button
            class="flex w-5 items-center justify-center rounded-r border border-l-0 border-input bg-card text-muted-foreground hover:bg-accent"
            title="next page"
            onClick={() => this.stepPage(1)}
          >
            <ChevronRight size={12} />
          </button>
        </div>
        <button
          class="flex h-5 w-5 items-center justify-center rounded text-indigo-200/70 hover:bg-indigo-300/20 hover:text-white"
          title="open another macro bar"
          onClick={() =>
            host.spawnWindow(`/macrobar?n=${Math.floor(Math.random() * 1e9)}`)
          }
        >
          <Plus size={11} />
        </button>
        <button
          class="flex h-5 w-5 items-center justify-center rounded text-indigo-200/70 hover:bg-indigo-300/20 hover:text-white"
          title="reload macro files"
          onClick={() => void this.api.refreshMacros()}
        >
          <RefreshCw size={10} />
        </button>
      </>
    );
  }
}
