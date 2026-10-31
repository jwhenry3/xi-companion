// Detached macro bar — the 20 Ctrl/Alt cells of one palette as clickable
// buttons. A click POSTs /api/macros/run, which replays the macro's lines
// through the client's input line just like pressing the keybind would.
// Standalone: it does NOT follow the client's active book/page — the
// pickers live in the window title bar (macrobar.chrome). Multiple bars
// can be open at once ("+" spawns /macrobar?n=<id>, an independent
// selection + position). Char/book/page persist per instance.
import { Component, View, inject, signal, computed } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import type { MacroCharacter, MacroEntry } from '../core/types';
import { cn } from '@/lib/utils';
import { barBook, barChar, barPage, PALS_PER_BOOK } from './macrobar.state';

const NUM_MACROS = 20;

const keyLabel = (i: number) =>
  `${i < 10 ? 'Ctrl' : 'Alt'}+${((i % 10) + 1) % 10}`;

@Component()
export class MacroBarView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);

  private running = signal<number | null>(null);
  private err = signal<string | null>(null);
  private timer = 0;
  private onFocus = () => void this.api.refreshMacros();
  private onStorage = (e: StorageEvent) => {
    if (e.key === 'xicompanion.macros.saved') this.onFocus();
  };

  private chars = computed(() => this.api.macros.value?.characters ?? []);
  private char = computed<MacroCharacter | null>(
    () =>
      this.chars.value.find((c) => c.id === barChar.value) ??
      this.chars.value[0] ??
      null,
  );
  private paletteIndex = computed(
    () => (barBook.value - 1) * PALS_PER_BOOK + (barPage.value - 1),
  );
  private macros = computed<MacroEntry[]>(
    () =>
      this.char.value?.palettes.find((p) => p.index === this.paletteIndex.value)
        ?.macros ?? [],
  );

  onInit() {
    void this.api.refreshMacros();
    // this window has its own api context — edits saved in the editor
    // window don't reach us, so refetch on save bumps, focus + a poll
    this.timer = window.setInterval(this.onFocus, 15000);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('storage', this.onStorage);
  }

  onDestroy() {
    clearInterval(this.timer);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('storage', this.onStorage);
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
    const macros = this.macros.value;
    return (
      <div class="flex h-full flex-col justify-start gap-1.5 pt-0.5">
        {/* ctrl + alt rows */}
        {([0, 10] as const).map((rowStart) => (
          <div class="flex items-center gap-1.5" key={rowStart}>
            <span class="w-7 shrink-0 text-[11px] text-slate-500">
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
                        : 'border-slate-500 bg-slate-950/90 text-slate-100 hover:border-sky-400 hover:bg-sky-500/10',
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
