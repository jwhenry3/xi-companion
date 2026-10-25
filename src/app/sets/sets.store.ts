import { Injectable, inject, signal } from '@preact-mvc/core';
import { AddonApi } from '../core/addon-api.service';
import type { Bag, BagItem, InventoryState } from '../core/types';

// ---------------------------------------------------------------------------
// domain data — same shapes as src/ingame/store.ts so both UIs edit the same
// profile format (this is the plain-TS/regex port; the ingame copy is Lua-safe)
// ---------------------------------------------------------------------------

export interface EquipSlot {
  key: string;
  label: string;
  res: string;
}

// FFXI equipment window order, 4x4.
export const EQUIP_SLOTS: EquipSlot[] = [
  { key: 'main', label: 'Main', res: 'Main' },
  { key: 'sub', label: 'Sub', res: 'Sub' },
  { key: 'range', label: 'Range', res: 'Range' },
  { key: 'ammo', label: 'Ammo', res: 'Ammo' },
  { key: 'head', label: 'Head', res: 'Head' },
  { key: 'neck', label: 'Neck', res: 'Neck' },
  { key: 'ear1', label: 'L.Ear', res: 'Left Ear' },
  { key: 'ear2', label: 'R.Ear', res: 'Right Ear' },
  { key: 'body', label: 'Body', res: 'Body' },
  { key: 'hands', label: 'Hands', res: 'Hands' },
  { key: 'ring1', label: 'L.Ring', res: 'Left Ring' },
  { key: 'ring2', label: 'R.Ring', res: 'Right Ring' },
  { key: 'back', label: 'Back', res: 'Back' },
  { key: 'waist', label: 'Waist', res: 'Waist' },
  { key: 'legs', label: 'Legs', res: 'Legs' },
  { key: 'feet', label: 'Feet', res: 'Feet' },
];

// Common set-type paths, sectioned for the bindings picker; free text allowed.
export const GROUP_OPTIONS = [
  { section: 'Status', values: ['engaged', 'idle', 'idle.Town', 'idle.Field', 'resting', 'Kiting'] },
  { section: 'Defense', values: ['defense.PDT', 'defense.MDT', 'defense.MEva'] },
  {
    section: 'Precast',
    values: ['precast', 'precast.FC', 'precast.FC.Trust', 'precast.JA', 'precast.WS', 'precast.WS.Steps'],
  },
  {
    section: 'Midcast',
    values: [
      'midcast',
      'midcast.Healing',
      'midcast.Elemental',
      'midcast.Enfeebling',
      'midcast.Enhancing',
      'midcast.Dark',
      'midcast.Divine',
      'midcast.BlueMagic',
    ],
  },
  { section: 'Action', values: ['magicburst', 'buff'] },
];

export interface SetItemRef {
  bag: string; // position hint only — items move; matching is loose
  slot: number; // position hint only
  id: number;
  name: string;
  aug?: string[]; // sorted augment strings for same-name disambiguation
}

export interface GearSetDef {
  id: string;
  name: string;
  slots: Partial<Record<string, SetItemRef>>;
}

export interface FileSets {
  sets: GearSetDef[];
  bindings: Record<string, string>; // set-type path -> set id
}

export function setLabel(set: GearSetDef): string {
  return set.name !== '' ? set.name : '(unnamed)';
}

// ---------------------------------------------------------------------------
// item resolution — loose identity: prefer id, fall back to case-insensitive
// name for name-only (lua-imported) refs, disambiguate same-name by augments
// ---------------------------------------------------------------------------

export function normAugs(a?: Array<string | Record<string, unknown>>): string[] {
  return (a ?? []).filter((v): v is string => typeof v === 'string').sort();
}

function augsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!b || b.length === 0) return true; // ref carries no aug info — any item ok
  const A = a ?? [];
  return A.length === b.length && A.every((v, i) => v === b[i]);
}

export function itemMatches(st: InventoryState, it: BagItem, ref: SetItemRef): boolean {
  if (ref.id > 0) return it.id === ref.id;
  if (ref.name === '') return false;
  const meta = st.catalog[String(it.id)];
  return (meta?.name ?? '').toLowerCase() === ref.name.toLowerCase();
}

export function resolveItem(
  st: InventoryState,
  ref: SetItemRef,
): { bag?: Bag; item?: BagItem } {
  if (ref.bag !== '' && ref.slot > 0) {
    const bag = st.bags.find((x) => x.key === ref.bag);
    const item = bag?.items.find((i) => i.slot === ref.slot);
    if (item && itemMatches(st, item, ref)) return { bag, item };
  }
  let fallback: { bag?: Bag; item?: BagItem } | undefined;
  for (const b of st.bags) {
    for (const it of b.items) {
      if (!itemMatches(st, it, ref)) continue;
      if (augsEqual(normAugs(it.augments), ref.aug)) return { bag: b, item: it };
      if (!fallback) fallback = { bag: b, item: it };
    }
  }
  return fallback ?? {};
}

// ---------------------------------------------------------------------------
// lua generation — bound sets become sets.<path> = { slot='item', ... } lines
// inside a managed <xicompanion sets> block, spliced into get_sets()
// ---------------------------------------------------------------------------

function luaStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function luaSeg(seg: string): string {
  return /^[A-Za-z_]\w*$/.test(seg) ? `.${seg}` : `[${luaStr(seg)}]`;
}

const SLOT_KEYS = new Set(EQUIP_SLOTS.map((s) => s.key));

export function genSetsBlock(fs: FileSets): string {
  const lines: string[] = ['    -- <xicompanion sets>'];
  for (const key of Object.keys(fs.bindings).sort()) {
    const set = fs.sets.find((s) => s.id === fs.bindings[key]);
    if (!set) continue;
    const segs = key.split('.').filter(Boolean);
    if (segs.length === 0) continue;
    let path = 'sets';
    for (let i = 0; i < segs.length - 1; i++) {
      path += luaSeg(segs[i]);
      lines.push(`    ${path} = ${path} or {}`);
    }
    path += luaSeg(segs[segs.length - 1]);
    lines.push(`    ${path} = {`);
    for (const s of EQUIP_SLOTS) {
      const ref = set.slots[s.key];
      if (ref) lines.push(`        ${s.key}=${luaStr(ref.name)},`);
    }
    lines.push('    }');
  }
  // GearSwap never auto-equips sets.* — the profile's handlers must call
  // equip(). Inject minimal defaults ONLY where the file defines none, so a
  // bare profile swaps correctly while hand-written/Mote profiles stay intact.
  lines.push('    -- default handlers (skipped when the profile defines its own)');
  lines.push('    if type(status_change) ~= \'function\' then');
  lines.push('        status_change = function(new, old)');
  lines.push('            local s = sets[(new or \'\'):lower()]');
  lines.push('            if s then equip(s) end');
  lines.push('        end');
  lines.push('    end');
  lines.push('    if type(precast) ~= \'function\' then');
  lines.push('        precast = function(spell)');
  lines.push('            local p = sets.precast');
  lines.push('            if p then equip(p[spell.english] or p) end');
  lines.push('        end');
  lines.push('    end');
  lines.push('    if type(midcast) ~= \'function\' then');
  lines.push('        midcast = function(spell)');
  lines.push('            local m = sets.midcast');
  lines.push('            if m then equip(m[spell.english] or m[spell.skill] or m) end');
  lines.push('        end');
  lines.push('    end');
  lines.push('    if type(aftercast) ~= \'function\' then');
  lines.push('        aftercast = function(spell)');
  lines.push('            if sets.aftercast then equip(sets.aftercast) end');
  lines.push('            local s = sets[((player and player.status) or \'Idle\'):lower()]');
  lines.push('            if s then equip(s) end');
  lines.push('        end');
  lines.push('    end');
  lines.push('    -- </xicompanion>');
  return lines.join('\n');
}

// Splice blockLines just before get_sets()'s closing `end`. Tracks Lua block
// depth (function/then/do/repeat vs end/until); returns false when the file
// has no get_sets or the scan can't find its end.
function injectIntoGetSets(lines: string[], blockLines: string[]): boolean {
  const start = lines.findIndex((l) => /\bfunction\s+get_sets\b/.test(l));
  if (start < 0) return false;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const code = lines[i].replace(/--.*$/, '');
    let elseifs = 0;
    for (const m of code.matchAll(
      /\bfunction\b|\bthen\b|\bdo\b|\brepeat\b|\bend\b|\buntil\b|\belseif\b/g,
    )) {
      const t = m[0];
      if (t === 'elseif') {
        elseifs++;
        continue;
      }
      if (t === 'then' && elseifs > 0) {
        elseifs--;
        continue;
      }
      depth += t === 'end' || t === 'until' ? -1 : 1;
      if (depth === 0) {
        const cut = m.index;
        const prefix = lines[i].slice(0, cut).trimEnd();
        const rest = lines[i].slice(cut);
        if (prefix === '') {
          lines.splice(i, 1, ...blockLines, rest);
        } else {
          lines[i] = prefix;
          lines.splice(i + 1, 0, ...blockLines, rest);
        }
        return true;
      }
    }
  }
  return false;
}

// Strips every managed block plus its trailing newline. <gearswapui …> is
// the pre-rename marker — still matched so old profile blocks are replaced
// in place instead of left behind as stale duplicates.
function stripBlocks(content: string): string {
  return content.replace(
    /[ \t]*--\s*<(?:xicompanion|xic|gearswapui)[^>]*>[\s\S]*?--\s*<\/(?:xicompanion|xic|gearswapui)>\s*\n?/g,
    '',
  );
}

export function injectSetsBlock(content: string, fs: FileSets): string {
  const stripped = stripBlocks(content);
  const lines = stripped.split('\n');
  if (injectIntoGetSets(lines, genSetsBlock(fs).split('\n'))) {
    return lines.join('\n');
  }
  const sep = stripped.endsWith('\n') ? '\n' : '\n\n';
  // the guard isn't inside the managed markers so it survives stripBlocks —
  // only add it when the file doesn't already have one
  const hasGuard = /sets\s*=\s*sets\s+or\s*{\s*}/.test(stripped);
  return stripped + sep + (hasGuard ? '' : 'sets = sets or {}\n') + genSetsBlock(fs) + '\n';
}

// ---------------------------------------------------------------------------
// lua import — read sets.<path> = { slot='item', ... } back out of a profile
// ---------------------------------------------------------------------------

// Extracts the segments of a `sets.<path> = {` lvalue into dotted-key form,
// e.g. `.idle['Town']` -> 'idle.Town'; undefined on a non-sets line.
function parseSetsPath(line: string): string | undefined {
  const m = line.match(/^\s*sets([^=]*?)\s*=\s*{/);
  if (!m) return undefined;
  const segs: string[] = [];
  let rest = m[1];
  while (rest.length > 0) {
    const seg =
      rest.match(/^\s*\.\s*(\w+)/)?.[1] ??
      rest.match(/^\s*\[\s*'([^']*)'\s*\]/)?.[1] ??
      rest.match(/^\s*\[\s*"([^"]*)"\s*\]/)?.[1];
    if (seg === undefined) break;
    segs.push(seg);
    const eaten = rest.match(/^\s*(\.\s*\w+|\[\s*'[^']*'\s*\]|\[\s*"[^"]*"\s*\])/)!;
    rest = rest.slice(eaten[0].length);
  }
  return segs.length > 0 ? segs.join('.') : undefined;
}

// Parses `sets.<path> = { slot='item', ... }` blocks (multiline or inline);
// returns one entry per assignment. `or {}` guards and set_combine() merges
// don't match the lvalue pattern and are skipped naturally.
export function parseSetsLua(
  content: string,
): Array<{ key: string; slots: Record<string, string> }> {
  const out: Array<{ key: string; slots: Record<string, string> }> = [];
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const key = parseSetsPath(lines[i]);
    if (key === undefined) {
      i++;
      continue;
    }
    let body = '';
    let depth = 0;
    let done = false;
    while (i < lines.length && !done) {
      const code = lines[i].replace(/--.*$/, '');
      body += code + '\n';
      for (const ch of code) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth <= 0) {
            done = true;
            break;
          }
        }
      }
      i++;
    }
    const inner = body.match(/\{\s*([\s\S]*)\s*\}/)?.[1];
    if (inner === undefined) continue;
    const slots: Record<string, string> = {};
    // slot tables first: head={ name='X', augments={...} }
    for (const m of inner.matchAll(/(\w+)\s*=\s*\{[^{}]*name\s*=\s*'([^']*)'/g)) {
      slots[m[1]] = m[2];
    }
    for (const m of inner.matchAll(/(\w+)\s*=\s*'([^']*)'/g)) {
      if (slots[m[1]] === undefined) slots[m[1]] = m[2];
    }
    for (const m of inner.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
      if (slots[m[1]] === undefined) slots[m[1]] = m[2];
    }
    out.push({ key, slots });
  }
  return out;
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'xicompanion.sets.v2';
// pre-rename keys — read once for migration, never written
const LEGACY_V2_KEYS = ['xic.sets.v2', 'gsui.sets.v2'];
const LEGACY_V1_KEY = 'gsui.sets.v1';

function uid(): string {
  return (
    Date.now().toString(16) +
    Math.floor(Math.random() * 0xffffff).toString(16) +
    Math.floor(Math.random() * 0xffff).toString(16)
  );
}

@Injectable({ providedIn: 'root' })
export class SetsStore {
  private api = inject(AddonApi);

  /** all profiles' set data, keyed by gearswap-relative path */
  readonly files = signal<Record<string, FileSets>>({});
  readonly activeFile = signal<string | null>(null);
  readonly activeId = signal<string | null>(null);
  /** any file with unsaved edits */
  readonly dirty = signal(false);
  readonly saving = signal(false);
  readonly notice = signal<string | null>(null);

  private dirtyFiles = new Set<string>();
  private loaded = false;

  constructor() {
    this.load();
  }

  // ---- persistence ---------------------------------------------------------

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw =
        localStorage.getItem(STORAGE_KEY) ??
        LEGACY_V2_KEYS.map((k) => localStorage.getItem(k)).find((r) => r != null);
      if (raw) {
        const data = JSON.parse(raw) as {
          files?: Record<string, FileSets>;
          activeFile?: string;
          activeId?: string;
        };
        this.files.value = data.files ?? {};
        this.activeFile.value = data.activeFile ?? null;
        this.activeId.value = data.activeId ?? null;
      } else {
        this.migrateLegacy();
      }
    } catch {
      // corrupt storage — start fresh
    }
  }

  // v1 stored a global set list where group+name formed the sets.* path.
  private migrateLegacy() {
    try {
      const raw = localStorage.getItem(LEGACY_V1_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as {
        sets?: Array<GearSetDef & { group?: string }>;
        activeId?: string | null;
      };
      if (!data.sets?.length) return;
      const fs: FileSets = { sets: [], bindings: {} };
      for (const s of data.sets) {
        const set: GearSetDef = { id: s.id, name: s.name ?? '', slots: s.slots ?? {} };
        fs.sets.push(set);
        const key = s.group ? (s.name ? `${s.group}.${s.name}` : s.group) : s.name;
        if (key) fs.bindings[key] = set.id;
      }
      this.files.value = { _shared: fs };
      this.activeId.value = data.activeId ?? null;
    } catch {
      // ignore
    }
  }

  private persist() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        files: this.files.value,
        activeFile: this.activeFile.value,
        activeId: this.activeId.value,
      }),
    );
  }

  private markDirty() {
    this.dirty.value = true;
    const f = this.activeFile.value;
    if (f != null) this.dirtyFiles.add(f);
    this.persist();
  }

  private syncDirty() {
    this.dirty.value = this.dirtyFiles.size > 0;
  }

  flash(msg: string) {
    this.notice.value = msg;
    setTimeout(() => {
      if (this.notice.value === msg) this.notice.value = null;
    }, 4000);
  }

  // ---- file scope ------------------------------------------------------------

  curFile(): FileSets | undefined {
    const f = this.activeFile.value;
    if (f == null) return undefined;
    const all = this.files.value;
    if (!all[f]) {
      all[f] = { sets: [], bindings: {} };
      this.files.value = { ...all };
    }
    return this.files.value[f];
  }

  sets(): GearSetDef[] {
    return this.curFile()?.sets ?? [];
  }

  activeSet(): GearSetDef | undefined {
    return this.sets().find((s) => s.id === this.activeId.value);
  }

  /** select a profile; autosaves the previous one, auto-imports when empty */
  async selectFile(path: string | null) {
    if (this.activeFile.value === path) return;
    const prev = this.activeFile.value;
    this.activeFile.value = path;
    this.activeId.value = null;
    if (prev != null && this.dirtyFiles.has(prev)) {
      await this.saveFile(prev);
      this.syncDirty();
    }
    await this.maybeImport();
    this.persist();
  }

  // Selecting a file whose scope is empty pulls its sets.* assignments in
  // automatically. A populated scope is left alone so unsaved edits survive
  // file switching.
  private async maybeImport() {
    const path = this.activeFile.value;
    const fs = this.curFile();
    if (path == null || !fs || fs.sets.length > 0) return;
    if (Object.keys(fs.bindings).length > 0) return;
    try {
      const f = await this.api.readFile(path);
      this.importSets(parseSetsLua(f.content));
    } catch (e) {
      this.flash(`read failed: ${e}`);
    }
  }

  /** re-read sets.* from the active profile (explicit refresh) */
  async importActive(): Promise<number> {
    const path = this.activeFile.value;
    if (path == null) return 0;
    const f = await this.api.readFile(path);
    return this.importSets(parseSetsLua(f.content));
  }

  /** mount hook — runs the same import-if-empty check as file selection */
  init() {
    void this.maybeImport();
  }

  // ---- lua import merge -------------------------------------------------------

  // Each parsed sets.<path> assignment becomes a binding; existing bound sets
  // get their slots overwritten, new keys create a set named after the last
  // path segment.
  importSets(entries: Array<{ key: string; slots: Record<string, string> }>): number {
    const fs = this.curFile();
    if (!fs) return 0;
    let n = 0;
    for (const e of entries) {
      let setId = fs.bindings[e.key];
      let set = setId ? fs.sets.find((s) => s.id === setId) : undefined;
      if (!set) {
        const segs = e.key.split('.');
        set = { id: uid(), name: segs[segs.length - 1], slots: {} };
        fs.sets.push(set);
        setId = set.id;
        fs.bindings[e.key] = setId;
      }
      set.slots = {};
      for (const [k, v] of Object.entries(e.slots)) {
        if (SLOT_KEYS.has(k)) set.slots[k] = { bag: '', slot: 0, id: 0, name: v };
      }
      n++;
    }
    // nothing imported -> nothing changed; don't dirty the file just because
    // it was browsed (auto-save on switch would write an empty block)
    if (n > 0) {
      this.markDirty();
      this.files.value = { ...this.files.value };
    }
    return n;
  }

  // ---- save -------------------------------------------------------------------

  private async saveFile(path: string): Promise<boolean> {
    const fs = this.files.value[path];
    if (!fs) return false;
    try {
      const r = await this.api.readFile(path);
      await this.api.saveFile(path, injectSetsBlock(r.content, fs));
      this.dirtyFiles.delete(path);
      return true;
    } catch (e) {
      this.flash(`${path} save failed: ${e}`);
      return false;
    }
  }

  /** explicit save — splices the managed sets block into every dirty profile */
  async saveAll(): Promise<string> {
    this.saving.value = true;
    let written = 0;
    let failed = 0;
    for (const f of [...this.dirtyFiles]) {
      if (await this.saveFile(f)) written++;
      else failed++;
    }
    this.syncDirty();
    this.saving.value = false;
    this.persist();
    const msg = `saved — ${written} file(s) written${failed ? `, ${failed} failed` : ''}`;
    this.flash(msg);
    return msg;
  }

  // ---- mutations ------------------------------------------------------------

  private updateFile(fn: (fs: FileSets) => void) {
    const f = this.activeFile.value;
    if (f == null) return;
    const all = { ...this.files.value };
    const fs = all[f] ?? { sets: [], bindings: {} };
    fn(fs);
    all[f] = fs;
    this.files.value = all;
    this.markDirty();
  }

  create(name: string) {
    const id = uid();
    this.updateFile((fs) =>
      fs.sets.push({ id, name: name.trim() || 'new set', slots: {} }),
    );
    this.activeId.value = id;
  }

  rename(id: string, name: string) {
    this.updateFile((fs) => {
      const s = fs.sets.find((x) => x.id === id);
      if (s) s.name = name;
    });
  }

  remove(id: string) {
    this.updateFile((fs) => {
      fs.sets = fs.sets.filter((s) => s.id !== id);
      for (const k of Object.keys(fs.bindings)) {
        if (fs.bindings[k] === id) delete fs.bindings[k];
      }
    });
    if (this.activeId.value === id) {
      this.activeId.value = this.sets()[0]?.id ?? null;
    }
  }

  setActive(id: string | null) {
    this.activeId.value = id;
    this.persist();
  }

  assign(setId: string, slotKey: string, ref: SetItemRef | null) {
    this.updateFile((fs) => {
      const s = fs.sets.find((x) => x.id === setId);
      if (!s) return;
      if (ref) s.slots[slotKey] = ref;
      else delete s.slots[slotKey];
    });
  }

  bind(typeKey: string, setId: string) {
    const key = typeKey.trim();
    if (key === '') return;
    this.updateFile((fs) => {
      if (fs.sets.some((s) => s.id === setId)) fs.bindings[key] = setId;
    });
  }

  unbind(typeKey: string) {
    this.updateFile((fs) => {
      delete fs.bindings[typeKey];
    });
  }

  /** move a binding to a different type path, keeping the bound set */
  rebind(oldKey: string, newKey: string): boolean {
    const key = newKey
      .split('.')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('.');
    const fs = this.curFile();
    if (!fs || key === '' || key === oldKey) return false;
    if (fs.bindings[key] !== undefined) {
      this.flash(`${key} is already bound`);
      return false;
    }
    const id = fs.bindings[oldKey];
    if (id === undefined) return false;
    this.updateFile((f) => {
      delete f.bindings[oldKey];
      f.bindings[key] = id;
    });
    return true;
  }

  // ---- binding queries --------------------------------------------------------

  boundSet(typeKey: string, fs = this.curFile()): GearSetDef | undefined {
    const id = fs?.bindings[typeKey];
    return id !== undefined ? fs?.sets.find((s) => s.id === id) : undefined;
  }

  bindingKeys(fs = this.curFile()): string[] {
    return Object.keys(fs?.bindings ?? {}).sort();
  }

  /** set-type paths bound to the given set — used by the equip action */
  bindingsOf(setId: string): string[] {
    const fs = this.curFile();
    if (!fs) return [];
    return Object.keys(fs.bindings)
      .filter((k) => fs.bindings[k] === setId)
      .sort();
  }
}
