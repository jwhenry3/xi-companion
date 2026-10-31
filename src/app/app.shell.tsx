import { Component, View, inject, signal, RouterOutlet, Link, Router } from '@preact-mvc/core';
import { ExternalLink, Cog, X, LayoutGrid, List } from 'lucide-preact';
import { APP_TITLE } from './core/tokens';
import { AddonApi } from './core/addon-api.service';
import { host, fabMode, detachedMode, menuMode, tooltipMode, trackerMode, cooldownsMode, macrobarMode, minimapMode, partyMode, targetMode, skillchainMode, entitiesMode, theme, setTheme, THEMES, type Theme, winOpacity, winScale, setWinView, showPlayerName } from './core/host';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '@/lib/utils';
import { Fab, FabMenu } from './fab';
import { SpecMenu } from './menu.view';
import { abilitiesMode } from './abilities/abilities.view';

import { TooltipView } from './tooltip/tooltip.view';
import { MacroBarChrome } from './macrobar/macrobar.chrome';

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
// per-window theme + alpha — ImagineXI's per-panel prefs sliders.
// Same in-page popover approach as Dropdown (native popups need window
// activation, which these panels never get)
// per-window view prefs — the staged popover layout (theme chips,
// scale/alpha sliders, save/revert) hosted in the shared fullscreen
// menu window so it can't clip at the window edge. Pick ids are JSON:
// {prefs:{theme,scale,opacity}} from the panel's save/revert buttons.
function ViewPrefs() {
 const openMenu = (e: MouseEvent) => {
 e.stopPropagation();
 const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
 const W = 240;
 const H = 150;
 // client coords — the shell adds this window's screen position
 const x = r.right - W;
 let y = r.bottom + 2;
 let up = false;
 if (y + H > window.innerHeight - 8) {
 y = Math.max(0, r.top - H - 2);
 up = true;
 }
 host.pickMenu(
 x,
 y,
 W,
 H,
 {
 type: 'prefs',
 theme: theme.value,
 scale: winScale.value,
 opacity: winOpacity.value,
 },
 (id) => {
 try {
 const p = JSON.parse(id);
 if (p?.prefs) {
 setTheme(p.prefs.theme as Theme);
 setWinView({
 scale: p.prefs.scale,
 opacity: p.prefs.opacity,
 });
 host.winScaleBounds(p.prefs.scale);
 }
 } catch {
 /* not a prefs payload — ignore */
 }
 host.fabMenuHide();
 },
 up,
 );
 };
 return (
 <span class="relative inline-flex">
 <button
 class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-indigo-200/80 hover:bg-indigo-300/20 hover:text-white"
 title="this window's view prefs"
 onClick={openMenu}
 >
 <Cog size={12} />
 </button>
 </span>
 );
}

// /abilities header control — flips between the quick-execute grid and
// the list+detail layout. The icon shows the current mode.
function AbilitiesModeToggle() {
 const grid = abilitiesMode.value === 'grid';
 const Icon = grid ? List : LayoutGrid;
 return (
 <button
 class="no-drag flex h-5 w-5 items-center justify-center rounded bg-transparent text-slate-300/80 hover:bg-white/10 hover:text-white"
 title={grid ? 'switch to list view' : 'switch to grid view'}
 onClick={() => (abilitiesMode.value = grid ? 'detail' : 'grid')}
 >
 <Icon size={12} />
 </button>
 );
}

// /tracker refresh, inline in the detached title bar with the prefs cog
@Component()
class HeaderRefresh extends View {
  private api = inject(AddonApi);
  private spin = signal(false);
  render() {
    return (
      <button
        class={cn(
          'flex h-5 w-5 items-center justify-center rounded text-indigo-200/80 hover:bg-indigo-300/20 hover:text-white',
          this.spin.value && 'animate-spin',
        )}
        title="refresh objectives & quests"
        onClick={() => {
          this.spin.value = true;
          void this.api
            .refreshJournal()
            .finally(() => setTimeout(() => (this.spin.value = false), 400));
        }}
      >
        <svg viewBox="0 0 24 24" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
        </svg>
      </button>
    );
  }
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

 // this window IS the shared dropdown — spec menus (g=j:<json>) get
 // the generic item renderer, fab groups get FabMenu
 if (menuMode) {
 const g = new URLSearchParams(window.location.search).get('g') ?? '';
 return g.startsWith('j:') ? <SpecMenu /> : <FabMenu />;
 }


 // the shell is in fab mode — just the floating button, with the
 // character name wordmarked left of the first divider (gated by the
 // same showPlayerName setting as the detached titlebars)
 if (fabMode.value)
     return (
         <Fab
             player={
                 showPlayerName.value
                     ? this.api.state.value?.player?.name
                     : null
             }
         />
     );

 const url = this.router.url.value;

 // a spawned per-tab window (?window=1): the classic FFXI window skin
 // — deep navy card, pale border, blue title bar — over a transparent
 // window backdrop, plus just the routed view (no nav). Fab-layer
 // panels (/tracker, /macrobar, /cooldowns, /minimap, /party,
 // /target) keep tighter padding so they read as overlay panels.
 const panelMode =
 trackerMode || cooldownsMode || macrobarMode || minimapMode ||
 partyMode || targetMode || skillchainMode || entitiesMode ||
 window.location.pathname === '/meter' ||
 window.location.pathname === '/actionbar';
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
 '/meter': 'Combat Meter',
 '/entities': 'Nearby',
 '/actionbar': 'Action Bar',
 } as Record<string, string>
 )[path] ??
 NAV.find(
 (n) => (n.match === '/' ? path === '/' : path.startsWith(n.match)),
 )?.label ??
 path;
 const pname = showPlayerName.value ? this.api.state.value?.player?.name : null;
 return (
 <div class="ffxi-panel main-window flex h-screen flex-col overflow-hidden text-slate-200">
 <header class="ffxi-panel-title flex h-7 shrink-0 items-center gap-2 pl-2 pr-1">
 {macrobarMode ? (
 // bar pickers live inline on the title bar; the controls
 // share state with the view via macrobar.state
 <div class="flex min-w-0 flex-1 items-center gap-1.5">
 {pname && (
 <span class="shrink-0 truncate text-[10px] font-medium leading-7 text-indigo-100">
 {pname} ·
 </span>
 )}
 <MacroBarChrome />
 </div>
 ) : (
 <span class="min-w-0 flex-1 truncate text-[10px] font-medium leading-7 text-indigo-100">
 {pname ? `${pname} · ` : ''}{title}
 </span>
 )}
 {path === '/tracker' && <HeaderRefresh />}
 {path === '/abilities' && <AbilitiesModeToggle />}
 <ViewPrefs />
 <button
 class="flex h-5 w-5 items-center justify-center rounded text-xs leading-none text-indigo-200/70 hover:bg-indigo-300/20 hover:text-white"
 title="close (Esc does the same)"
 onClick={() => host.closeWindow()}
 >
 <X class="h-3 w-3" />
 </button>
 </header>
 {/* PanelShell views run edge-to-edge — their own layout
 supplies the spacing; the p-3 frame was an un-themed seam
 showing around them */}
 <main
 class={`min-h-0 flex-1 overflow-hidden ${
 panelMode
 ? 'p-1'
 : ['/chat', '/journal', '/abilities', '/macros', '/map'].includes(path) ||
 path.startsWith('/profile')
 ? ''
 : 'p-3'
 }`}
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
 <div class="ffxi-panel main-window flex h-screen flex-col overflow-hidden text-slate-200">
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
