// Settings: persisted addon preferences (data/settings.xml via
// /api/settings), overlay window geometry (xicompanion:geom -> the shell's
// window.json), and the UI theme (localStorage — applies on load in
// every window, including the tracker/tooltip).
import { Component, View, inject, signal, effect } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { Dropdown } from '../core/dropdown';
import { host, setTheme, shellGeom, theme, THEMES, getWinTheme, setWinTheme, showPlayerName, setPlayerNameVisible, type Theme } from '../core/host';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// detachable windows — fab-layer panels first, then the app pages
const WIN_THEME_ROUTES: [route: string, label: string][] = [
  ['/tracker', 'quest tracker'],
  ['/macrobar', 'macro bar'],
  ['/cooldowns', 'cooldowns'],
  ['/minimap', 'minimap'],
  ['/party', 'party'],
  ['/target', 'target'],
  ['/skillchain', 'skillchains'],
  ['/', 'inventory'],
  ['/chat', 'chat'],
  ['/journal', 'journal'],
  ['/map', 'map'],
  ['/macros', 'macro editor'],
  ['/profile', 'gearswap sets'],
  ['/settings', 'settings'],
];

@Component()
export class SettingsView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private settings = signal<Record<string, number | boolean | string> | null>(null);
  private err = signal<string | null>(null);
  private saved = signal('');
  // position editors — filled once when the shell's geom snapshot lands
  private geomLoaded = false;
  private fabPos = signal({ x: '', y: '' });
  private winRects = signal<Record<string, { x: string; y: string; w: string; h: string }>>({});
  private disposeGeom?: () => void;
  /** per-route theme picks — '' follows the global theme */
  private winThemes = signal<Record<string, Theme | ''>>({});

  onInit() {
    this.api
      .settingsGet()
      .then((s) => (this.settings.value = s))
      .catch((e) => (this.err.value = String(e)));
    const wt: Record<string, Theme | ''> = {};
    for (const [route] of WIN_THEME_ROUTES) wt[route] = getWinTheme(route) ?? '';
    this.winThemes.value = wt;
    if (host.inShell()) {
      this.disposeGeom = effect(() => {
        const g = shellGeom.value;
        if (!g || this.geomLoaded) return;
        this.geomLoaded = true;
        if (g.fab) {
          this.fabPos.value = { x: String(g.fab.x), y: String(g.fab.y) };
        }
        const rects: typeof this.winRects.value = {};
        for (const [key, r] of Object.entries(g.windows ?? {})) {
          rects[key] = {
            x: String(r.x),
            y: String(r.y),
            w: String(r.w),
            h: String(r.h),
          };
        }
        this.winRects.value = rects;
      });
      host.refreshGeom();
    }
  }

  onDestroy() {
    this.disposeGeom?.();
  }

  private flash(msg: string) {
    this.saved.value = msg;
    setTimeout(() => {
      if (this.saved.value === msg) this.saved.value = '';
    }, 1600);
  }

  private async save(patch: Record<string, number | boolean | string>) {
    try {
      await this.api.settingsSave(patch);
      this.settings.value = { ...(this.settings.value ?? {}), ...patch };
      this.flash('saved');
    } catch (e) {
      this.err.value = String(e);
    }
  }

  private boolRow(key: string, label: string, hint?: string) {
    const s = this.settings.value ?? {};
    return (
      <label class="flex items-center gap-2 py-1 text-sm text-slate-300">
        <input
          type="checkbox"
          checked={!!s[key]}
          onChange={(e) => void this.save({ [key]: e.currentTarget.checked })}
        />
        {label}
        {hint && <span class="text-[10px] text-slate-500">{hint}</span>}
      </label>
    );
  }

  private strRow(key: string, label: string, hint?: string) {
    const s = this.settings.value ?? {};
    return (
      <label class="flex items-center gap-2 py-1 text-sm text-slate-300">
        <span class="w-44 shrink-0">{label}</span>
        <Input
          class="w-32 font-mono"
          value={String(s[key] ?? '')}
          onChange={(e) =>
            void this.save({ [key]: e.currentTarget.value })
          }
        />
        {hint && <span class="text-[10px] text-slate-500">{hint}</span>}
      </label>
    );
  }

  private numRow(key: string, label: string, hint?: string) {
    const s = this.settings.value ?? {};
    return (
      <label class="flex items-center gap-2 py-1 text-sm text-slate-300">
        <span class="w-44 shrink-0">{label}</span>
        <Input
          class="w-24"
          value={String(s[key] ?? '')}
          onChange={(e) => {
            const v = Number(e.currentTarget.value);
            if (!Number.isNaN(v) && e.currentTarget.value.trim() !== '') {
              void this.save({ [key]: v });
            }
          }}
        />
        {hint && <span class="text-[10px] text-slate-500">{hint}</span>}
      </label>
    );
  }

  private posInput(v: string, set: (s: string) => void, ph: string) {
    return (
      <Input
        class="w-16 text-center"
        placeholder={ph}
        value={v}
        onInput={(e) => set(e.currentTarget.value)}
      />
    );
  }

  private applyFab() {
    const x = Number(this.fabPos.value.x);
    const y = Number(this.fabPos.value.y);
    if (Number.isNaN(x) || Number.isNaN(y)) return;
    host.setGeom('fab', { x, y });
    host.refreshGeom();
  }

  // ImagineXI's autolayout: pull the foreign-UI obstacle list, then  // ImagineXI's autolayout: pull the foreign-UI obstacle list, then
  // slot the fab + every open window into free screen zones (corners
  // and edges), avoiding xivbar/equipviewer/etc. and the retail chrome
  private async autolayout() {
    const W = screen.width;
    const H = screen.height;
    let obs: { x: number; y: number; w: number; h: number }[] = [];
    try {
      const r = await fetch(`/api/layout?w=${W}&h=${H}`);
      if (!r.ok) return;
      obs = ((await r.json()) as { obstacles: typeof obs }).obstacles ?? [];
    } catch {
      return; // route missing on an old addon — nothing to route around
    }
    const pad = 10;
    const used = obs.map((o) => ({
      x: o.x - pad,
      y: o.y - pad,
      w: o.w + 2 * pad,
      h: o.h + 2 * pad,
    }));
    const free = (x: number, y: number, w: number, h: number) =>
      x >= 0 && y >= 0 && x + w <= W && y + h <= H &&
      used.every((o) => x + w <= o.x || o.x + o.w <= x || y + h <= o.y || o.y + o.h <= y);
    const slotsFor = (key: string): [number, number][] =>
      key === 'fab'
        ? [[(W - 560) / 2, H - 140], [10, H - 130], [W - 570, H - 130], [(W - 560) / 2, 10]]
        : [
            [W - 350, 10], [10, 10], [10, H - 230], [W - 350, H - 230],
            [(W - 340) / 2, 10], [10, (H - 220) / 2], [W - 350, (H - 220) / 2],
          ];
    const rects = this.winRects.value;
    for (const key of ['fab', ...Object.keys(rects).sort()]) {
      const r =
        key === 'fab'
          ? { w: 560, h: 56 }
          : { w: Number(rects[key].w) || 300, h: Number(rects[key].h) || 200 };
      const slot = slotsFor(key).find(([x, y]) => free(x, y, r.w, r.h));
      if (!slot) continue;
      host.setGeom(key, { x: Math.round(slot[0]), y: Math.round(slot[1]) });
      used.push({ x: slot[0] - pad, y: slot[1] - pad, w: r.w + 2 * pad, h: r.h + 2 * pad });
    }
    host.refreshGeom();
  }

  private applyWindow(key: string) {
    const t = this.winRects.value[key];
    if (!t) return;
    const x = Number(t.x);
    const y = Number(t.y);
    const w = Number(t.w);
    const h = Number(t.h);
    if ([x, y].some(Number.isNaN)) return;
    host.setGeom(
      key,
      Number.isNaN(w) || Number.isNaN(h) ? { x, y } : { x, y, w, h },
    );
    host.refreshGeom();
  }

  private section(title: string, children: any, cls = '') {
    return (
      <section
        class={cn(
          'rounded border border-slate-800 bg-slate-950/60 p-4',
          cls,
        )}
      >
        <h3 class="pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {title}
        </h3>
        {children}
      </section>
    );
  }

  render() {
    const s = this.settings.value;
    const applyBtn =
      'rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-700 hover:text-slate-100';
    return (
      <div class="h-full overflow-y-auto">
        <div class="mx-auto grid max-w-3xl grid-cols-1 gap-4 p-2 lg:grid-cols-2">
          <div class="col-span-full flex items-center gap-3">
            <h2 class="text-sm font-semibold">Settings</h2>
            {this.saved.value && (
              <span class="text-[11px] text-emerald-400">
                {this.saved.value}
              </span>
            )}
            {this.err.value && (
              <span class="text-[11px] text-rose-400">{this.err.value}</span>
            )}
          </div>
          {!s ? (
            <p class="text-xs text-slate-500">loading…</p>
          ) : (
            <>
              {this.section(
                'Overlay',
                <>
                  {this.boolRow(
                    'tracker',
                    'quest tracker',
                    'auto-launch on login',
                  )}
                  {this.boolRow(
                    'macrobar',
                    'macro bar',
                    'auto-launch on login',
                  )}
                  {this.boolRow(
                    'minimap',
                    'minimap',
                    'auto-launch on login',
                  )}
                  {this.boolRow('party', 'party list', 'auto-launch on login')}
                  {this.boolRow('target', 'target bar', 'auto-launch on login')}
                  <label class="flex items-center gap-2 py-1 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={localStorage.getItem('xic.edit') === '1'}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        // shared localStorage key — 'storage' events arm
                        // every other overlay window automatically
                        localStorage.setItem('xic.edit', on ? '1' : '0');
                        document.body.classList.toggle('edit-mode', on);
                      }}
                    />
                    resize handles
                    <span class="text-[10px] text-slate-500">
                      show frame + corner markers on all windows
                    </span>
                  </label>
                  <label class="flex items-center gap-2 py-1 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={shellGeom.value?.scaleFollow !== false}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        // optimistic — the shell echoes its state back
                        // via __xicGeom; off also resets zoom to 100%
                        shellGeom.value = {
                          ...(shellGeom.value ?? {}),
                          scaleFollow: on,
                        };
                        host.setScaleFollow(on);
                      }}
                    />
                    follow game resize
                    <span class="text-[10px] text-slate-500">
                      scale window sizes + content with the FFXI window
                    </span>
                  </label>
                  <label class="flex items-center gap-2 py-1 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={showPlayerName.value}
                      onChange={(e) => setPlayerNameVisible(e.currentTarget.checked)}
                    />
                    player name
                    <span class="text-[10px] text-slate-500">
                      prefix window titles with your character name
                    </span>
                  </label>
                </>,
              )}
              {this.section(
                'Chat',
                <>
                  {this.numRow('chat_history', 'chat history per thread')}
                  {this.numRow('chat_tell_threads', 'tell threads kept')}
                </>,
              )}
              {host.inShell() &&
                this.section(
                  'Window positions',
                  <>
                    <div class="flex flex-wrap items-center gap-2 py-1 text-sm text-slate-300">
                      <span class="w-20 shrink-0">fab</span>
                      {this.posInput(this.fabPos.value.x, (v) =>
                        this.fabPos.value = { ...this.fabPos.value, x: v }, 'x')}
                      {this.posInput(this.fabPos.value.y, (v) =>
                        this.fabPos.value = { ...this.fabPos.value, y: v }, 'y')}
                      <button class={applyBtn} onClick={() => this.applyFab()}>
                        apply
                      </button>
                    </div>
                    {Object.keys(this.winRects.value)
                      .sort((a, b) =>
                        a === '/tracker' ? -1 : b === '/tracker' ? 1 : a.localeCompare(b),
                      )
                      .map((key) => {
                        const r = this.winRects.value[key];
                        const set = (f: 'x' | 'y' | 'w' | 'h') => (v: string) =>
                          (this.winRects.value = {
                            ...this.winRects.value,
                            [key]: { ...r, [f]: v },
                          });
                        return (
                          <div
                            key={key}
                            class="flex flex-wrap items-center gap-2 py-1 text-sm text-slate-300"
                          >
                            <span class="w-20 shrink-0 truncate" title={key}>
                              {key.replace(/^\//, '')}
                            </span>
                            {this.posInput(r.x, set('x'), 'x')}
                            {this.posInput(r.y, set('y'), 'y')}
                            {this.posInput(r.w, set('w'), 'w')}
                            {this.posInput(r.h, set('h'), 'h')}
                            <button
                              class={applyBtn}
                              onClick={() => this.applyWindow(key)}
                            >
                              apply
                            </button>
                          </div>
                        );
                      })}
                    <div class="flex items-center gap-3 pt-1">
                      <button class={applyBtn} onClick={() => void this.autolayout()}>
                        auto-arrange all
                      </button>
                      <span class="text-[10px] text-slate-500">
                        slots windows around other addons' UI (xivbar,
                        equipviewer, …) + the retail chat log
                      </span>
                    </div>
                    <p class="pt-1 text-[10px] text-slate-500">
                      persisted in the overlay's window.json — applying moves a
                      live window too
                    </p>
                  </>,
                  'lg:col-span-2',
                )}
              {this.section(
                'Theme',
                <div class="flex gap-2">
                  {THEMES.map((t) => (
                    <button
                      class={cn(
                        'rounded border px-3 py-1 text-xs capitalize',
                        theme.value === t
                          ? 'border-sky-500 bg-sky-950/40 text-sky-300'
                          : 'border-slate-700 text-slate-400 hover:text-slate-200',
                      )}
                      onClick={() => setTheme(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>,
              )}
              {this.section(
                'Window themes',
                <>
                  {WIN_THEME_ROUTES.map(([route, label]) => (
                    <div
                      key={route}
                      class="flex items-center gap-2 py-0.5 text-sm text-slate-300"
                    >
                      <span class="w-28 shrink-0">{label}</span>
                      <Dropdown
                        class="capitalize"
                        value={this.winThemes.value[route] ?? ''}
                        formatValue={(v) => v || 'default'}
                        options={[
                          { value: '', label: 'default' },
                          ...THEMES,
                        ]}
                        onChange={(v) => {
                          const t = v as Theme | '';
                          setWinTheme(route, t || null);
                          this.winThemes.value = {
                            ...this.winThemes.value,
                            [route]: t,
                          };
                        }}
                      />
                    </div>
                  ))}
                  <p class="pt-1 text-[10px] text-slate-500">
                    per-window overrides — "default" follows the global
                    theme; a live window picks the change up immediately
                  </p>
                </>,
              )}
            </>
          )}
        </div>
      </div>
    );
  }
}
