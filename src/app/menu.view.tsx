// Spec menu — the shared dropdown window's page-spec'd content
// (?fabmenu&g=j:<json>). Any window can open a data-driven menu that
// escapes its own bounds (in-page popovers clip at the window edge);
// clicks post menu-pick:<id> and the shell relays them to the
// requesting window, then closes.
import { Component, View, signal } from '@preact-mvc/core';
import { useState } from 'preact/hooks';
import { host, THEMES, type MenuItem, type Theme } from './core/host';

// a prefs spec renders the staged popover layout (theme chips, scale/
// alpha sliders, save/revert) inside the shared window; an item array
// renders the flat pick list
export interface PrefsSpec {
  type: 'prefs';
  theme: Theme;
  scale: number;
  opacity: number;
}
type Spec = MenuItem[] | PrefsSpec;

// spec payloads may arrive URL-encoded (URL path) or plain (ExecJS
// retarget) — try decode first, raw as fallback
const parseSpec = (raw: string): Spec | null => {
  for (const s of [raw, (() => { try { return decodeURIComponent(raw); } catch { return raw; } })()]) {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v) || v?.type === 'prefs') return v;
    } catch { /* try next form */ }
  }
  return null;
};

const readSpec = (): Spec | null => {
  const g = new URLSearchParams(window.location.search).get('g') ?? '';
  if (!g.startsWith('j:')) return null;
  return parseSpec(g.slice(2));
};

// the staged popover layout, hosted in the shared window — save posts
// {prefs:{...}} back to the requester, revert posts the defaults
function PrefsPanel({ spec }: { spec: PrefsSpec }) {
  const [staged, setStaged] = useState({ ...spec });
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
  const btn =
    'rounded px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700 hover:text-slate-100';
  return (
    <div class="py-1 text-[11px] text-slate-200">
      <div class="flex flex-wrap gap-1 px-2 pb-1 pt-0.5">
        {THEMES.map((t) => (
          <button
            class={
              'rounded px-1.5 py-0.5 text-[10px] capitalize ' +
              (t === staged.theme
                ? 'bg-indigo-500/40 text-indigo-100'
                : 'text-slate-400 hover:bg-slate-700')
            }
            onClick={() => setStaged({ ...staged, theme: t })}
          >
            {t}
          </button>
        ))}
      </div>
      {row('scale', staged.scale, 0.5, 4, (n) =>
        setStaged({ ...staged, scale: n }),
      )}
      {row('alpha', staged.opacity, 0.3, 1, (n) =>
        setStaged({ ...staged, opacity: n }),
      )}
      <div class="mx-2 mt-0.5 flex justify-end gap-1">
        <button
          class={btn + ' bg-indigo-600/60 text-indigo-50'}
          onClick={() =>
            host.menuPick(
              JSON.stringify({
                prefs: {
                  theme: staged.theme,
                  scale: staged.scale,
                  opacity: staged.opacity,
                },
              }),
            )
          }
        >
          save
        </button>
        <button
          class={btn}
          title="restore defaults"
          onClick={() =>
            host.menuPick(
              JSON.stringify({
                prefs: { theme: 'classic', scale: 1, opacity: 1 },
              }),
            )
          }
        >
          revert
        </button>
      </div>
    </div>
  );
}
// where inside the fullscreen menu window the card draws — the shell
// spans the window over the virtual screen and passes the rect in its
// coords (URL params on create, __xicMenu args on retarget)
const readRect = () => {
  const p = new URLSearchParams(window.location.search);
  return {
    x: Number(p.get('x') ?? 0),
    y: Number(p.get('y') ?? 0),
    w: Number(p.get('w') ?? 200),
    h: Number(p.get('h') ?? 100),
    up: p.get('up') !== '0',
  };
};

@Component()
export class SpecMenu extends View {
  private spec = signal<Spec | null>(readSpec());
  private rect = signal(readRect());

  onInit() {
    window.addEventListener('xic-gameclick', this.gameClick);
    // same-kind retargets swap content over ExecJS — only spec
    // payloads belong to this component (group menus are FabMenu's)
    (window as any).__xicMenu = (
      g: string,
      _up?: boolean,
      x?: number,
      y?: number,
      w?: number,
      h?: number,
    ) => {
      if (x !== undefined && y !== undefined) {
        const r = this.rect.value;
        this.rect.value = {
          x,
          y,
          w: w ?? r.w,
          h: h ?? r.h,
          up: _up ?? r.up,
        };
      }
      if (!g?.startsWith('j:')) return;
      const v = parseSpec(g.slice(2));
      if (v) this.spec.value = v;
    };
  }

  onDestroy() {
    delete (window as any).__xicMenu;
    this.ro?.disconnect();
    window.removeEventListener('xic-gameclick', this.gameClick);
  }

  // watches the card itself — body resizes only on height, so a
  // widening submenu column never reported without this
  private ro = new ResizeObserver(() => {
    const el = document.getElementById('menucard');
    if (el) host.menuSize(el.offsetWidth, el.offsetHeight);
  });
  private gameClick = () => host.fabMenuHide();
  // expanded parent id — its children render in a second column;
  // the card widens and the menu-size snap grows the window to fit
  private hoverId = signal<string | null>(null);

  private row(it: MenuItem, sub = false) {
    const kids = !it.disabled && (it.children?.length ?? 0) > 0;
    const dis = !!it.disabled;
    return (
      <button
        key={it.id}
        disabled={dis}
        class={`flex w-full items-center gap-2 px-3 py-1 text-left ${
          dis
            ? 'cursor-default text-slate-600'
            : 'hover:bg-indigo-500/30 hover:text-white'
        }`}
        // submenu rows must not collapse their own parent — only the
        // main column steers hoverId
        onMouseEnter={() => {
          if (!sub) this.hoverId.value = kids ? it.id : null;
        }}
        onClick={() =>
          kids ? (this.hoverId.value = it.id) : host.menuPick(it.id)
        }
      >
        <span class="w-3 text-indigo-300">{it.checked ? '●' : ''}</span>
        <span class="min-w-0 flex-1 truncate">{it.label}</span>
        {kids ? (
          <span class="text-slate-500">›</span>
        ) : (
          it.hint && (
            <span class="shrink-0 text-[9px] text-slate-500">{it.hint}</span>
          )
        )}
      </button>
    );
  }

  render() {
    const s = this.spec.value;
    const sub = Array.isArray(s)
      ? s.find(
          (it) => it.id === this.hoverId.value && it.children?.length,
        )
      : undefined;
    return (
      // w-max so the card (and window) can grow to fit a submenu
      // column; outside clicks dismiss via xic-gameclick / interaction
      <div
        id="menucard"
        ref={(el) => {
          if (el) this.ro.observe(el);
        }}
        class="flex w-max flex-row rounded border border-slate-600 bg-slate-900/95 text-[11px] text-slate-200"
      >
        <div class="flex min-w-28 flex-col overflow-y-auto py-1">
          {s == null || (Array.isArray(s) && s.length === 0) ? (
            <p class="px-3 py-1 text-[10px] text-slate-500">empty</p>
          ) : !Array.isArray(s) ? (
            // key on the spec — the shared menu window persists across
            // requesters, and a mounted panel would otherwise keep the
            // previous window's staged theme/scale/alpha
            <PrefsPanel key={JSON.stringify(s)} spec={s} />
          ) : (
            s.map((it) => this.row(it))
          )}
        </div>
        {sub?.children && (
          <div class="flex min-w-28 flex-col overflow-y-auto border-l border-slate-700 py-1">
            {sub.children.map((it) => this.row(it, true))}
          </div>
        )}
      </div>
    );
  }
}
