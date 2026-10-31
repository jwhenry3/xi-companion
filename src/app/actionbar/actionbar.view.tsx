// Detached action bar — the abilities view's pinned actions (same
// xicompanion.abilities.pins keys) as draggable tiles on a 16px-snap
// grid. Positions persist in localStorage so each window layout is
// repeatable; click fires the action like the abilities use button.
import { Component, View, inject, signal } from '@preact-mvc/core';
import type { OnInit, OnDestroy } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import { host } from '../core/host';
import { iconUrl } from '../abilities/abilities.view';

const SNAP = 16;
const PINS_KEY = 'xicompanion.abilities.pins';
const POS_KEY = 'xicompanion.actionbar.pos';

const loadJson = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
};

type Pos = Record<string, { x: number; y: number }>;

@Component()
export class ActionBarView extends View implements OnInit, OnDestroy {
  private api = inject(AddonApi);
  private rows = signal<any[]>([]);
  private pos = signal<Pos>(loadJson(POS_KEY, {}));
  private dragging = signal(false);
  private drag: {
    key: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    active: boolean;
  } | null = null;

  // pins are written by the abilities window — storage events carry the
  // change across windows, so re-derive the tile set when they land
  private onStorage = (e: StorageEvent) => {
    if (e.key === PINS_KEY) this.refresh();
  };

  private rootEl: HTMLDivElement | null = null;

  // tiles are absolutely positioned — keep them inside the container so
  // nothing can overflow into scrollable space, and a smaller window
  // pulls stranded tiles back in
  private clamp = (x: number, y: number) => {
    const w = this.rootEl?.clientWidth ?? window.innerWidth;
    const h = this.rootEl?.clientHeight ?? window.innerHeight;
    return {
      x: Math.max(0, Math.min(x, Math.max(0, w - 44))),
      y: Math.max(0, Math.min(y, Math.max(0, h - 44))),
    };
  };

  private onResize = () => {
    const p = { ...this.pos.value };
    let changed = false;
    for (const k in p) {
      const c = this.clamp(p[k].x, p[k].y);
      if (c.x !== p[k].x || c.y !== p[k].y) {
        p[k] = c;
        changed = true;
      }
    }
    if (changed) {
      this.pos.value = p;
      localStorage.setItem(POS_KEY, JSON.stringify(p));
    }
  };

  onInit() {
    window.addEventListener('storage', this.onStorage);
    window.addEventListener('resize', this.onResize);
    this.refresh();
    // positions saved against window.innerWidth (pre-ref fallback) or
    // a larger window can sit past the padded container — normalize
    // once mounted so nothing ever overflows into scrollable space
    requestAnimationFrame(this.onResize);
    // detached-only route — no page-level scroll should ever exist
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    this.restoreOverflow = () => {
      document.documentElement.style.overflow = prev;
    };
  }

  private restoreOverflow: (() => void) | null = null;

  onDestroy() {
    window.removeEventListener('storage', this.onStorage);
    window.removeEventListener('resize', this.onResize);
    this.restoreOverflow?.();
  }

  private refresh() {
    const p = this.api.state.value?.player;
    void this.api
      .fetchAbilities(p?.main_job_id ?? 0, p?.sub_job_id ?? 0)
      .then((d) => {
        const pins = new Set(loadJson<string[]>(PINS_KEY, []));
        const all = [...(d?.spells ?? []), ...(d?.abilities ?? [])];
        this.rows.value = all.filter((e) => pins.has(`${e.pfx}|${e.n}`));
      });
  }

  private place(key: string, x: number, y: number) {
    const p = { ...this.pos.value, [key]: { x, y } };
    this.pos.value = p;
    localStorage.setItem(POS_KEY, JSON.stringify(p));
  }

  // drag arms on pointerdown but only engages past a movement
  // threshold — a plain click never enters drag mode (no grid flash,
  // no accidental tile move) and falls through to fire()
  private move = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 6)
        return;
      d.active = true;
      this.dragging.value = true;
    }
    const c = this.clamp(
      Math.round((e.clientX - d.ox) / SNAP) * SNAP,
      Math.round((e.clientY - d.oy) / SNAP) * SNAP,
    );
    this.pos.value = { ...this.pos.value, [d.key]: c };
  };

  private up = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    if (!d) return;
    if (d.active) {
      this.dragging.value = false;
      const p = this.pos.value[d.key];
      if (p) {
        const c = this.clamp(p.x, p.y);
        this.place(d.key, c.x, c.y);
      }
    } else this.fire(d.key, e);
  };

  private down(e: PointerEvent, key: string) {
    e.preventDefault();
    // pointer capture keeps move/up flowing even if the cursor leaves
    // the window — without it a release outside could strand the drag
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = this.pos.value[key] ?? { x: 0, y: 0 };
    this.drag = {
      key,
      sx: e.clientX,
      sy: e.clientY,
      ox: e.clientX - p.x,
      oy: e.clientY - p.y,
      active: false,
    };
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
  }

  private fire(key: string, e: PointerEvent) {
    const row = this.rows.value.find((r) => `${r.pfx}|${r.n}` === key);
    if (!row) return;
    const t =
      (e.button ?? 0) === 2 || row.tg === 1 || row.ty === 'Trust'
        ? '<me>'
        : '<t>';
    void this.api.sendCommand(`input ${row.pfx} "${row.n}" ${t}`);
  }

  private tile = (r: any) => {
    const key = `${r.pfx}|${r.n}`;
    const raw = this.pos.value[key] ?? { x: 16, y: 16 };
    const p = this.clamp(raw.x, raw.y);
    const u = iconUrl(this.api, r);
    return (
      <button
        key={key}
        class="absolute flex h-11 w-11 select-none items-end justify-center rounded border border-slate-500 bg-slate-950/90 px-0.5 pb-0.5 text-center text-[9px] leading-tight text-slate-100 hover:border-sky-400"
        style={{
          left: p.x + 'px',
          top: p.y + 'px',
          // icon fills the tile mostly clear — a dark gradient only at
          // the bottom keeps the name readable over bright art
          backgroundImage: u
            ? `linear-gradient(to top, rgb(2 6 23 / 0.9) 0%, rgb(2 6 23 / 0.3) 45%, transparent 70%), url("${u}")`
            : undefined,
          backgroundSize: 'cover',
          imageRendering: 'pixelated',
          textShadow: '0 1px 2px rgb(0 0 0 / 0.9)',
        }}
        title={`${r.n}\n${r.pfx} "${r.n}" <t>`}
        onPointerDown={(e) => this.down(e as PointerEvent, key)}
      >
        {r.n}
      </button>
    );
  };

  render() {
    return (
      <div
        ref={(el) => {
          this.rootEl = el;
        }}
        class="relative h-full w-full overflow-hidden"
        style={
          this.dragging.value
            ? {
                backgroundImage:
                  'linear-gradient(to right, rgba(148,163,184,.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,.08) 1px, transparent 1px)',
                backgroundSize: `${SNAP}px ${SNAP}px`,
              }
            : undefined
        }
      >
        {this.rows.value.length === 0 && (
          <p class="p-2 text-[11px] text-slate-500">
            pin actions in the abilities view to place them here
          </p>
        )}
        {this.rows.value.map(this.tile)}
      </div>
    );
  }
}
