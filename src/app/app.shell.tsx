import { Component, View, inject, RouterOutlet, Link, Router } from '@preact-mvc/core';
import { ExternalLink } from 'lucide-preact';
import { APP_TITLE } from './core/tokens';
import { AddonApi } from './core/addon-api.service';
import { host, fabMode, detachedMode, menuMode, visibilityMode, tooltipMode, trackerMode, cooldownsMode, macrobarMode, minimapMode, partyMode, targetMode, skillchainMode, theme, setTheme, THEMES, type Theme } from './core/host';
import { Dropdown } from './core/dropdown';
import { Fab, FabMenu } from './fab';
import { VisibilityView } from './visibility/visibility.view';
import { TooltipView } from './tooltip/tooltip.view';

const NAV = [
  { to: '/', match: '/', label: 'Inventory' },
  { to: '/chat', match: '/chat', label: 'Chat' },
  { to: '/journal', match: '/journal', label: 'Journal' },
  { to: '/map', match: '/map', label: 'Map' },
  { to: '/macros', match: '/macros', label: 'Macros' },
  { to: '/abilities', match: '/abilities', label: 'Book' },
  { to: '/profile', match: '/profile', label: 'GearSwap' },
  { to: '/settings', match: '/settings', label: 'Settings' },
];

// per-window theme picker for detached windows — the choice persists
// under xicompanion.wintheme.<route> so each spawned window keeps its
// own look. A native <select>'s popup needs window activation (these
// panels are NOACTIVATE) — the shared Dropdown is the same fix in-page.
function ThemePicker() {
  return (
    <Dropdown
      class="h-5 shrink-0 cursor-pointer rounded border border-indigo-300/30 bg-transparent px-1 text-[10px] capitalize leading-none"
      title="theme for this window only"
      align="right"
      value={theme.value}
      options={THEMES}
      onChange={(t) => setTheme(t as Theme)}
    />
  );
}

@Component()
export class AppShell extends View {
  private router = inject(Router);
  private api = inject(AddonApi);
  private title = inject(APP_TITLE);

  onInit() {
    // detached windows (tracker etc.) ask the shell to navigate us —
    // ExecJS lands here via xicompanion:main:<url>
    (window as any).__xicNavigate = (p: string) => this.router.navigate(p);
  }

  onDestroy() {
    delete (window as any).__xicNavigate;
  }

  render() {
    // this window IS the floating item tooltip — just the card
    if (tooltipMode) return <TooltipView />;

    // this window IS the shared fab dropdown — bare menu, no chrome
    if (menuMode) return <FabMenu />;

    // the collapse-all handle — bare floating button, no chrome
    if (visibilityMode) return <VisibilityView />;

    // the shell is in fab mode — just the floating button
    if (fabMode.value) return <Fab />;

    const url = this.router.url.value;

    // a spawned per-tab window (?window=1): the classic FFXI window skin
    // — deep navy card, pale border, blue title bar — over a transparent
    // window backdrop, plus just the routed view (no nav). Fab-layer
    // panels (/tracker, /macrobar, /cooldowns, /minimap, /party,
    // /target) keep tighter padding so they read as overlay panels.
    const panelMode =
      trackerMode || cooldownsMode || macrobarMode || minimapMode ||
      partyMode || targetMode || skillchainMode;
    if (detachedMode) {
      // router.url carries the ?window=1 query — compare the bare path
      const path = url.split('?')[0];
      const title =
        (
          {
            '/tracker': 'Tracker',
            '/cooldowns': 'Cooldowns',
            '/macrobar': 'Macro Bar',
            '/minimap': 'Minimap',
            '/party': 'Party',
            '/target': 'Target',
            '/skillchain': 'Skillchains',
          } as Record<string, string>
        )[path] ??
        NAV.find(
          (n) => (n.match === '/' ? path === '/' : path.startsWith(n.match)),
        )?.label ??
        path;
      return (
        <div class="ffxi-panel flex h-screen flex-col overflow-hidden text-slate-200">
          <header class="ffxi-panel-title flex h-7 shrink-0 cursor-grab items-center gap-2 pl-2 pr-1">
            <span class="min-w-0 flex-1 truncate text-[10px] font-medium leading-7 text-indigo-100">
              {title}
            </span>
            <ThemePicker />
            <button
              class="flex h-6 w-6 items-center justify-center rounded text-xs leading-none text-indigo-200/70 hover:bg-indigo-300/20 hover:text-white"
              title="close (Esc does the same)"
              onClick={() => host.closeWindow()}
            >
              ×
            </button>
          </header>
          <main
            class={`min-h-0 flex-1 overflow-hidden ${panelMode ? 'p-1' : 'p-3'}`}
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
