import { Component, View, inject, RouterOutlet, Link, Router } from '@preact-mvc/core';
import { ExternalLink } from 'lucide-preact';
import { APP_TITLE } from './core/tokens';
import { AddonApi } from './core/addon-api.service';
import { host, fabMode, detachedMode, tooltipMode, trackerMode } from './core/host';
import { Fab } from './fab';
import { TooltipView } from './tooltip/tooltip.view';

const NAV = [
  { to: '/', match: '/', label: 'Inventory' },
  { to: '/chat', match: '/chat', label: 'Chat' },
  { to: '/journal', match: '/journal', label: 'Journal' },
  { to: '/macros', match: '/macros', label: 'Macros' },
  { to: '/profile', match: '/profile', label: 'GearSwap' },
  { to: '/settings', match: '/settings', label: 'Settings' },
];

@Component()
export class AppShell extends View {
  private router = inject(Router);
  private api = inject(AddonApi);
  private title = inject(APP_TITLE);

  onInit() {
    // detached windows (tracker etc.) ask the shell to navigate us —
    // ExecJS lands here via xic:main:<url>
    (window as any).__xicNavigate = (p: string) => this.router.navigate(p);
  }

  onDestroy() {
    delete (window as any).__xicNavigate;
  }

  render() {
    // this window IS the floating item tooltip — just the card
    if (tooltipMode) return <TooltipView />;

    // the shell is in fab mode — just the floating button
    if (fabMode.value) return <Fab />;

    const url = this.router.url.value;

    // a spawned per-tab window (?window=1): slim draggable title bar +
    // just the routed view — no nav, Esc/× close the window. The quest
    // tracker (/tracker) keeps the same shape but stays transparent so
    // it reads as an overlay panel rather than a window.
    if (detachedMode) {
      const title = trackerMode
        ? 'Tracker'
        : url === '/macrobar'
          ? 'Macro Bar'
          : (NAV.find(
              (n) => (n.match === '/' ? url === '/' : url.startsWith(n.match)),
            )?.label ?? url);
      return (
        <div
          class={`flex h-screen flex-col overflow-hidden text-slate-200 ${
            trackerMode
              ? // opaque card like the item tooltip — the window itself
                // stays transparent so the rounded corners clip cleanly
                'rounded border border-slate-600 bg-slate-900 shadow-xl shadow-black/60'
              : 'bg-slate-950'
          }`}
        >
          <header
            class={`flex h-6 shrink-0 items-center gap-2 pl-2 pr-1 ${
              trackerMode
                ? 'border-b border-slate-700 bg-slate-800'
                : 'border-b border-slate-800 bg-slate-900/80'
            }`}
          >
            <span class="min-w-0 flex-1 truncate text-[10px] font-medium text-slate-400">
              {title}
            </span>
            <button
              class="flex h-5 w-5 items-center justify-center rounded text-xs leading-none text-slate-500 hover:bg-slate-800 hover:text-rose-300"
              title="close (Esc does the same)"
              onClick={() => host.closeWindow()}
            >
              ×
            </button>
          </header>
          <main
            class={`min-h-0 flex-1 overflow-hidden ${trackerMode ? 'p-1' : 'p-3'}`}
          >
            <RouterOutlet />
          </main>
        </div>
      );
    }
    const player = this.api.state.value?.player;
    const connected = this.api.connected.value;
    const chatUnread = Object.values(this.api.chatUnread.value).reduce(
      (a, b) => a + b,
      0,
    );
    return (
      <div class="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-200">
        <header class="flex h-14 items-center gap-4 border-b border-slate-800 px-5">
          <strong class="font-logo translate-y-px text-base leading-none tracking-wide">
            {this.title}
          </strong>
          <nav class="flex gap-4">
            {NAV.map((n) => {
              const active = n.match === '/' ? url === '/' : url.startsWith(n.match);
              return (
                <Link
                  to={n.to}
                  class={active ? 'nav-link active' : 'nav-link'}
                >
                  {n.label}
                  {n.to === '/chat' && chatUnread > 0 && (
                    <span class="ml-1 rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">
                      {chatUnread > 99 ? '99+' : chatUnread}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          <span class="flex-1" />
          {player && (
            <span class="text-xs text-slate-400">
              {player.name} — {player.main_job}
              {player.main_job_level}
              {player.sub_job ? ` / ${player.sub_job}${player.sub_job_level}` : ''}
            </span>
          )}
          <span
            class={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-rose-500'}`}
            title={connected ? 'connected to addon' : 'disconnected'}
          />
          {host.inShell() && (
            <button
              class="ml-1 flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-200"
              title="pop this tab out into its own window"
              onClick={() => host.spawnWindow(url)}
            >
              <ExternalLink size={13} />
            </button>
          )}
          <button
            class="ml-1 flex h-6 w-6 items-center justify-center rounded text-sm leading-none text-slate-500 hover:bg-slate-800 hover:text-rose-300"
            title="collapse to the floating button (Esc does the same)"
            onClick={() => host.collapse()}
          >
            ×
          </button>
        </header>
        <main class="min-h-0 flex-1 overflow-hidden p-6">
          <RouterOutlet />
        </main>
      </div>
    );
  }
}
