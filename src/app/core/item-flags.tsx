// Native FFXI flag colors — the client marks item types with colored
// dots in the item-info box: yellow = Rare (one per character),
// green = Ex (untradeable/unauctionable).
import type { ItemMeta } from './types';

type Flags = Pick<ItemMeta, 'rare' | 'ex'> | null | undefined;

/** name color — Rare yellow wins over Ex green (both dots still show) */
export function itemNameClass(meta: Flags): string {
  if (meta?.rare) return 'text-amber-300';
  if (meta?.ex) return 'text-emerald-300';
  return '';
}

/** colored-dot badges matching the client's info-box markers */
export function flagDots(meta: Flags) {
  if (!meta?.rare && !meta?.ex) return null;
  return (
    <span class="inline-flex items-center gap-0.5">
      {meta?.rare && (
        <span class="text-amber-400" title="Rare">
          ●
        </span>
      )}
      {meta?.ex && (
        <span class="text-emerald-400" title="Exclusive">
          ●
        </span>
      )}
    </span>
  );
}
