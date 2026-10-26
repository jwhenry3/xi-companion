// End-to-end smoke test for addon/xicompanion/xicompanion.lua.
//
// Runs the real addon under fengari (Lua 5.3 in JS) with stubbed windower /
// res / config globals and a `socket` module backed by node:net, then drives
// real HTTP requests against it. Usage: `node scripts/smoke-test.mjs`.

import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, readFileSync, openSync, closeSync, fstatSync, readSync, writeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

const { LUA_REGISTRYINDEX, LUA_OK, LUA_MULTRET, LUA_TSTRING, LUA_TNUMBER, LUA_TBOOLEAN, LUA_TFUNCTION, LUA_TTABLE } = lua;

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const addonDir = join(repoRoot, 'addon', 'xicompanion');
const addonFile = join(addonDir, 'xicompanion.lua');
const uiDir = join(addonDir, 'ui');
assert.ok(existsSync(join(uiDir, 'index.html')), 'run `npm run build:addon` first — ui/index.html missing');

// Fake Windower root with a GearSwap data dir.
const fakeRoot = mkdtempSync(join(tmpdir(), 'xicompanion-'));
const gsData = join(fakeRoot, 'addons', 'GearSwap', 'data');
mkdirSync(gsData, { recursive: true });
writeFileSync(join(gsData, 'DUMMY.lua'), '-- dummy\n');
mkdirSync(join(gsData, 'Tester'), { recursive: true });
const WAR_LUA = [
  '-- tester war',
  'sets = {}',
  'function get_sets()',
  "    sets.idle = { main = 'Test Sword' }",
  "    sets.idle.Town = { head = 'Test Helm' }",
  '    sets.engaged = {}',
  '    sets.precast = {}',
  '    sets.precast.FC = {}',
  '    sets.precast["Utsusemi: Ichi"] = { main = \'Test Sword\' }',
  '    -- sets.commented.Out = {} -- should not appear',
  '    if sets.engaged == nil then end',
  'end',
].join('\n') + '\n';
writeFileSync(join(gsData, 'Tester', 'WAR.lua'), WAR_LUA);

// Fake FFXI install with a USER/<content id> macro dir. Fixtures are built
// in the real on-disk format (verified against retail files):
//   24B header (u32 ver + u32 field + md5 of bytes 24+) + 4B zero gap
//   + 20 records x (6 x 61B lines + 8B name + pad) — last record 2B pad
//   mcr.ttl: 24B header + 20 x 16B book titles
const crypto = await import('node:crypto');
const ffxiDir = join(fakeRoot, 'ffxi');
const macroDir = join(ffxiDir, 'USER', 'deadbee');
mkdirSync(macroDir, { recursive: true });
const MD5_OFF = 24;
const mcrHdr = (body) =>
  Buffer.concat([
    Buffer.from([1, 0, 0, 0, 0x7e, 0x3b, 0xb7, 0x44]),
    crypto.createHash('md5').update(body).digest(),
  ]);
function buildPalette(macros) {
  const parts = [Buffer.alloc(4)]; // zero gap after the md5
  for (let i = 0; i < 20; i++) {
    const m = macros[i] ?? {};
    for (let j = 0; j < 6; j++) {
      const b = Buffer.alloc(61);
      b.write(String(m.lines?.[j] ?? '').slice(0, 60), 'latin1');
      parts.push(b);
    }
    const nb = Buffer.alloc(8);
    nb.write(String(m.name ?? '').slice(0, 8), 'latin1');
    parts.push(nb, Buffer.alloc(i < 19 ? 6 : 2));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([mcrHdr(body), body]);
}
function buildTitles(titles) {
  const parts = [];
  for (let i = 0; i < 20; i++) {
    const t = Buffer.alloc(16);
    t.write(String(titles[i] ?? `Book ${i + 1}`).slice(0, 16), 'latin1');
    parts.push(t);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([mcrHdr(body), body]);
}
writeFileSync(join(macroDir, 'mcr.dat'), buildPalette([
  { name: 'TestMcr', lines: ['/say hello', '', '', '', '', ''] },
  { name: 'AT', lines: ['\xfd\x02\x02\x12\x34\xfd rest', '', '', '', '', ''] },
]));
writeFileSync(join(macroDir, 'mcr10.dat'), buildPalette([
  { name: 'Stone', lines: ['/console stone', '', '', '', '', ''] },
]));
writeFileSync(join(macroDir, 'mcr.ttl'), buildTitles(['Book 1', 'RDM']));
// mcr.sys: the client's active-palette marker — same 28B format
// (header + u32 file index @24). Index 20 -> book 3, page 1.
{
  const sel = Buffer.alloc(4);
  sel.writeUInt32LE(20);
  writeFileSync(join(macroDir, 'mcr.sys'), Buffer.concat([mcrHdr(sel), sel]));
}

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

// ---------- helpers for pushing JS values ----------

function push(v) {
  if (v == null) lua.lua_pushnil(L);
  else if (typeof v === 'boolean') lua.lua_pushboolean(L, v);
  else if (typeof v === 'number') lua.lua_pushnumber(L, v);
  else if (typeof v === 'string') lua.lua_pushstring(L, to_luastring(v));
  else if (v instanceof Uint8Array) lua.lua_pushlstring(L, v, v.length);
  else if (typeof v === 'function') lua.lua_pushjsfunction(L, v);
  else if (Array.isArray(v)) {
    lua.lua_createtable(L, v.length, 0);
    v.forEach((item, i) => {
      push(item);
      lua.lua_rawseti(L, -2, i + 1);
    });
  } else if (typeof v === 'object') {
    lua.lua_createtable(L, 0, Object.keys(v).length);
    for (const [k, val] of Object.entries(v)) {
      push(val);
      if (/^\d+$/.test(k)) {
        // Numeric key: swap to rawseti-style numeric keying.
        const i = Number(k);
        lua.lua_pushnumber(L, i);
        lua.lua_insert(L, -2);
        lua.lua_rawset(L, -3);
      } else {
        lua.lua_setfield(L, -2, to_luastring(k));
      }
    }
  }
  return 1;
}

// lua bytes -> js string: utf-8 when valid, byte-faithful latin1 when not
// (wire FD bytes etc. would otherwise throw in to_jsstring)
function jsstr(u8) {
  try {
    return to_jsstring(u8);
  } catch {
    return Array.from(u8, (b) => String.fromCharCode(b)).join('');
  }
}

function jsval(i) {
  const t = lua.lua_type(L, i);
  if (t === LUA_TNUMBER) return lua.lua_tonumberx(L, i, null);
  if (t === LUA_TBOOLEAN) return lua.lua_toboolean(L, i);
  if (t === LUA_TSTRING) {
    const s = jsstr(lauxlib.luaL_tolstring(L, i, null));
    // luaL_tolstring pushes a copy like its C counterpart — drop it so
    // callers iterating with lua_next keep a balanced stack
    lua.lua_pop(L, 1);
    return s;
  }
  return null;
}

// js function factory: body receives arg values, returns pushed result count
function fn(body) {
  return (L) => {
    const n = lua.lua_gettop(L);
    const args = [];
    for (let i = 1; i <= n; i++) args.push(jsval(i));
    return push(body(...args));
  };
}

// ---------- socket module over node:net ----------

const clientWrap = new WeakMap();

function wrapClient(c) {
  if (clientWrap.has(c)) return clientWrap.get(c);
  const w = { c, buf: Buffer.alloc(0), ended: false };
  c.on('data', (d) => (w.buf = Buffer.concat([w.buf, d])));
  c.on('end', () => (w.ended = true));
  c.on('close', () => (w.ended = true));
  const tbl = {
    settimeout: fn(() => true),
    setoption: fn(() => true),
    getsockname: fn(() => push('127.0.0.1') + 0), // unused
    close: fn(() => {
      c.destroy();
      return null;
    }),
    receive: (L) => {
      const n = jsval(2) ?? 0;
      if (w.buf.length > 0) {
        const take = n > 0 ? Math.min(n, w.buf.length) : w.buf.length;
        const out = w.buf.subarray(0, take);
        w.buf = w.buf.subarray(take);
        lua.lua_pushlstring(L, new Uint8Array(out), out.length);
        return 1;
      }
      if (w.ended) {
        lua.lua_pushnil(L);
        lua.lua_pushstring(L, to_luastring('closed'));
        lua.lua_pushstring(L, to_luastring(''));
        return 3;
      }
      lua.lua_pushnil(L);
      lua.lua_pushstring(L, to_luastring('timeout'));
      lua.lua_pushstring(L, to_luastring(''));
      return 3;
    },
    send: (L) => {
      // luaL_checklstring returns the raw Lua bytes (Uint8Array) — keep byte
      // fidelity or the reported byte count won't match Lua's #data.
      const data = lauxlib.luaL_checklstring(L, 2, null);
      const i = jsval(3) ?? 1;
      const bytes = Buffer.from(data.subarray(i - 1));
      try {
        if (c.destroyed) throw new Error('destroyed');
        c.write(bytes);
        lua.lua_pushnumber(L, i - 1 + bytes.length); // last index written
        return 1;
      } catch {
        lua.lua_pushnil(L);
        lua.lua_pushstring(L, to_luastring('closed'));
        lua.lua_pushnumber(L, i - 1);
        return 3;
      }
    },
  };
  clientWrap.set(c, tbl);
  return tbl;
}

const socketModule = {
  bind: (L) => {
    const host = to_jsstring(lauxlib.luaL_checklstring(L, 1, null));
    const port = lua.lua_tonumberx(L, 2, null);
    const srv = createServer();
    const pending = [];
    // writes to dead sockets emit async 'error' events — swallow them;
    // lua-side failure is reported through send()'s nil+err return
    srv.on('connection', (c) => {
      c.on('error', () => {});
      pending.push(c);
    });
    try {
      srv.listen(port, host);
    } catch (e) {
      lua.lua_pushnil(L);
      lua.lua_pushstring(L, to_luastring(String(e)));
      return 2;
    }
    const tbl = {
      settimeout: fn(() => true),
      setoption: fn(() => true),
      getsockname: fn(() => {
        lua.lua_pushstring(L, to_luastring(host));
        lua.lua_pushnumber(L, port);
        return 2;
      }),
      close: fn(() => {
        srv.close();
        return null;
      }),
      accept: (L) => {
        const c = pending.shift();
        if (!c) {
          lua.lua_pushnil(L);
          lua.lua_pushstring(L, to_luastring('timeout'));
          return 2;
        }
        return push(wrapClient(c));
      },
    };
    return push(tbl);
  },
};

// ---------- windower / res / config stubs ----------

const events = new Map(); // name -> [lua refs]
const chats = [];
const commands = [];

// resources post-processes bitmasks into S sets: jobs/slots hold member ids
// as keys, flags holds flag-name strings as keys.
const ITEM = {
  12345: {
    id: 12345, en: 'Test Helm', enl: 'test helm', category: 'Armor',
    level: 99, ilvl: 119, jobs: { 1: true }, slots: { 4: true },
    flags: { Rare: true, Exclusive: true }, stack: 1,
  },
  22222: {
    id: 22222, en: 'Test Sword', category: 'Weapon', level: 99, ilvl: 119,
    jobs: { 1: true }, slots: { 0: true }, flags: {}, stack: 1,
  },
  // AT item phrases resolve against res.items — including ids newer
  // than the installed auto_translates table
  26367: { id: 26367, en: 'Null Belt', category: 'Armor' },
  // id with a 0x00 low byte — goes over the wire masked (type 0x0A)
  768: { id: 768, en: 'Bronze Mask', category: 'Armor' },
};

const resModule = {
  items: ITEM,
  item_descriptions: {
    12345: { id: 12345, en: 'DEF:45 HP+30 STR+6\nTest helm flavor text.' },
  },
  jobs: { 1: { ens: 'WAR', en: 'Warrior' }, 13: { ens: 'NIN', en: 'Ninja' } },
  slots: { 0: { en: 'Main' }, 1: { en: 'Sub' }, 4: { en: 'Head' } },
  bags: {},
  zones: {
    100: { id: 100, en: 'West Ronfaure' },
    166: { id: 166, en: 'Ranguemont Pass' },
  },
  auto_translates: {
    267: { id: 267, en: 'Hello!', ja: 'こんにちは。' },
  },
  key_items: {
    2914: { id: 2914, en: 'Test Permit' },
  },
  ability_recasts: {
    1: { id: 1, en: 'Berserk', action_id: 31 },
  },
  job_abilities: {
    31: { id: 31, en: 'Berserk' },
    35: { id: 35, en: 'Provoke', prefix: '/jobability', targets: 32 },
  },
  weapon_skills: {
    1: { id: 1, en: 'Combo', prefix: '/weaponskill', targets: 32 },
  },
  spells: {
    4: { id: 4, en: 'Cure IV', recast: 8, levels: { 1: 41 }, mp_cost: 88, prefix: '/magic' },
    // NIN-job spell — exercises the subjob obtainable path (req*2)
    338: { id: 338, en: 'Utsusemi: Ichi', levels: { 13: 12 }, mp_cost: 0, prefix: '/ninjutsu' },
  },
};

const bags = {
  0: {
    enabled: true, max: 80, count: 2,
    items: {
      1: { id: 12345, count: 1, status: 0, slot: 1 },
      2: { id: 22222, count: 1, status: 5, slot: 2 },
    },
  },
  8: {
    enabled: true, max: 80, count: 1,
    items: { 1: { id: 22222, count: 1, status: 0, slot: 1 } },
  },
  1: { enabled: false, max: 80, count: 0, items: {} },
};

// Bag id -> windower.ffxi bag key, mirroring the addon's BAGS table.
const BAG_KEYS = { 0: 'inventory', 1: 'safe', 8: 'wardrobe' };

let loggedIn = false;
// npc/mob index -> entity
const mobs = {};
let targetIndex = 0; // mob index get_mob_by_target('t') resolves
// the player's own index in the stubbed mob array — map.poll() reads
// mobs[meIndex].mapPos for the player dot
const meIndex = 0x101;
// live-mutated recast tables — {recast_id: secs} / {spell_id: secs}
const abilityRecasts = {};
const spellRecasts = {};

const windower = {
  addon_path: addonDir + '\\',
  windower_path: fakeRoot + '\\',
  ffxi_path: ffxiDir + '\\',
  ffxi: {
    get_info: fn(() => ({ logged_in: loggedIn })),
    get_player: fn(() => ({
      name: 'Tester', main_job_id: 1, main_job_level: 99,
      sub_job_id: 13, sub_job_level: 49,
    })),
    get_bag_info: fn((id) => {
      if (id == null) {
        const all = {};
        for (const [bid, b] of Object.entries(bags)) {
          all[BAG_KEYS[bid] ?? bid] = { enabled: b.enabled, max: b.max, count: b.count };
        }
        return all;
      }
      const b = bags[id];
      return b ? { enabled: b.enabled, max: b.max, count: b.count } : null;
    }),
    get_mob_by_index: fn((i) => mobs[i] ?? null),
    get_ability_recasts: fn(() => abilityRecasts),
    get_spell_recasts: fn(() => spellRecasts),
    // learned sets for the ability book — JA 31 learned, 35 not;
    // WS 1 learned; spell 4 learned, 338 not (subjob-obtainable)
    get_abilities: fn(() => ({ job_abilities: [31], weapon_skills: [1] })),
    // id->bool map: 338's false must NOT mark it learned (regression:
    // falsy values used to set learned_sp[k]=true → everything learned)
    get_spells: fn(() => ({ 4: true, 338: false })),
    // 'me' resolves to the player's mob record; get_map_data projects
    // world coords into the client's map-pixel space. Raw jsfunction —
    // fn() returns one value, this needs three.
    get_mob_by_target: fn((t) =>
      t === 'me' ? mobs[meIndex] : t === 't' ? mobs[targetIndex] : null,
    ),
    // party roster for the /party feed — p0 self + one member with a
    // mob id the 0x076 buff packet can attribute to
    get_party: fn(() => ({
      p0: { name: 'Tester', hpp: 92, mpp: 61, tp: 1400, zone: 100, mob: { id: meIndex } },
      p1: { name: 'Allymate', hp: 1100, hpp: 88, mp: 300, mpp: 45, tp: 350, zone: 100, mob: { id: 0x1000 } },
    })),
    get_map_data: (L) => {
      const n = lua.lua_gettop(L);
      let mid = 0, mx = 0, my = 0;
      if (n >= 3) {
        // world x,y,z — x/y are the horizontal plane (z is height), the
        // stub maps 1:1 into map px (+256 centering)
        mx = (jsval(1) ?? 0) + 256;
        my = (jsval(2) ?? 0) + 256;
      } else {
        // by entity index — index -> [map_id, x, y]
        const pos = mobs[jsval(1)]?.mapPos;
        if (pos) [mid, mx, my] = pos;
      }
      push(mid); push(mx); push(my);
      return 3;
    },
    get_mob_array: fn(() => mobs),
    get_items: fn((id) => {
      if (id == null) {
        const all = {};
        for (const [bid, b] of Object.entries(bags)) {
          all[BAG_KEYS[bid] ?? bid] = { ...b.items, max: b.max };
        }
        return all;
      }
      const b = bags[id];
      return b ? { ...b.items, max: b.max } : {};
    }),
  },
  add_to_chat: fn((_mode, msg) => {
    chats.push(msg);
    console.log('  [chat]', msg);
    return null;
  }),
  register_event: (L) => {
    const n = lua.lua_gettop(L);
    const ref = (() => {
      lua.lua_pushvalue(L, n);
      return lauxlib.luaL_ref(L, LUA_REGISTRYINDEX);
    })();
    for (let i = 1; i < n; i++) {
      const name = to_jsstring(lauxlib.luaL_checklstring(L, i, null));
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(ref);
    }
    return 0;
  },
  send_command: fn((s) => {
    commands.push(s);
    return null;
  }),
  open_url: fn((u) => {
    console.log('  [open_url]', u);
    return null;
  }),
  dir_exists: fn((p) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  }),
  // extracted icon bmps are treated as already on disk so itemIcon() resolves
  // without the real icon_extractor + FFXI dats
  file_exists: fn((p) => existsSync(p) || /\.bmp$/i.test(p)),
  create_dir: fn((p) => {
    mkdirSync(p, { recursive: true });
    return true;
  }),
  get_dir: fn((p) => {
    try { return readdirSync(p); } catch { return {}; }
  }),
  // mcr*.dat stamp map — the departure-watch diffs these per poll
  file_mtimes: fn((dir) => {
    const out = {};
    try {
      for (const f of readdirSync(dir))
        if (/^mcr\d*\.dat$/.test(f))
          out[f] = String(statSync(join(dir, f)).mtimeMs);
    } catch {}
    return out;
  }),
  get_windower_settings: fn(() => ({ ui_x_res: 1920, ui_y_res: 1080 })),
};

function fireEvent(name, ...args) {
  let last;
  const top0 = lua.lua_gettop(L);
  for (const ref of events.get(name) ?? []) {
    lua.lua_rawgeti(L, LUA_REGISTRYINDEX, ref);
    for (const a of args) push(a);
    const rc2 = lua.lua_pcall(L, args.length, 1, 0);
    if (rc2 !== LUA_OK) {
      const msg = jsstr(lauxlib.luaL_tolstring(L, -1, null));
      lua.lua_pop(L, 2); // error object + converted copy
      throw new Error(`event ${name} failed: ${msg}`);
    }
    last = lua.lua_toboolean(L, -1);
    lua.lua_pop(L, 1);
  }
  if (process.env.GSUI_DEBUG && lua.lua_gettop(L) !== top0) {
    console.log(`[stack] ${name}: ${top0} -> ${lua.lua_gettop(L)} (abs top=${L.top} ci.top=${L.ci.top} funcOff=${L.ci.funcOff})`);
  }
  return last;
}

// ---------- load the addon ----------

lua.lua_createtable(L, 0, 4);
lua.lua_setglobal(L, to_luastring('_addon'));
push(windower);
lua.lua_setglobal(L, to_luastring('windower'));

// fengari's io table lacks io.open — back it with node fs.
lua.lua_getglobal(L, to_luastring('io'));
lua.lua_pushjsfunction(L, (L) => {
  const path = to_jsstring(lauxlib.luaL_checklstring(L, 1, null));
  const mode = jsval(2) || 'r';
  let fd;
  try {
    fd = openSync(path, mode.startsWith('w') ? 'w' : 'r');
  } catch (e) {
    lua.lua_pushnil(L);
    lua.lua_pushstring(L, to_luastring(String(e)));
    return 2;
  }
  const handle = {
    read: (L) => {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      lua.lua_pushlstring(L, new Uint8Array(buf), size);
      return 1;
    },
    write: (L) => {
      const s = lauxlib.luaL_checklstring(L, 2, null);
      writeSync(fd, Buffer.from(s));
      lua.lua_pushvalue(L, 1);
      return 1;
    },
    close: fn(() => {
      closeSync(fd);
      return true;
    }),
  };
  return push(handle);
});
lua.lua_setfield(L, -2, to_luastring('open'));
lua.lua_pop(L, 1);

// package.loaded stubs so `require` returns our modules directly
lauxlib.luaL_getsubtable(L, lua.LUA_REGISTRYINDEX, to_luastring('_LOADED'));
push(socketModule);
lua.lua_setfield(L, -2, to_luastring('socket'));
push(resModule);
lua.lua_setfield(L, -2, to_luastring('resources'));
// packets.new('outgoing', id, {fields}) / packets.inject(p) — capture
// the injected packets so RoE mark/unmark can be asserted
const injectedPackets = [];
push({
  new: (L) => {
    const dir = jsval(1);
    const id = jsval(2);
    const fields = {};
    if (lua.lua_type(L, 3) === LUA_TTABLE) {
      lua.lua_pushnil(L);
      while (lua.lua_next(L, 3) !== 0) {
        const k = jsval(-2);
        fields[k == null ? '?' : String(k)] = jsval(-1);
        lua.lua_pop(L, 1);
      }
    }
    return push({ dir, id, fields });
  },
  inject: (L) => {
    const p = {};
    for (const k of ['dir', 'id']) {
      lua.lua_getfield(L, 1, to_luastring(k));
      p[k] = jsval(-1);
      lua.lua_pop(L, 1);
    }
    lua.lua_getfield(L, 1, to_luastring('fields'));
    p.fields = {};
    if (lua.lua_type(L, -1) === LUA_TTABLE) {
      lua.lua_pushnil(L);
      while (lua.lua_next(L, -2) !== 0) {
        const k = jsval(-2);
        p.fields[k == null ? '?' : String(k)] = jsval(-1);
        lua.lua_pop(L, 1);
      }
    }
    lua.lua_pop(L, 1);
    injectedPackets.push(p);
    return 0;
  },
});
lua.lua_setfield(L, -2, to_luastring('packets'));
push({
  load: (L) => {
    lua.lua_pushvalue(L, 1); // return the defaults table unchanged
    return 1;
  },
  save: fn(() => null),
});
lua.lua_setfield(L, -2, to_luastring('config'));

// `config` override pinning the server to a quiet test port (the real addon
// may be running in-game on 17890 while this test executes).
const configStub = `
package.loaded['config'] = {
    load = function(defaults)
        local copy = {}
        for k, v in pairs(defaults) do copy[k] = v end
        copy.port = 18791
        return copy
    end,
    save = function() end,
}
`;

{
  const rc = lauxlib.luaL_dostring(L, to_luastring(configStub));
  assert.equal(rc, LUA_OK, 'config stub failed: ' + to_jsstring(lauxlib.luaL_tolstring(L, -1, null)));
}
lua.lua_settop(L, 0); // clear any stub leftovers before loading the addon
lua.lua_settop(L, 0); // clear any stub leftovers before loading the addon

// package.path += <addon>/? so sibling modules (macros.lua) resolve the
// same way Windower resolves them for a loaded addon.
lauxlib.luaL_dostring(
  L,
  to_luastring(`package.path = package.path .. ';${addonDir.replace(/\\/g, '/')}/?.lua'`),
);

const rc = lauxlib.luaL_dofile(L, to_luastring(addonFile));
if (rc !== LUA_OK) {
  console.error('addon load failed:', to_jsstring(lauxlib.luaL_tolstring(L, -1, null)));
  process.exit(1);
}
console.log('addon loaded');
if (process.env.GSUI_DEBUG) {
  console.log('stack after dofile:', lua.lua_gettop(L));
  for (let i = 1; i <= lua.lua_gettop(L); i++) {
    const s = lua.lua_tostring(L, i);
    console.log(' stack', i, lua.lua_typename(L, lua.lua_type(L, i)), s ? to_jsstring(s) : null);
  }
}

fireEvent('load');

// Parse the bound port out of the chat log.
const portLine = chats.find((m) => m.includes('listening on'));
const port = Number(portLine?.match(/127\.0\.0\.1:(\d+)/)?.[1]);
assert.ok(port, 'server did not report a bound port');
console.log('server on port', port);

// ---------- drive frames + HTTP ----------

const frame = () => fireEvent('prerender');
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

async function step(n = 3) {
  for (let i = 0; i < n; i++) {
    frame();
    await tick();
  }
}

const base = `http://127.0.0.1:${port}`;

await step(5);

// /api/status
{
  const p = fetch(`${base}/api/status`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.addon, 'xicompanion');
  assert.equal(j.port, port);
  console.log('PASS /api/status');
}

// /api/state
{
  const p = fetch(`${base}/api/state`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.ok(j.player && j.player.name === 'Tester');
  assert.equal(j.player.main_job, 'WAR');
  const inv = j.bags.find((b) => b.key === 'inventory');
  const ward = j.bags.find((b) => b.key === 'wardrobe');
  assert.ok(inv && ward, 'inventory + wardrobe missing');
  assert.equal(inv.items.length, 2);
  const helm = inv.items.find((i) => i.id === 12345);
  if (!j.catalog['12345']) console.log('catalog dump:', JSON.stringify(j.catalog).slice(0, 500));
  const meta = j.catalog['12345'];
  assert.equal(meta.name, 'Test Helm');
  assert.equal(meta.ilvl, 119);
  assert.equal(meta.rare, true);
  assert.equal(meta.ex, true);
  assert.deepEqual(meta.slots, ['Head']);
  const sword = inv.items.find((i) => i.id === 22222);
  assert.equal(sword.equipped, true);
  console.log('PASS /api/state');
}

// /api/itemmeta — lazy per-id meta + client description (kept out of the
// SSE catalog so broadcasts stay small)
{
  const p = fetch(`${base}/api/itemmeta?id=12345`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.name, 'Test Helm');
  assert.ok(j.description?.includes('DEF:45'), 'description missing: ' + JSON.stringify(j));
  const p2 = fetch(`${base}/api/itemmeta?id=99999`);
  await step(5);
  assert.equal((await p2).status, 404, 'unknown item should 404');
  console.log('PASS /api/itemmeta');
}

// POST /api/item unequip — no /unequip client command, so the addon
// injects an equip packet (0x050) with Item Index 0 (GearSwap's own
// unequip encoding). Slot names map via UNEQUIP_SLOT.
{
  const before = injectedPackets.length;
  const p = fetch(`${base}/api/item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'unequip', slot: 'l.ring' }),
  }).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.ok, true, 'unequip failed: ' + JSON.stringify(j));
  const pk = injectedPackets[injectedPackets.length - 1];
  assert.ok(injectedPackets.length > before, 'no packet injected');
  assert.equal(pk.dir, 'outgoing');
  assert.equal(pk.id, 0x050, 'expected equip packet 0x050');
  assert.equal(pk.fields['Item Index'], 0, 'unequip = empty Item Index');
  assert.equal(pk.fields['Equip Slot'], 13, 'l.ring = slot 13');

  const bad = fetch(`${base}/api/item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'unequip', slot: 'bogus' }),
  });
  await step(5);
  assert.equal((await bad).status, 400, 'bad slot should 400');
  console.log('PASS POST /api/item unequip');
}

// static index + SPA fallback
{
  const p = fetch(`${base}/`).then((r) => r.text());
  await step(5);
  const html = await p;
  assert.ok(html.includes('<div id="app">'), 'index.html not served');
  const p2 = fetch(`${base}/files`).then((r) => r.text());
  await step(5);
  const html2 = await p2;
  assert.ok(html2.includes('<div id="app">'), 'SPA fallback broken');
  console.log('PASS static index + SPA fallback');
}

// static asset content type
{
  const p0 = fetch(`${base}/`).then((r) => r.text());
  await step(5);
  const html = await p0;
  const js = html.match(/assets\/[^"]+\.js/)?.[0];
  const p = fetch(`${base}/${js}`).then((r) => [r.status, r.headers.get('content-type')]);
  await step(5);
  const [status, ct] = await p;
  assert.equal(status, 200);
  assert.match(ct, /javascript/);
  console.log('PASS static asset');
}

// gearswap files list
{
  const p = fetch(`${base}/api/gearswap/files`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.found, true);
  const paths = j.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['DUMMY.lua', 'Tester/WAR.lua']);
  console.log('PASS /api/gearswap/files');
}

// file read + write roundtrip
{
  const p = fetch(`${base}/api/gearswap/file?path=Tester/WAR.lua`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.content, WAR_LUA);

  const p2 = fetch(`${base}/api/gearswap/file?path=Tester/BLM.lua`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: '-- blm test\nsets = {}\n',
  }).then((r) => r.json());
  await step(5);
  assert.equal((await p2).ok, true);

  const p3 = fetch(`${base}/api/gearswap/file?path=Tester/BLM.lua`).then((r) => r.json());
  await step(5);
  assert.equal((await p3).content, '-- blm test\nsets = {}\n');
  console.log('PASS file read/write');
}

// path traversal rejected
{
  const p = fetch(`${base}/api/gearswap/file?path=../evil.lua`).then((r) => r.status);
  await step(5);
  assert.equal(await p, 404);
  const p2 = fetch(`${base}/api/gearswap/file?path=evil.txt`).then((r) => r.status);
  await step(5);
  assert.equal(await p2, 404);
  console.log('PASS traversal rejected');
}

// reload command
{
  const p = fetch(`${base}/api/gearswap/reload`, { method: 'POST' }).then((r) => r.json());
  await step(5);
  assert.equal((await p).ok, true);
  assert.ok(commands.includes('gs reload'));
  console.log('PASS /api/gearswap/reload');
}

// macro files: GET parses mcr.dat/mcr.ttl, PUT writes valid images
{
  const p = fetch(`${base}/api/macros`).then((r) => r.json());
  await step(5);
  const j = await p;
  assert.equal(j.logged_in, false);
  assert.equal(j.characters.length, 1);
  const ch = j.characters[0];
  assert.equal(ch.id, 'deadbee');
  assert.equal(ch.titles[1], 'RDM');
  assert.equal(ch.palettes.length, 2);
  const pal0 = ch.palettes.find((x) => x.index === 0);
  assert.equal(pal0.book, 1);
  assert.equal(pal0.palette, 1);
  assert.equal(pal0.macros.length, 20);
  assert.equal(pal0.macros[0].name, 'TestMcr');
  assert.equal(pal0.macros[0].lines[0], '/say hello');
  // raw 0xFD auto-translate bytes decode to the editable token form
  assert.equal(pal0.macros[1].lines[0], '[AT:02021234] rest');
  const pal10 = ch.palettes.find((x) => x.index === 10);
  assert.equal(pal10.book, 2);
  assert.equal(pal10.palette, 1);
  console.log('PASS GET /api/macros');

  // PUT a rewritten palette back to mcr10.dat
  const out = Array.from({ length: 20 }, () => ({ name: '', lines: ['', '', '', '', '', ''] }));
  out[0] = { name: 'New', lines: ['/ja Provoke <t>', '', '', '', '', ''] };
  out[19] = { name: 'Last', lines: ['/p end', '', '', '', '', ''] };
  const p2 = fetch(`${base}/api/macros/palette`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ char: 'deadbee', index: 10, macros: out }),
  }).then((r) => r.json());
  await step(5);
  const j2 = await p2;
  assert.equal(j2.ok, true);
  assert.equal(j2.file, 'mcr10.dat');
  // validate the written image: correct md5 + record layout
  const img = readFileSync(join(macroDir, 'mcr10.dat'));
  assert.equal(img.length, 7624);
  const body = img.subarray(MD5_OFF);
  assert.equal(
    crypto.createHash('md5').update(body).digest('hex'),
    img.subarray(8, 24).toString('hex'),
    'written file md5 mismatch',
  );
  // record 0: lines at 28.., name after 6*61
  assert.equal(img.subarray(28, 28 + 16).toString('latin1').replace(/\0+$/, ''), '/ja Provoke <t>');
  const nameOff = 28 + 6 * 61;
  assert.equal(img.subarray(nameOff, nameOff + 8).toString('latin1').replace(/\0+$/, ''), 'New');
  // record 19 name sits at 28 + 19*380 + 366
  const last = 28 + 19 * 380 + 366;
  assert.equal(img.subarray(last, last + 8).toString('latin1').replace(/\0+$/, ''), 'Last');
  assert.ok(existsSync(join(macroDir, 'mcr10.dat.xicompanion-bak')), 'no backup written');
  console.log('PASS PUT /api/macros/palette');

  // PUT to a brand-new palette index creates mcr20.dat
  const p3 = fetch(`${base}/api/macros/palette`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      char: 'deadbee', index: 20,
      macros: Array.from({ length: 20 }, () => ({ name: '', lines: [] })),
    }),
  }).then((r) => r.json());
  await step(5);
  assert.equal((await p3).ok, true);
  const img20 = readFileSync(join(macroDir, 'mcr20.dat'));
  assert.equal(img20.length, 7624);
  assert.equal(
    crypto.createHash('md5').update(img20.subarray(MD5_OFF)).digest('hex'),
    img20.subarray(8, 24).toString('hex'),
  );
  console.log('PASS create new palette file');

  // PUT a book title rewrites mcr.ttl with a fresh md5
  const p4 = fetch(`${base}/api/macros/title`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ char: 'deadbee', book: 2, title: 'MNK' }),
  }).then((r) => r.json());
  await step(5);
  assert.equal((await p4).ok, true);
  const ttl = readFileSync(join(macroDir, 'mcr.ttl'));
  assert.equal(ttl.length, 344);
  assert.equal(
    crypto.createHash('md5').update(ttl.subarray(MD5_OFF)).digest('hex'),
    ttl.subarray(8, 24).toString('hex'),
  );
  assert.equal(ttl.subarray(24 + 16, 24 + 32).toString('latin1').replace(/\0+$/, ''), 'MNK');
  console.log('PASS PUT /api/macros/title');

  // GET reflects the written title + palette
  const p5 = fetch(`${base}/api/macros`).then((r) => r.json());
  await step(5);
  const j5 = await p5;
  assert.equal(j5.characters[0].titles[1], 'MNK');
  assert.equal(j5.characters[0].palettes.length, 3);
  console.log('PASS macro round-trip');

  // apply=1 while logged in: the write is bracketed by client book
  // switches (away -> write -> back + set page). Under fengari there is
  // no coroutine.schedule, so the fallback runs the steps synchronously.
  loggedIn = true;
  const cmdsBefore = commands.length;
  const out2 = Array.from({ length: 20 }, () => ({ name: '', lines: ['', '', '', '', '', ''] }));
  out2[5] = { name: 'Live', lines: ['/ma Cure <me>', '', '', '', '', ''] };
  const p6 = fetch(`${base}/api/macros/palette?apply=1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ char: 'deadbee', index: 10, macros: out2 }),
  }).then((r) => r.json());
  await step(5);
  const j6 = await p6;
  assert.equal(j6.ok, true);
  assert.equal(j6.applied, true);
  assert.equal(j6.book, 2);
  assert.equal(j6.palette, 1);
  // book 2's "away" book is book 1; sequence away -> write -> back -> set
  assert.deepEqual(commands.slice(cmdsBefore), [
    'input /macro book 1',
    'input /macro book 2',
    'input /macro set 1',
  ]);
  const imgLive = readFileSync(join(macroDir, 'mcr10.dat'));
  const rec5 = 28 + 5 * 380; // macro index 5
  assert.equal(imgLive.subarray(rec5, rec5 + 20).toString('latin1').replace(/\0+$/, ''), '/ma Cure <me>');
  assert.equal(
    crypto.createHash('md5').update(imgLive.subarray(MD5_OFF)).digest('hex'),
    imgLive.subarray(8, 24).toString('hex'),
  );
  loggedIn = false;
  console.log('PASS apply (book-switch dance)');
}

// palette-departure watch: the client rewrites the outgoing page's file
// on every palette move — the poll diffs mtimes and reports the
// departed index as the active palette
{
  loggedIn = true;
  await step(35); // prime the watch baseline
  writeFileSync(join(macroDir, 'mcr30.dat'), buildPalette([])); // left idx 30
  await step(35);
  const ms = fetch(`${base}/api/macrosel`).then((r) => r.json());
  await step(3);
  const jms = await ms;
  assert.deepEqual(jms.deadbee, { b: 4, p: 1 }, 'macrosel did not follow mcrN.dat write');
  loggedIn = false;
  console.log('PASS macro palette departure tracking');
}

// POST /api/macros/run replays a cell's lines through `input`; stored
// AT phrases are re-encoded to their raw FD wire bytes
{
  const pr1 = fetch(`${base}/api/macros/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ char: 'deadbee', index: 0, cell: 0 }),
  }).then((r) => r.json());
  await step(3);
  const jr1 = await pr1;
  assert.equal(jr1.ok, true);
  assert.equal(
    commands[commands.length - 1],
    'input /say hello',
    'macro line not sent: ' + JSON.stringify(commands[commands.length - 1]),
  );
  const pr2 = fetch(`${base}/api/macros/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ char: 'deadbee', index: 0, cell: 1 }),
  }).then((r) => r.json());
  await step(3);
  await pr2;
  assert.equal(
    commands[commands.length - 1],
    'input ý\x02\x02\x12\x34ý rest',
    'AT bytes not re-encoded: ' + JSON.stringify(commands[commands.length - 1]),
  );
  const pr3 = fetch(`${base}/api/macros/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ char: 'deadbee', index: 0, cell: 20 }),
  }).then((r) => r.json());
  await step(3);
  const jr3 = await pr3;
  assert.ok(jr3.error, 'out-of-range cell accepted');
  console.log('PASS POST /api/macros/run');
}

// SSE: receive the initial snapshot event
{
  const ctrl = new AbortController();
  const p0 = fetch(`${base}/api/events`, { signal: ctrl.signal });
  await step(3);
  const r = await p0;
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const reader = r.body.getReader();
  const chunks = [];
  const readLoop = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString('utf8'));
      // macrosel is the last snapshot event on connect — read until it
      if (chunks.join('').includes('event: macrosel')) break;
    }
  })();
  await step(8);
  ctrl.abort();
  await readLoop.catch(() => {});
  const text = chunks.join('');
  assert.ok(text.includes('event: state'), 'no SSE state event');
  assert.ok(text.includes('event: macrosel'), 'no SSE macrosel snapshot');
  assert.ok(text.includes('"player"'), 'SSE payload missing state');
  console.log('PASS SSE /api/events');
}

// //xicompanion open command fires open_url
function addonCmd(...args) {
  const refs = events.get('addon command') ?? [];
  assert.ok(refs.length > 0);
  const base = lua.lua_gettop(L);
  lua.lua_rawgeti(L, LUA_REGISTRYINDEX, refs[0]);
  for (const a of args) lua.lua_pushstring(L, to_luastring(a));
  const rc = lua.lua_pcall(L, args.length, 0, 0);
  if (rc !== LUA_OK || lua.lua_gettop(L) > base) {
    const msg = to_jsstring(lauxlib.luaL_tolstring(L, -1, null));
    lua.lua_settop(L, base);
    throw new Error('addon command failed: ' + msg);
  }
}
{
  addonCmd('open');
  console.log('PASS addon command');
}

// swapui headless scanner: set scan + equip command
{
  addonCmd('swap', 'scan');
  assert.ok(
    chats.some((m) => m.includes('6 set(s) found')),
    'expected 6 scanned sets, chats: ' + JSON.stringify(chats.slice(-5)),
  );
  addonCmd('swap', 'list');
  const listing = chats.join('\n');
  for (const want of ['idle', 'idle.Town', 'engaged', 'precast', 'precast.FC', 'precast["Utsusemi: Ichi"]']) {
    assert.ok(listing.includes(want), 'missing set in list: ' + want);
  }
  assert.ok(!listing.includes('commented'), 'commented-out set leaked into list');
  addonCmd('equip', 'idle.Town');
  assert.ok(commands.includes('gs equip sets.idle.Town'));
  addonCmd('equip', 'sets.engaged');
  assert.ok(commands.includes('gs equip sets.engaged'));
  addonCmd('swap', 'add', 'defense.MDT');
  addonCmd('swap', 'list');
  assert.ok(chats.join('\n').includes('defense.MDT *'), 'custom set not listed');
  addonCmd('swap');
  assert.ok(chats.join('\n').includes('usage: //xicompanion swap'), 'bare swap did not print usage');
  console.log('PASS swap scanner + commands');
}

// chat packet builder — mode @5, sender char[15] @9, text @24; shared
// by the chat tests and the map linkshell-roster test
const chatPacket = (mode, name, text) => {
  const b = [0x17, 0x40, 0x00, 0x00]; // header
  b.push(mode, 0, 0, 0); // mode, gm, padding
  for (let i = 0; i < 15; i++) b.push(i < name.length ? name.charCodeAt(i) : 0);
  for (const c of text) b.push(c.charCodeAt(0));
  b.push(0);
  return new Uint8Array(b); // raw bytes — a JS string would be UTF-8-encoded
};

// chat: incoming 0x017 packets parse into the log; POST sends via input /
{
  fireEvent('incoming chunk', 0x017, chatPacket(4, 'Allymate', 'hello party'));
  fireEvent('incoming chunk', 0x017, chatPacket(3, 'Someguy', 'psst'));
  fireEvent('incoming chunk', 0x017, chatPacket(200, '', 'system junk ignored'));
  // auto-translate phrases decode via res.auto_translates (6-byte run:
  // FD <type> <lang> <id hi> <id lo> FD — the wire id is big-endian,
  // so "Hello!" (id 267 = 0x010B) arrives as 01 0B)
  fireEvent('incoming chunk', 0x017, chatPacket(4, 'Greeter', 'well \xFD\x02\x02\x01\x0B\xFD met'));
  fireEvent('incoming chunk', 0x017, chatPacket(4, 'Greeter', 'unk \xFD\x02\x02\xFF\x7F\xFD id'));
  // type byte selects the table: 0x07 = item name (res.items),
  // 0x0A = item with the low id byte masked 0x00 -> 0xFF on the wire,
  // 0x13 = key item (res.key_items)
  fireEvent('incoming chunk', 0x017, chatPacket(4, 'Greeter', 'want \xFD\x07\x02\x66\xFF\xFD pls'));
  fireEvent('incoming chunk', 0x017, chatPacket(4, 'Greeter', 'masked \xFD\x0A\x02\x03\xFF\xFD too'));
  fireEvent('incoming chunk', 0x017, chatPacket(4, 'Greeter', 'have \xFD\x13\x02\x0B\x62\xFD ok'));
  // malformed content: truncated/lone auto-translate runs and high bytes
  // must not throw or kill the routing path
  fireEvent('incoming chunk', 0x017, chatPacket(4, 'Trouble', 'hi \xFD\x02\x01\x02\xFD there'));
  fireEvent('incoming chunk', 0x017, chatPacket(4, 'Trouble', 'ends with lone \xFD'));
  fireEvent('incoming chunk', 0x017, chatPacket(4, 'Trouble', 'raw \x9F\xA0 bytes'));
  await step(3);

  const cp = fetch(`${base}/api/chat`).then((r) => r.json());
  await step(3);
  const j = await cp;
  const ally = j.messages.find((m) => m.sender === 'Allymate');
  assert.ok(ally && ally.channel === 'party' && ally.text === 'hello party',
    'party packet not parsed: ' + JSON.stringify(j.messages));
  const tell = j.messages.find((m) => m.sender === 'Someguy');
  assert.ok(tell && tell.channel === 'tell' && tell.peer === 'Someguy',
    'tell packet missing peer');
  assert.ok(!j.messages.some((m) => m.text === 'system junk ignored'),
    'unknown mode leaked into chat log');
  const hello = j.messages.find((m) => m.text === 'well {Hello!} met');
  assert.ok(hello, 'auto-translate phrase not decoded: ' + JSON.stringify(j.messages));
  const unk = j.messages.find((m) => m.text === 'unk {AT:0202ff7f} id');
  assert.ok(unk, 'unknown auto-translate id lost: ' + JSON.stringify(j.messages));
  assert.ok(j.messages.some((m) => m.text === 'want {Null Belt} pls'),
    'item AT phrase not decoded: ' + JSON.stringify(j.messages));
  assert.ok(j.messages.some((m) => m.text === 'masked {Bronze Mask} too'),
    'masked item AT phrase not decoded: ' + JSON.stringify(j.messages));
  assert.ok(j.messages.some((m) => m.text === 'have {Test Permit} ok'),
    'key item AT phrase not decoded: ' + JSON.stringify(j.messages));
  const at = j.messages.find((m) => m.text === 'hi {AT} there');
  assert.ok(at, 'auto-translate run not collapsed: ' + JSON.stringify(j.messages));
  const lone = j.messages.find((m) => m.text === 'ends with lone {AT}');
  assert.ok(lone, 'unterminated auto-translate mangled message: ' + JSON.stringify(j.messages));
  assert.ok(j.messages.some((m) => m.text === 'raw  bytes' || m.text === 'raw bytes'),
    'high-byte message dropped: ' + JSON.stringify(j.messages));
  assert.ok(typeof j.boot === 'number' && j.boot > 0, 'boot marker missing');
  assert.ok(j.messages.every((m) => m.boot === j.boot), 'message boot mismatch');
  console.log('PASS chat intercept + GET /api/chat');

  // send side: channel -> input /<cmd>; tell needs `to` + local echo
  const cmdsBefore = commands.length;
  const p1 = fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'linkshell', text: 'ls test' }),
  }).then((r) => r.json());
  await step(3);
  await p1;
  const p2 = fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'tell', to: 'Someguy', text: 'back at you' }),
  }).then((r) => r.json());
  await step(3);
  await p2;
  assert.deepEqual(commands.slice(cmdsBefore), [
    'input /linkshell ls test',
    'input /tell Someguy back at you',
  ]);
  const cp2 = fetch(`${base}/api/chat`).then((r) => r.json());
  await step(3);
  const j2 = await cp2;
  const echo = j2.messages.find((m) => m.self === true && m.channel === 'tell');
  assert.ok(echo && echo.peer === 'Someguy' &&
    echo.text === 'back at you', 'tell local echo missing');

  // channel sends append locally too — the server doesn't echo them back
  const lsEcho = j2.messages.find(
    (m) => m.self === true && m.channel === 'linkshell' && m.text === 'ls test',
  );
  assert.ok(lsEcho, 'channel local echo missing: ' + JSON.stringify(j2.messages));
  // …but if a real echo DOES land with our name+text inside the window,
  // the optimistic append must not double
  fireEvent('incoming chunk', 0x017, chatPacket(5, 'Tester', 'ls test'));
  await step(3);
  const cp3 = fetch(`${base}/api/chat`).then((r) => r.json());
  await step(3);
  const lsDupes = (await cp3).messages.filter(
    (m) => m.channel === 'linkshell' && m.text === 'ls test',
  );
  assert.equal(lsDupes.length, 1, 'echo doubled the optimistic append');

  // auto-translate braces ({Hello!}) decode to FD wire bytes —
  // the harness converts lua strings byte-faithfully (latin1) so 0xFD
  // arrives as ý
  const p3 = fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'party', text: 'hi {Hello!}' }),
  }).then((r) => r.json());
  await step(3);
  await p3;
  const atCmd = commands[commands.length - 1];
  assert.equal(
    atCmd,
    'input /party hi ý\x02\x02\x01\x0Bý',
    'braced phrase not wire-encoded: ' + JSON.stringify(atCmd),
  );
  // item names encode as type 0x07 — masked to 0x0A here because
  // Bronze Mask's low id byte is 0x00 and rides the wire as 0xFF
  const p3i = fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'party', text: 'got {Bronze Mask}' }),
  }).then((r) => r.json());
  await step(3);
  await p3i;
  assert.equal(
    commands[commands.length - 1],
    'input /party got ý\x0A\x02\x03ÿý',
    'item phrase not wire-encoded: ' + JSON.stringify(commands[commands.length - 1]),
  );
  // braces that don't resolve to a phrase pass through as literal text
  const p4 = fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'party', text: 'a {nope} b' }),
  }).then((r) => r.json());
  await step(3);
  await p4;
  assert.equal(
    commands[commands.length - 1],
    'input /party a {nope} b',
    'literal braces mangled: ' + JSON.stringify(commands[commands.length - 1]),
  );

  // the phrases endpoint feeds the composer's autocomplete
  const pp = fetch(`${base}/api/chat/phrases`).then((r) => r.json());
  await step(3);
  const pj = await pp;
  assert.ok(pj.phrases.includes('Hello!'), 'phrases missing Hello!');
  console.log('PASS POST /api/chat');
}

// journal: 0x056 quest/mission log + 0x111/0x112 RoE packets feed
// /api/journal; /api/journal/names serves the extracted DAT tables
{
  // drop any persisted state left by a previous run so the assertions
  // below see exactly what these packets produce
  const journalDir = join(addonDir, 'data', 'journal');
  rmSync(journalDir, { recursive: true, force: true });

  // subtype u16 lives at packet offset 0x24; log bitfields start at 0x04
  const logPacket = (subtype, fields = {}, bits = [], bitOff = 4, bitLen = 32) => {
    const b = new Uint8Array(0x44);
    b[0] = 0x56;
    for (const [off, v] of Object.entries(fields)) {
      const o = Number(off);
      b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff;
      b[o + 2] = (v >> 16) & 0xff; b[o + 3] = (v >> 24) & 0xff;
    }
    for (const bit of bits) b[bitOff + (bit >> 3)] |= 1 << (bit & 7);
    b[0x24] = subtype & 0xff;
    b[0x25] = (subtype >> 8) & 0xff;
    return b.subarray(0, Math.max(0x26, bitOff + bitLen));
  };

  // current + completed San d'Oria quests: 3 = "The Pickpocket",
  // 5 = "The Seamstress" current; 0 = "A Sentry's Peril" done
  fireEvent('incoming chunk', 0x056, logPacket(0x0050, {}, [3, 5]));
  fireEvent('incoming chunk', 0x056, logPacket(0x0090, {}, [0]));
  // current missions: nation=Bastok(1) rank 5, COP pointer 118, ROV none
  fireEvent('incoming chunk', 0x056, logPacket(0xffff, {
    0x04: 1,       // nation
    0x08: 5,       // current nation mission
    0x10: 118,     // current COP mission (mapped id)
    0x18: 0x21,    // acp nibble = 1, mkd nibble = 2
    0x1c: -1 >>> 0, // soa: none
    0x20: 210,     // rov current
  }));
  // RoE active objectives: slot 0 = id 100 progress 7,
  // limited-time slot = id 200 progress 3
  {
    const b = new Uint8Array(0x104);
    b[0] = 0x11; b[1] = 0x01;
    const put = (o, id, progress) => {
      const v = progress * 4096 + id;
      b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff;
      b[o + 2] = (v >> 16) & 0xff; b[o + 3] = (v >> 24) & 0xff;
    };
    put(4, 100, 7);
    put(0x100, 200, 3);
    fireEvent('incoming chunk', 0x111, b);
  }
  // RoE completion pages: order 0 bit 5, order 2 bit 12
  {
    const page = (order, bits) => {
      const b = new Uint8Array(0x88);
      b[0] = 0x12; b[1] = 0x01;
      for (const bit of bits) b[4 + (bit >> 3)] |= 1 << (bit & 7);
      b[0x84] = order & 0xff; b[0x85] = (order >> 8) & 0xff;
      return b;
    };
    fireEvent('incoming chunk', 0x112, page(0, [5]));
    fireEvent('incoming chunk', 0x112, page(2, [12]));
  }
  await step(3);

  const jp = fetch(`${base}/api/journal`).then((r) => r.json());
  await step(3);
  const j = await jp;
  assert.equal(j.char, 'Tester');
  assert.deepEqual(j.quests.sandoria.current, [3, 5], 'current quests wrong');
  assert.deepEqual(j.quests.sandoria.done, [0], 'done quests wrong');
  assert.equal(j.missions.bastok.current, 5, 'nation mission wrong');
  assert.equal(j.missions.cop.current, 118, 'cop pointer wrong');
  assert.equal(j.missions.cop.inferred_done, true, 'cop should infer done');
  assert.equal(j.missions.acp.current, 1, 'acp nibble wrong');
  assert.equal(j.missions.mkd.current, 2, 'mkd nibble wrong');
  assert.equal(j.missions.rov.current, 210, 'rov pointer wrong');
  assert.ok(j.missions.soa == null || j.missions.soa.current == null,
    'soa should have no mission');
  assert.equal(j.roe.active.length, 2, 'roe active count wrong');
  assert.deepEqual(
    j.roe.active.find((a) => a.id === 100),
    { id: 100, progress: 7 },
    'roe objective wrong',
  );
  assert.equal(j.roe.active[1].id, 200, 'limited objective missing');
  assert.equal(j.roe.active[1].limited, true, 'limited flag missing');
  assert.ok(j.roe.done.includes(5) && j.roe.done.includes(2060),
    'roe done bits wrong: ' + JSON.stringify(j.roe.done));
  console.log('PASS journal packets + GET /api/journal');

  // persisted state should survive: the file must exist and a reload-free
  // second fetch must see the same data
  assert.ok(existsSync(join(journalDir, 'Tester.lua')), 'journal not persisted');

  const np = fetch(`${base}/api/journal/names`).then((r) => r.json());
  await step(3);
  const n = await np;
  assert.equal(n.quest_areas.sandoria.ids['3'].n, 'The Pickpocket');
  assert.equal(n.quest_areas.sandoria.ids['5'].n, 'The Seamstress');
  assert.ok(n.mission_lines.cop.name.length > 0, 'cop storyline missing');
  assert.ok(Object.keys(n.roe).length > 1000, 'roe table too small');
  assert.ok(Object.keys(n.roe_categories).length > 0, 'roe categories missing');
  console.log('PASS GET /api/journal/names');

  // RoE mark/unmark injects the client's menu packets (0x10C set /
  // 0x10D cancel) — gated on being logged in
  loggedIn = true;
  for (const [id, action, want] of [[100, 'set', 0x10c], [55, 'clear', 0x10d]]) {
    const rp = fetch(`${base}/api/journal/roe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    }).then((r) => r.json());
    await step(3);
    const rj = await rp;
    assert.equal(rj.ok, true, `roe ${action} failed: ` + JSON.stringify(rj));
    const p = injectedPackets[injectedPackets.length - 1];
    assert.equal(p.dir, 'outgoing');
    assert.equal(p.id, want, `wrong packet id for ${action}`);
    assert.equal(p.fields['RoE Quest'], id, 'wrong RoE Quest field');
  }
  loggedIn = false;
  const rp3 = fetch(`${base}/api/journal/roe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 5, action: 'set' }),
  }).then((r) => r.status);
  await step(3);
  assert.equal(await rp3, 400, 'roe set should be rejected while logged out');
  console.log('PASS POST /api/journal/roe');

  // tracker visibility toggle: hidden entries land in state.untracked as
  // 'kind:key:id' strings and come back out of /api/journal
  const tp = fetch(`${base}/api/journal/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'quest', key: 'sandoria', id: 3, tracked: false }),
  }).then((r) => r.json());
  await step(3);
  assert.equal((await tp).ok, true, 'track toggle failed');
  const jp2 = fetch(`${base}/api/journal`).then((r) => r.json());
  await step(3);
  const j2 = await jp2;
  assert.ok(
    j2.untracked.includes('quest:sandoria:3'),
    'untracked key missing: ' + JSON.stringify(j2.untracked),
  );
  // re-enable clears it
  const tp2 = fetch(`${base}/api/journal/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'quest', key: 'sandoria', id: 3, tracked: true }),
  }).then((r) => r.json());
  await step(3);
  assert.equal((await tp2).ok, true, 're-track failed');
  const jp3 = fetch(`${base}/api/journal`).then((r) => r.json());
  await step(3);
  assert.ok(
    !(await jp3).untracked.includes('quest:sandoria:3'),
    'untracked key not cleared',
  );
  // id 0 is a real mission/quest id — it must write the entry key,
  // not collapse to the group key
  const zp = fetch(`${base}/api/journal/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'mission', key: 'zilart', id: 0, tracked: false }),
  }).then((r) => r.json());
  await step(3);
  assert.equal((await zp).ok, true, 'id-0 track toggle failed');
  const jz = fetch(`${base}/api/journal`).then((r) => r.json());
  await step(3);
  assert.ok(
    (await jz).untracked.includes('mission:zilart:0'),
    'id-0 entry key missing — was treated as group key',
  );
  const zp2 = fetch(`${base}/api/journal/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'mission', key: 'zilart', id: 0, tracked: true }),
  }).then((r) => r.json());
  await step(3);
  assert.equal((await zp2).ok, true, 'id-0 re-track failed');

  // group-level toggle: omitting id stores 'kind:key' — every current
  // and future item in the group stays off the tracker
  const gp = fetch(`${base}/api/journal/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'quest', key: 'sandoria', tracked: false }),
  }).then((r) => r.json());
  await step(3);
  assert.equal((await gp).ok, true, 'group track toggle failed');
  const jp4 = fetch(`${base}/api/journal`).then((r) => r.json());
  await step(3);
  const j4 = await jp4;
  assert.ok(
    j4.untracked.includes('quest:sandoria'),
    'group untracked key missing: ' + JSON.stringify(j4.untracked),
  );
  const gp2 = fetch(`${base}/api/journal/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'quest', key: 'sandoria', tracked: true }),
  }).then((r) => r.json());
  await step(3);
  assert.equal((await gp2).ok, true, 'group re-track failed');
  const jp5 = fetch(`${base}/api/journal`).then((r) => r.json());
  await step(3);
  assert.ok(
    !(await jp5).untracked.includes('quest:sandoria'),
    'group untracked key not cleared',
  );
  console.log('PASS POST /api/journal/track');

  // little-endian packet writers shared by the map/party tests below.
  // Packet layouts: addons/libs/packets/fields.lua
  const put16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
  const put32 = (b, o, v) => {
    b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff;
    b[o + 2] = (v >> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
  };

  // addon settings — flat scalars round-trip through /api/settings
  const sg = fetch(`${base}/api/settings`).then((r) => r.json());
  await step(3);
  const sj = await sg;
  assert.equal(typeof sj.chat_history, 'number', 'settings missing keys');
  const sp = fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_history: 500, tracker: false }),
  }).then((r) => r.json());
  await step(3);
  assert.equal((await sp).ok, true, 'settings save failed');
  const sg2 = fetch(`${base}/api/settings`).then((r) => r.json());
  await step(3);
  const sj2 = await sg2;
  assert.equal(sj2.chat_history, 500, 'chat_history not updated');
  assert.equal(sj2.tracker, false, 'tracker flag not updated');
  console.log('PASS GET/POST /api/settings');

  // recasts: ability + spell cooldowns land in /api/recasts (live
  // updates ride the `recasts` SSE event; names come from res)
  loggedIn = true;
  abilityRecasts[1] = 240;
  spellRecasts[4] = 3.5;
  await step(3);
  const rcp = fetch(`${base}/api/recasts`).then((r) => r.json());
  await step(3);
  const rcj = await rcp;
  const berserk = rcj.list.find((e) => e.n === 'Berserk');
  const cure = rcj.list.find((e) => e.n === 'Cure IV');
  assert.ok(berserk, 'ability recast missing from /api/recasts');
  assert.equal(berserk.t, 'a');
  assert.equal(berserk.r, 240);
  assert.ok(berserk.m >= 240, 'ability max below observed remaining');
  assert.ok(cure, 'spell recast missing from /api/recasts');
  assert.equal(cure.t, 's');
  assert.ok(cure.m >= 8, 'spell max should floor at res.spells recast');
  console.log('PASS recasts + GET /api/recasts');

  // empty list must still encode as a json array — a bare {} crashes
  // the view's .map
  delete abilityRecasts[1];
  delete spellRecasts[4];
  await step(3);
  const rce = fetch(`${base}/api/recasts`).then((r) => r.json());
  await step(3);
  const rcej = await rce;
  assert.ok(Array.isArray(rcej.list), 'empty recast list not an array');
  assert.equal(rcej.list.length, 0);
  console.log('PASS recasts empty-list encodes as array');

  // map: player pos via get_map_data (index), entity radar via
  // get_mob_array (world xyz -> map px), widescan 0x0F4 bursts land in
  // the same payload. Packet layout: addons/libs/packets/fields.lua
  loggedIn = true;
  mobs[meIndex] = {
    index: meIndex, name: 'Tester', x: 0, y: 0, z: 0, facing: 0,
    spawn_type: 1, valid_target: true, mapPos: [0, 300, 300],
  };
  // z is the height axis — x/y are the horizontal plane; z grows
  // downward, so -12 is 12 yalms ABOVE the player (el = +12)
  mobs[0x202] = {
    index: 0x202, name: 'Goblin Thug', x: 10, y: -5, z: -12, facing: 0,
    spawn_type: 16, valid_target: true, hpp: 80, distance: 100,
  };
  // nameless mob-array rows are padding — targetable but not real
  // entities; they must not reach the radar payload
  mobs[0x203] = {
    index: 0x203, name: '', x: 5, y: 5, z: 0, facing: 0,
    spawn_type: 16, valid_target: true,
  };
  // no entity field marks linkshell membership — the roster is names
  // heard speaking in the LS channels; Linkbuddy's 0x017 (mode 5)
  // should flag their radar blip f&8
  mobs[0x204] = {
    index: 0x204, name: 'Linkbuddy', x: -8, y: 4, z: 0, facing: 0,
    spawn_type: 1, valid_target: true, hpp: 100, distance: 64,
  };
  // NMs carry no entity flag either — flagged by name against the
  // generated nm_names.lua table (bg-wiki Category:Notorious_Monster)
  mobs[0x205] = {
    index: 0x205, name: 'Valkurm Emperor', x: 12, y: 8, z: 0, facing: 0,
    spawn_type: 16, valid_target: true, hpp: 99, distance: 144,
  };
  fireEvent('incoming chunk', 0x017, chatPacket(5, 'Linkbuddy', 'anyone around?'));
  const wsPacket = (index, level, typ, xoff, yoff, name) => {
    const b = new Uint8Array(28);
    b[0] = 0xf4;
    put16(b, 4, index);
    b[6] = level;
    b[7] = typ;
    put16(b, 8, xoff & 0xffff);
    put16(b, 10, yoff & 0xffff);
    for (let i = 0; i < name.length && i < 16; i++) {
      b[12 + i] = name.charCodeAt(i);
    }
    return b;
  };
  fireEvent('incoming chunk', 0x0f4, wsPacket(0x21, 15, 1, 40, -20, 'Goblin Thug'));
  fireEvent('incoming chunk', 0x0f4, wsPacket(0x22, 0, 2, 0, 64, 'Gate Guard'));
  // the player itself (index 0) is not a real blip; neither are the
  // padding rows — typeless and/or nameless — the client sends in bursts
  fireEvent('incoming chunk', 0x0f4, wsPacket(0, 0, 0, 0, 0, 'You'));
  fireEvent('incoming chunk', 0x0f4, wsPacket(0x23, 0, 0, 10, 10, 'No Type'));
  fireEvent('incoming chunk', 0x0f4, wsPacket(0x24, 0, 1, 10, 10, ''));
  fireEvent('incoming chunk', 0x0f4, wsPacket(0x25, 75, 2, -30, 15, 'Valkurm Emperor'));
  await step(12); // let the every-6th pump scan run
  {
    const mp = fetch(`${base}/api/map`).then((r) => r.json());
    await step(3);
    const mj = await mp;
    assert.ok(mj.me, 'player map position missing: ' + JSON.stringify(mj));
    assert.equal(mj.me.x, 300, 'player map x wrong');
    assert.equal(mj.me.y, 300, 'player map y wrong');
    const thug = mj.e?.find((e) => e.n === 'Goblin Thug');
    assert.ok(thug, 'mob missing from entity radar');
    assert.equal(thug.x, 266, 'mob map x wrong'); // 10 + 256
    assert.equal(thug.y, 251, 'mob map y wrong'); // -5 + 256
    assert.equal(thug.st, 16, 'mob spawn_type lost');
    // y is the world height axis — el is the delta vs the player (y=0)
    assert.equal(thug.el, 12, 'mob elevation delta wrong');
    assert.ok(mj.e?.every((e) => e.n !== 'Tester'), 'player leaked into entity list');
    assert.ok(mj.e?.every((e) => e.n), 'nameless mob-array row leaked');
    const buddy = mj.e?.find((e) => e.n === 'Linkbuddy');
    assert.ok(buddy, 'player entity missing from radar');
    assert.equal(buddy.el, 0, 'flat entity should sit at el 0');
    assert.ok((buddy.f & 8) === 8, 'linkshell member not flagged: ' + JSON.stringify(buddy));
    assert.ok(!(thug.f & 8), 'non-ls mob flagged as linkshell');
    const nm = mj.e?.find((e) => e.n === 'Valkurm Emperor');
    assert.ok(nm, 'NM missing from entity radar');
    assert.ok((nm.f & 16) === 16, 'NM not flagged: ' + JSON.stringify(nm));
    assert.ok(!(thug.f & 16), 'normal mob flagged as NM');
    const wsn = mj.ws?.map((w) => w.n);
    assert.ok(wsn?.includes('Goblin Thug'), 'widescan mob missing');
    assert.ok(wsn?.includes('Gate Guard'), 'widescan NPC missing');
    assert.ok(!wsn?.includes('You'), 'widescan self-blip leaked');
    assert.ok(!wsn?.includes('No Type'), 'typeless widescan row leaked');
    assert.equal(mj.ws?.length, 3, 'widescan padding rows not filtered');
    assert.equal(mj.ws?.find((w) => w.n === 'Goblin Thug')?.l, 15, 'ws level lost');
    assert.equal(mj.ws?.find((w) => w.n === 'Valkurm Emperor')?.nm, 1, 'ws NM not flagged');
    assert.ok(!mj.ws?.find((w) => w.n === 'Goblin Thug')?.nm, 'ws non-NM flagged');
    assert.equal(mj.wsa, 1, 'wsa flag not set');
    console.log('PASS map position + entities + widescan');
  }
  delete mobs[meIndex];
  delete mobs[0x202];
  delete mobs[0x203];
  delete mobs[0x204];
  delete mobs[0x205];

  // party + target + cast bar: a mob-targeted 0x028 cat-8 cast must
  // surface in /api/party's t.cast, member rows carry vitals, and a
  // 0x076 block attaches buffs to p1's mob id
  {
    mobs[0x300] = {
      index: 0x300, id: 0x01000300, name: 'Casting Orc', x: 0, y: 0, z: 0,
      facing: 0, spawn_type: 16, valid_target: true, hpp: 77,
    };
    targetIndex = 0x300;
    const putBits = (b, off, n, v) => {
      for (let i = 0; i < n; i++)
        if ((v >> i) & 1) b[(off + i) >> 3] |= 1 << ((off + i) & 7);
    };
    const castPkt = (cat, spell) => {
      const b = new Uint8Array(80);
      b[0] = 0x28;
      put32(b, 4, 0x01000300);            // actor
      putBits(b, 72, 10, 1);              // target count
      putBits(b, 82, 4, cat);             // category
      putBits(b, 118, 32, 240);           // recast ticks -> 4s
      putBits(b, 150, 32, meIndex);       // target id
      putBits(b, 182, 4, 1);              // action count
      putBits(b, 213, 17, spell);         // first action param
      return b;
    };
    fireEvent('incoming chunk', 0x028, castPkt(8, 4)); // Cure IV start
    // 0x076: five 48B blocks @4 — block 0 names p1's mob id; buff 32's
    // low byte sits at +20 (0-based), hi nibble byte at +12
    const buffs = new Uint8Array(244);
    buffs[0] = 0x76;
    put32(buffs, 4, 0x1000);
    buffs[20] = 32;
    fireEvent('incoming chunk', 0x076, buffs);
    // party.poll only folds packets into last_payload every 15th pump —
    // step BEFORE fetching or the snapshot predates the events
    await step(20);
    const pP = fetch(`${base}/api/party`).then((r) => r.json());
    await step(5);
    const p = await pP;
    assert.equal(p.on, 1, 'party feed off');
    assert.equal(p.p?.length, 2, 'party members missing');
    assert.equal(p.p?.[1]?.n, 'Allymate', 'member name wrong');
    assert.equal(p.p?.[1]?.hp, 88, 'member hpp wrong');
    assert.equal(p.p?.[1]?.b?.[0]?.i, 32, '0x076 buff not decoded');
    assert.equal(p.t?.n, 'Casting Orc', 'target name wrong');
    assert.equal(p.t?.hpp, 77, 'target hpp wrong');
    assert.equal(p.t?.cast?.n, 'Cure IV', 'mob cast not tracked');
    // a finish packet from the same actor clears the cast
    fireEvent('incoming chunk', 0x028, castPkt(4, 4));
    await step(20);
    const p2P = fetch(`${base}/api/party`).then((r) => r.json());
    await step(5);
    const p2 = await p2P;
    assert.ok(!p2.t?.cast, 'cast not cleared on finish');
    console.log('PASS party vitals + 0x076 buffs + mob cast bar');
    delete mobs[0x300];
    targetIndex = 0;
  }

  // abilities book: learned sets join res levels + the generated
  // ja_levels.lua table (WAR99/NIN49 player stub)
  {
    const abP = fetch(`${base}/api/abilities`).then((r) => r.json());
    await step(3);
    const ab = await abP;
    const berserk = ab.abilities?.find((e) => e.n === 'Berserk');
    assert.ok(berserk, 'learned JA missing from book');
    assert.equal(berserk.l, 1, 'learned JA not flagged');
    assert.equal(berserk.lvl, 15, 'JA level req wrong'); // ja_levels WAR 15
    assert.equal(berserk.j, 'M', 'JA job source wrong');
    assert.equal(berserk.cmd, '/ja "Berserk" <me>', 'JA cmd missing');
    const provoke = ab.abilities?.find((e) => e.n === 'Provoke');
    assert.ok(provoke, 'obtainable JA missing (unlearned but job-listed)');
    assert.ok(!provoke.l, 'unlearned JA flagged learned');
    assert.equal(provoke.lvl, 5, 'obtainable JA level req wrong');
    const combo = ab.abilities?.find((e) => e.n === 'Combo');
    assert.ok(combo?.k === 'ws' && combo.l === 1, 'learned WS missing');
    const cure = ab.spells?.find((e) => e.n === 'Cure IV');
    assert.ok(
      cure?.l === 1 && cure.lvl === 41 && cure.j === 'M',
      'learned main-job spell wrong',
    );
    const utsu = ab.spells?.find((e) => e.n === 'Utsusemi: Ichi');
    assert.ok(
      utsu && utsu.lvl === 24 && utsu.j === 'S' && !utsu.l,
      'subjob spell obtainable math wrong',
    );
    console.log('PASS abilities book');
  }

  // map image route: mapdats + FTABLE resolve a zone/map to a client DAT;
  // the route serves raw bytes as application/x-ffxi-map (browser decodes).
  {
    const ftable = Buffer.alloc(5744 * 2 + 2);
    ftable.writeUInt16LE((17 << 7) | 24, 5744 * 2); // zone 1 fid -> ROM/17/24.DAT
    writeFileSync(join(ffxiDir, 'FTABLE.DAT'), ftable);
    mkdirSync(join(ffxiDir, 'ROM', '17'), { recursive: true });
    const payload = 'xicompanion-map-dat-payload';
    writeFileSync(join(ffxiDir, 'ROM', '17', '24.DAT'), payload);

    const riP = fetch(`${base}/api/map/img?z=1&m=0`);
    await step(3);
    const ri = await riP;
    assert.equal(ri.status, 200, 'map img route failed: ' + ri.status);
    assert.equal(
      ri.headers.get('content-type'),
      'application/x-ffxi-map',
      'map img content-type wrong',
    );
    const rjP = fetch(`${base}/api/map/img?z=999&m=0`);
    await step(3);
    const missing = await rjP;
    assert.equal(missing.status, 404, 'unknown zone should 404');
    assert.equal(await ri.text(), payload, 'map img payload wrong');
    console.log('PASS map image DAT route');
  }

  // leave no state behind for the next run
  rmSync(journalDir, { recursive: true, force: true });
}

console.log('\nAll smoke tests passed.');
process.exit(0);
