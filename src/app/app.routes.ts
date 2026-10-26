import { h } from 'preact';
import type { Route } from '@preact-mvc/core';
import { FabMenu } from './fab';
import { InventoryView } from './inventory/inventory.view';
import { ChatView } from './chat/chat.view';
import { MacrosView } from './macros/macros.view';
import { MacroBarView } from './macrobar/macrobar.view';
import { ProfileView } from './profile.view';
import { SetsView } from './sets/sets.view';
import { BindingsView } from './bindings/bindings.view';
import { JournalView } from './journal/journal.view';
import { TrackerView } from './tracker/tracker.view';
import { CooldownsView } from './cooldowns/cooldowns.view';
import { MapView } from './map/map.view';
import { MinimapView } from './map/minimap.view';
import { PartyView } from './party/party.view';
import { TargetView } from './target/target.view';
import { SkillchainView } from './skillchain/skillchain.view';
import { VisibilityView } from './visibility/visibility.view';
import { SettingsView } from './settings/settings.view';
import { AbilitiesView } from './abilities/abilities.view';

export const routes: Route[] = [
  { path: '/', component: InventoryView },
  { path: '/chat', component: ChatView },
  { path: '/journal', component: JournalView },
  { path: '/map', component: MapView },
  // no NAV entries — these are detached-window routes (quest tracker,
  // clickable macro bar, cooldown list, minimap)
  { path: '/tracker', component: TrackerView },
  { path: '/macrobar', component: MacroBarView },
  { path: '/cooldowns', component: CooldownsView },
  { path: '/minimap', component: MinimapView },
  { path: '/party', component: PartyView },
  { path: '/target', component: TargetView },
  { path: '/skillchain', component: SkillchainView },
  // the collapse-all handle — spawnWindow starts it on every launch
  { path: '/visibility', component: VisibilityView },
  // the shared fab dropdown window — never user-navigable
  { path: '/fabmenu', component: FabMenu },
  { path: '/settings', component: SettingsView },
  { path: '/macros', component: MacrosView },
  { path: '/abilities', component: AbilitiesView },
  {
    path: '/profile',
    component: ProfileView,
    children: [
      { path: '', component: SetsView },
      { path: 'sets', component: SetsView },
      { path: 'bindings', component: BindingsView },
    ],
  },
  { path: '*', component: () => h('p', null, 'Not found.') },
];
