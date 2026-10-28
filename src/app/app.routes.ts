import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Route } from '@preact-mvc/core';
import { FabMenu } from './fab';

// Every spawned/detached window is its own app instance — an eager import
// graph made even the tiniest panel pull the whole bundle. lazy() wraps a
// route in a dynamic import so a window only fetches the view chunk it
// renders (shared deps stay in the entry chunk).
function lazy(load: () => Promise<any>) {
  let Comp: any = null;
  let failed = false;
  let pending: Promise<any> | null = null;
  return function LazyRoute() {
    const [, tick] = useState(0);
    useEffect(() => {
      if (Comp || failed) return;
      pending ??= load().then(
        (m) => {
          Comp = m;
          tick((n) => n + 1);
        },
        (e) => {
          failed = true;
          console.error('route chunk failed to load', e);
          tick((n) => n + 1);
        },
      );
    }, []);
    if (failed) return h('p', { class: 'p-1 text-xs text-slate-400' }, 'failed to load view');
    return Comp ? h(Comp, null) : null;
  };
}

export const routes: Route[] = [
  {
    path: '/',
    component: lazy(() =>
      import('./inventory/inventory.view').then((m) => m.InventoryView),
    ),
  },
  {
    path: '/chat',
    component: lazy(() => import('./chat/chat.view').then((m) => m.ChatView)),
  },
  {
    path: '/journal',
    component: lazy(() =>
      import('./journal/journal.view').then((m) => m.JournalView),
    ),
  },
  {
    path: '/map',
    component: lazy(() => import('./map/map.view').then((m) => m.MapView)),
  },
  // no NAV entries — these are detached-window routes (quest tracker,
  // clickable macro bar, cooldown list, minimap)
  {
    path: '/tracker',
    component: lazy(() =>
      import('./tracker/tracker.view').then((m) => m.TrackerView),
    ),
  },
  {
    path: '/macrobar',
    component: lazy(() =>
      import('./macrobar/macrobar.view').then((m) => m.MacroBarView),
    ),
  },
  {
    path: '/cooldowns',
    component: lazy(() =>
      import('./cooldowns/cooldowns.view').then((m) => m.CooldownsView),
    ),
  },
  {
    path: '/minimap',
    component: lazy(() =>
      import('./map/minimap.view').then((m) => m.MinimapView),
    ),
  },
  {
    path: '/party',
    component: lazy(() => import('./party/party.view').then((m) => m.PartyView)),
  },
  {
    path: '/target',
    component: lazy(() =>
      import('./target/target.view').then((m) => m.TargetView),
    ),
  },
  {
    path: '/skillchain',
    component: lazy(() =>
      import('./skillchain/skillchain.view').then((m) => m.SkillchainView),
    ),
  },

  // the shared fab dropdown window — never user-navigable
  { path: '/fabmenu', component: FabMenu },
  {
    path: '/settings',
    component: lazy(() =>
      import('./settings/settings.view').then((m) => m.SettingsView),
    ),
  },
  {
    path: '/macros',
    component: lazy(() =>
      import('./macros/macros.view').then((m) => m.MacrosView),
    ),
  },
  {
    path: '/abilities',
    component: lazy(() =>
      import('./abilities/abilities.view').then((m) => m.AbilitiesView),
    ),
  },
  {
    path: '/profile',
    component: lazy(() =>
      import('./profile.view').then((m) => m.ProfileView),
    ),
    children: [
      {
        path: '',
        component: lazy(() =>
          import('./sets/sets.view').then((m) => m.SetsView),
        ),
      },
      {
        path: 'sets',
        component: lazy(() =>
          import('./sets/sets.view').then((m) => m.SetsView),
        ),
      },
      {
        path: 'bindings',
        component: lazy(() =>
          import('./bindings/bindings.view').then((m) => m.BindingsView),
        ),
      },
    ],
  },
  { path: '*', component: () => h('p', null, 'Not found.') },
];
