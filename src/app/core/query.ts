import {
  QueryClient,
  QueryObserver,
  type QueryObserverOptions,
} from '@tanstack/query-core';
import { effect, signal } from '@preact-mvc/core';
import type { Signal } from '@preact/signals';

/**
 * One client for the whole app. The addon is the only backend and SSE
 * already pushes live state, so defaults stay tight: short staleness for
 * query-based refetches, no focus/online listeners (always-on-top tool
 * windows), single retry for localhost hiccups.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

export interface BoundQuery<T> {
  /** latest result data — undefined until the first success */
  readonly data: Signal<T | undefined>;
  readonly error: Signal<Error | null>;
  readonly pending: Signal<boolean>;
  refetch(): void;
  /** release the observer + effect — call from the view's onDestroy */
  dispose(): void;
}

/**
 * TanStack Query for class `View`s. Hooks can't run inside the
 * @preact-mvc class components, so this drives QueryObserver (the same
 * engine the react/preact adapters wrap) and projects results onto
 * signals. `options` is re-evaluated inside an effect — reading signals
 * there makes queryKey/enabled reactive:
 *
 *   private descQ = bindQuery(() => ({
 *     queryKey: ['itemmeta', this.itemId.value],
 *     // NOTE: the queryFn must not fetchQuery() its own key — a queryFn
 *     // awaiting its own in-flight query deadlocks (never resolves).
 *     // Use a raw fetch (api.fetchItemMeta) inside queryFn instead.
 *     queryFn: () => api.fetchItemMeta(this.itemId.value!),
 *     enabled: this.itemId.value > 0,
 *     staleTime: Infinity,
 *   }));
 */
export function bindQuery<T>(
  options: () => QueryObserverOptions<T>,
): BoundQuery<T> {
  const obs = new QueryObserver<T>(queryClient, options());
  const cur = obs.getCurrentResult();
  const data = signal(cur.data as T | undefined);
  const error = signal<Error | null>(cur.error);
  const pending = signal(cur.isPending);

  const unsub = obs.subscribe((r) => {
    data.value = r.data as T | undefined;
    error.value = r.error;
    pending.value = r.isPending;
  });
  const stopFx = effect(() => {
    obs.setOptions(options());
  });

  return {
    data,
    error,
    pending,
    refetch: () => void obs.refetch(),
    dispose: () => {
      stopFx();
      unsub();
      obs.destroy();
    },
  };
}
