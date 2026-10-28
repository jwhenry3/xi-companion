// Menu bar — what the overlay renders while the shell is in fab mode
// (540×56 window): dropdown groups covering every detached-able
// window. A click toggles the window (open ↔ close). Open windows glow.
// Drag anywhere to reposition, right-click quits the overlay process.
import { host, openWindows, fabMenuOpen } from './core/host';
import { cn } from '@/lib/utils';
import {
    ScrollText,
    Keyboard,
    Timer,
    Radar,
    Package,
    MessageSquare,
    BookOpen,
    Map as MapIcon,
    NotebookPen,
    Shirt,
    Settings,
    Sparkles,
    Swords,
    Link2,
    Users,
    Crosshair,
    ChevronDown,
    LayoutGrid,
} from 'lucide-preact';
import { signal } from '@preact-mvc/core';

const DRAG_THRESHOLD = 4; // px of movement before a press becomes a drag


// Shared press handling: a plain click runs the button's action; once the
// pointer moves past the threshold we hand off to the native caption-move
// loop — which then owns the rest of the gesture (mouseup never reaches
// the page, so no click fires).
function pressDrag(onPress: () => void) {
    let dragging = false;
    const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation(); // buttons handle their own press — not the grid's
        dragging = false;
        const sx = e.screenX;
        const sy = e.screenY;
        const onMove = (ev: MouseEvent) => {
            if (dragging) return;
            if (Math.hypot(ev.screenX - sx, ev.screenY - sy) > DRAG_THRESHOLD) {
                dragging = true;
                window.removeEventListener('mousemove', onMove, true);
                window.removeEventListener('mouseup', onUp, true);
                closeMenu(); // a bar drag strands a floating menu — drop it first
                host.drag(); // → xicompanion:drag
            }
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove, true);
            window.removeEventListener('mouseup', onUp, true);
        };
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
    };
    const onClick = () => {
        if (!dragging) onPress();
    };
    return { onMouseDown, onClick };
}

const BTN =
    'ffxi-fab grid h-10 w-10 shrink-0 place-items-center rounded-full transition';

type Icon = typeof Package;
interface FabItem {
    path: string;
    label: string;
    Icon: Icon;
}
interface FabGroup {
    key: string;
    label: string;
    Icon: Icon;
    items: FabItem[];
}

// page/panel fabs grouped by feature — combat tools, macros, quests,
// world, gear. Each dropdown toggles that feature's detached window(s).
const GROUPS: FabGroup[] = [
    {
        key: 'combat',
        label: 'party & combat',
        Icon: Swords,
        items: [
            { path: '/party', label: 'party', Icon: Users },
            { path: '/target', label: 'target', Icon: Crosshair },
            { path: '/cooldowns', label: 'cooldowns', Icon: Timer },
            { path: '/skillchain', label: 'skillchains', Icon: Link2 },
            { path: '/meter', label: 'meter', Icon: Timer },
            { path: '/abilities', label: 'spell book', Icon: Sparkles },
        ],
    },
    {
        key: 'macros',
        label: 'macros',
        Icon: Keyboard,
        items: [
            { path: '/macrobar', label: 'macro bar', Icon: Keyboard },
            { path: '/macros', label: 'macro editor', Icon: NotebookPen },
        ],
    },
    {
        key: 'quests',
        label: 'quests & objectives',
        Icon: ScrollText,
        items: [
            { path: '/journal', label: 'journal', Icon: BookOpen },
            { path: '/tracker', label: 'quest tracker', Icon: ScrollText },
        ],
    },
    {
        key: 'world',
        label: 'maps',
        Icon: MapIcon,
        items: [
            { path: '/map', label: 'map', Icon: MapIcon },
            { path: '/minimap', label: 'minimap', Icon: Radar },
        ],
    },
    {
        key: 'gear',
        label: 'gear',
        Icon: Package,
        items: [
            { path: '/', label: 'inventory', Icon: Package },
            { path: '/profile', label: 'gearswap sets', Icon: Shirt },
        ],
    },
];
// frequent/config pages stay as one-tap buttons
const PAGES: FabItem[] = [
    { path: '/chat', label: 'chat', Icon: MessageSquare },
    { path: '/settings', label: 'settings', Icon: Settings },
];

// ImagineXI's Panels popup — every window in one flat list, show/hide
// toggles. The button opens the shared menu in this pseudo-group.
const PANELS_GROUP: FabGroup = {
    key: 'panels',
    label: 'panels',
    Icon: LayoutGrid,
    items: [...GROUPS.flatMap((g) => g.items), ...PAGES],
};

// dropdown rows are ~30px + label header + padding — the menu window
// sizes itself to this on each show
const menuHeight = (g: FabGroup) => g.items.length * 30 + 34;
const MENU_W = 176; // w-44
const BAR_H = 56;

function Sep() {
    return <span class="h-6 w-px shrink-0 bg-indigo-200/30" />;
}

const menuKey = signal<string | null>(null);
const groupBtns = new Map<string, HTMLElement>();
// which group the shared menu window is rendering — retargeted by the
// shell's __xicMenu ExecJS
const menuGroup = signal(
    new URLSearchParams(location.search).get('g') ?? 'hud',
);
// which side of the bar the menu opened on — the card bottom-anchors
// when shown above so its edge always sits flush against the buttons
const menuUp = signal(
    new URLSearchParams(location.search).get('up') !== '0',
);
// set up the shell's hooks once per window context — the menu window
// gets __xicMenu retargets, the bar window gets __xicMenuClosed nudges
(window as any).__xicMenu = (g: string, up?: boolean) => {
    menuGroup.value = g;
    if (up !== undefined) menuUp.value = up;
};
(window as any).__xicMenuClosed = () => {
    fabMenuOpen.value = false;
    menuKey.value = null;
};

function closeMenu() {
    if (!fabMenuOpen.value) return;
    fabMenuOpen.value = false;
    menuKey.value = null;
    host.fabMenuHide();
}

function toggleMenu(g: FabGroup) {
    if (menuKey.value === g.key) return closeMenu();
    // the dropdown is its own always-hidden window — we just tell the
    // shell where to put it. Prefer above the bar (the fab usually parks
    // near the screen bottom), down only when the space above won't fit.
    const h = menuHeight(g);
    const scr = screen as Screen & { availTop: number; availLeft?: number };
    const btn = groupBtns.get(g.key);
    const r = btn?.getBoundingClientRect();
    // screenX/Y = window origin; the frameless webview fills the window
    const top = window.screenY + (r?.top ?? 0);
    const left = window.screenX + (r ? r.left + r.width / 2 - MENU_W / 2 : 0);
    const availL = scr.availLeft ?? 0;
    const up =
        top - h >= scr.availTop ||
        top + BAR_H + h > scr.availTop + scr.availHeight;
    const x = Math.round(
        Math.max(availL, Math.min(left, availL + scr.availWidth - MENU_W)),
    );
    const y = Math.round(up ? top - h : top + BAR_H);
    menuKey.value = g.key;
    fabMenuOpen.value = true;
    host.fabMenuShow(g.key, x, y, MENU_W, h, up);
}

export function Fab() {
    // drag from the gaps between buttons too — the container doubles as a
    // handle so there's no dead space in the bar
    const gap = pressDrag(() => { });
    const open = openWindows.value;

    const onContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        host.quit();
    };

    const bar = (
        <div
            class="flex h-14 w-full items-center justify-center gap-1"
            onMouseDown={gap.onMouseDown}
        >
            <Sep />
            {GROUPS.map((g) => (
                <button
                    ref={(el) => {
                        if (el) groupBtns.set(g.key, el);
                    }}
                    class={`${BTN}${g.items.some((p) => open.includes(p.path)) || menuKey.value === g.key ? ' on' : ''}`}
                    title={g.label}
                    {...pressDrag(() => toggleMenu(g))}
                >
                    <span class="flex items-center">
                        <g.Icon size={16} />
                        <ChevronDown size={10} class="-ml-0.5 opacity-70" />
                    </span>
                </button>
            ))}
            <Sep />
            {PAGES.map(({ path, label, Icon }) => (
                <button
                    class={`${BTN}${open.includes(path) ? ' on' : ''}`}
                    title={label}
                    {...pressDrag(() => {
                        closeMenu();
                        host.toggleWindow(path);
                    })}
                >
                    <Icon size={18} />
                </button>
            ))}
            <Sep />
            <button
                ref={(el) => {
                    if (el) groupBtns.set(PANELS_GROUP.key, el);
                }}
                class={`${BTN}${menuKey.value === PANELS_GROUP.key ? ' on' : ''}`}
                title="all panels — show/hide list"
                {...pressDrag(() => toggleMenu(PANELS_GROUP))}
            >
                <span class="flex items-center">
                    <LayoutGrid size={16} />
                    <ChevronDown size={10} class="-ml-0.5 opacity-70" />
                </span>
            </button>
        </div>
    );

    return (
        <div
            class="flex h-screen w-screen flex-col justify-center overflow-hidden bg-transparent"
            title="XI Companion — click toggles a window · drag to move · right-click to quit"
            onContextMenu={onContextMenu}
        >
            {bar}
        </div>
    );
}

// Renders inside the shared menu window (/fabmenu?window=1&g=<key>) —
// the bare dropdown, no chrome. The shell retargets an already-open
// menu over __xicMenu ExecJS instead of navigating.
export function FabMenu() {
    const g =
        GROUPS.find((x) => x.key === menuGroup.value) ??
        (menuGroup.value === PANELS_GROUP.key ? PANELS_GROUP : GROUPS[0]);
    const open = openWindows.value;
    return (
        <div
            class={cn(
                'flex h-screen w-screen flex-col overflow-hidden bg-transparent',
                menuUp.value ? 'justify-end' : 'justify-start',
            )}
        >
            <div class="w-full rounded border border-slate-600 bg-popover/95 py-1 shadow-lg">
                <p class="px-2 pb-0.5 pt-0.5 text-[9px] font-bold uppercase tracking-widest text-slate-400/70">
                    {g.label}
                </p>
                {g.items.map(({ path, label, Icon }) => (
                    <button
                        key={path}
                        class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-slate-100 hover:bg-slate-700/60"
                        onClick={() => {
                            host.toggleWindow(path);
                            host.fabMenuHide();
                        }}
                    >
                        <Icon size={14} />
                        <span class="flex-1">{label}</span>
                        {open.includes(path) && (
                            <span class="text-[8px] text-sky-300">●</span>
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
}
