import { Component, View, inject, RouterOutlet, Link, Router } from '@preact-mvc/core';
import { ExternalLink, Cog } from 'lucide-preact';
import { APP_TITLE } from './core/tokens';
import { AddonApi } from './core/addon-api.service';
import { host, fabMode, detachedMode, menuMode, tooltipMode, trackerMode, cooldownsMode, macrobarMode, minimapMode, partyMode, targetMode, skillchainMode, theme, setTheme, THEMES, type Theme, winOpacity, setWinView } from './core/host';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '@/lib/utils';
import { Fab, FabMenu } from './fab';

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
function ViewPrefs() {
 const [open, setOpen] = useState(false);
 const root = useRef<HTMLSpanElement>(null);
 useLayoutEffect(() => {
 if (!open) return;
 const onDown = (e: MouseEvent) => {
 if (!root.current?.contains(e.target as Node)) setOpen(false);
 };
 const onKey = (e: KeyboardEvent) => {
 if (e.key === 'Escape') setOpen(false);
 };
 document.addEventListener('mousedown', onDown);
 document.addEventListener('keydown', onKey);
 return () => {
 document.removeEventListener('mousedown', onDown);
 document.removeEventListener('keydown', onKey);
 };
 }, [open]);
 const row = (
 label: string,
 v: number,
 lo: number,
 hi: number,
 set: (n: number) => void,
 ) => (
 <label class="flex items-center gap-2 px-2 py-1">
 <span class="w-8 text-[10px] text-slate-400">{label}</span>
 <input
 type="range"
 min={lo}
 max={hi}
 step={0.05}
 value={v}
 class="w-24 accent-indigo-400"
 onInput={(e) => set(parseFloat((e.target as HTMLInputElement).value))}
 />
 <span class="w-8 text-right text-[10px] text-slate-400">
 {Math.round(v * 100)}%
 </span>
 </label>
 );
 return (
 <span ref={root} class="relative inline-flex">
 <button
 class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-indigo-200/80 hover:bg-indigo-300/20 hover:text-white"
 title="this window's opacity"
 onClick={(e) => {
 e.stopPropagation();
 setOpen(!open);
 }}
 >
 <Cog size={12} />
 </button>
 {open && (
 <span
 class="absolute right-0 top-full z-50 mt-0.5 flex flex-col rounded border border-slate-600 bg-slate-900 py-1 shadow-lg"
 onClick={(e) => e.stopPropagation()}
 >
 <span class="flex flex-wrap gap-1 px-2 pb-1 pt-0.5">
 {THEMES.map((t) => (
 <button
 class={cn(
 'rounded px-1.5 py-0.5 text-[10px] capitalize',
 t === theme.value
 ? 'bg-indigo-500/40 text-indigo-100'
 : 'text-slate-400 hover:bg-slate-700',
 )}
 onClick={() => setTheme(t as Theme)}
 >
 {t}
 </button>
 ))}
 </span>
 {row('alpha', winOpacity.value, 0.3, 1, (n) => setWinView({ opacity: n }))}
 <button
 class="mx-2 mt-0.5 rounded px-1 py-0.5 text-left text-[10px] text-slate-400 hover:bg-slate-700 hover:text-slate-200"
 onClick={() => setWinView({ scale: 1, opacity: 1 })}
 >
 reset
 </button>
 </span>
 )}
 </span>
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
 '/meter': 'Combat Meter',
 } as Record<string, string>
 )[path] ??
 NAV.find(
 (n) => (n.match === '/' ? path === '/' : path.startsWith(n.match)),
 )?.label ??
 path;
 return (
 <div class="ffxi-panel main-window flex h-screen flex-col overflow-hidden text-slate-200">
 <header class="ffxi-panel-title flex h-7 shrink-0 items-center gap-2 pl-2 pr-1">
 {macrobarMode ? (
 // bar pickers live inline on the title bar; the controls
 // share state with the view via macrobar.state
 <div class="flex min-w-0 flex-1 items-center gap-1.5">
 <MacroBarChrome />
 </div>
 ) : (
 <span class="min-w-0 flex-1 truncate text-[10px] font-medium leading-7 text-indigo-100">
 {title}
 </span>
 )}
 <ViewPrefs />
 <button
 class="flex h-6 w-6 items-center justify-center rounded text-xs leading-none text-indigo-200/70 hover:bg-indigo-300/20 hover:text-white"
 title="close (Esc does the same)"
 onClick={() => host.closeWindow()}
 >
 ×
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
