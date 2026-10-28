// Per-window selection state for detached macro bars. Each spawned bar
// is its own Webview (own JS heap), so module signals are naturally
// per-bar. `?n=<id>` on the route distinguishes instances spawned by the
// bar's "+" button — it feeds the localStorage key (and, Go-side, the
// spawn/geometry/open keys) so bars keep separate selections/positions.
import { signal, effect } from '@preact-mvc/core';

export const barInst =
  new URLSearchParams(window.location.search).get('n') ?? '';
const LS_KEY = 'xicompanion.macrobar' + (barInst ? ':' + barInst : '');

export const barChar = signal('');
export const barBook = signal(1);
export const barPage = signal(1);

try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
  if (saved) {
    barChar.value = String(saved.char ?? '');
    barBook.value = Number(saved.book) || 1;
    barPage.value = Number(saved.page) || 1;
  }
} catch {
  // fresh state
}

// any selection change persists instantly — restore ran above, so this
// first fire just rewrites what was already saved
effect(() => {
  const v = {
    char: barChar.value,
    book: barBook.value,
    page: barPage.value,
  };
  localStorage.setItem(LS_KEY, JSON.stringify(v));
});

export function barPersist() {
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      char: barChar.value,
      book: barBook.value,
      page: barPage.value,
    }),
  );
}

export const PALS_PER_BOOK = 10;
