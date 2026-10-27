import { Component, View, inject, RouterOutlet, Router } from '@preact-mvc/core';
import { ProfileHeader } from './profile-header';
import { TabBar, Tab } from './core/tabs';

const SUBNAV = [
  { to: '/profile/sets', match: (u: string) => u === '/profile' || u === '/profile/sets', label: 'Sets' },
  { to: '/profile/bindings', match: (u: string) => u === '/profile/bindings', label: 'Bindings' },
];

/**
 * Profile shell — the file picker applies to both subtabs since sets and
 * bindings live in the same per-profile managed block.
 */
@Component()
export class ProfileView extends View {
  private router = inject(Router);

  render() {
    const url = this.router.url.value;
    return (
      <div class="flex h-full min-h-0 flex-col">
        <ProfileHeader />
        <TabBar class="mb-3">
          {SUBNAV.map((s) => (
            <Tab to={s.to} active={s.match(url.split('?')[0])}>
              {s.label}
            </Tab>
          ))}
        </TabBar>
        <div class="min-h-0 flex-1">
          <RouterOutlet />
        </div>
      </div>
    );
  }
}
