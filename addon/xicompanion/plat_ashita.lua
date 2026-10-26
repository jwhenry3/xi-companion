-- plat_ashita.lua: Ashita v4 binding for the plat surface. Loaded via
-- plat.lua's host dispatch when `windower` is nil. Beyond the plat.*
-- surface itself, this file also registers package.preload shims for
-- the Windower-only host libs the shared code requires ('resources',
-- 'config', 'packets') — it runs before xicompanion.lua's requires, so those
-- resolve to the shims here.
--
-- Runtime-verified APIs come from the Ashita v4 SDK annotations
-- (addons/libs/annotations/SDK). Sites that could not be verified
-- against a running client are marked [UNVERIFIED] — check those first
-- when a feature misbehaves.

local bit = require('bit')
local ffi = require('ffi')

local P = {}
P.host = 'ashita'

local band, bor, lshift, rshift = bit.band, bit.bor, bit.lshift, bit.rshift

----------------------------------------------------------------------
-- Paths
----------------------------------------------------------------------

-- Own directory from the chunk's source tag — survives folder renames
-- as long as this file sits in the addon root.
local src = (debug.getinfo(1, 'S').source or ''):gsub('^@', '')
P.addon_path = (src:match('^(.*)[/\\][^/\\]*$') or src) .. '\\'

local function ashita_root()
    local ok, p = pcall(function() return AshitaCore:GetInstallPath() end)
    return ok and p or nil
end
P.windower_path = ashita_root() or P.addon_path .. '..\\..\\'

-- FFXI install dir: Ashita doesn't expose it directly; read the POL
-- InstallFolder from the registry (HKLM\SOFTWARE\PlayOnline*) and take
-- the sibling FINAL FANTASY XI directory.
ffi.cdef[[
    unsigned long GetFileAttributesA(const char* path);
    int CreateDirectoryA(const char* path, void* attr);
    int DeleteFileA(const char* path);
    void* FindFirstFileA(const char* pattern, void* data);
    int FindNextFileA(void* handle, void* data);
    int FindClose(void* handle);
    long RegOpenKeyExA(unsigned long hkey, const char* sub, unsigned long opts,
                       unsigned long sam, void* out);
    long RegQueryValueExA(void* hkey, const char* name, void* reserved,
                          void* type, unsigned char* data, unsigned long* len);
    long RegCloseKey(void* hkey);
    int ShellExecuteA(void* hwnd, const char* op, const char* file,
                      const char* params, const char* dir, int show);
]]

local function reg_ffxi_path()
    local HKLMR = ffi.new('void*[1]')
    local roots = {
        'SOFTWARE\\WOW6432Node\\PlayOnlineUS\\InstallFolder',
        'SOFTWARE\\WOW6432Node\\PlayOnlineEU\\InstallFolder',
        'SOFTWARE\\WOW6432Node\\PlayOnlineJP\\InstallFolder',
        'SOFTWARE\\PlayOnlineUS\\InstallFolder',
        'SOFTWARE\\PlayOnlineEU\\InstallFolder',
        'SOFTWARE\\PlayOnlineJP\\InstallFolder',
    }
    for _, sub in ipairs(roots) do
        if ffi.C.RegOpenKeyExA(0x80000002, sub, 0, 0x20019, HKLMR) == 0 then
            local buf = ffi.new('unsigned char[512]')
            local len = ffi.new('unsigned long[1]', 512)
            local rc = ffi.C.RegQueryValueExA(HKLMR[0], nil, nil, nil, buf, len)
            ffi.C.RegCloseKey(HKLMR[0])
            if rc == 0 and len[0] > 0 then
                local pol = ffi.string(buf, len[0] - 1)
                -- InstallFolder ends in ...\PlayOnlineViewer; FFXI is the
                -- sibling under the same SquareEnix dir.
                local fx = pol:gsub('[\\/]+$', '')
                    :gsub('[/\\][^/\\]+$', '\\FINAL FANTASY XI')
                return fx
            end
        end
    end
    return nil
end

do
    local fx = reg_ffxi_path()
    if fx then
        local a = ffi.C.GetFileAttributesA(fx .. '\\FTABLE.DAT')
        if a == 0xFFFFFFFF then fx = nil end
    end
    P.ffxi_path = fx -- nil when undiscoverable; callers nil-check
end

----------------------------------------------------------------------
-- Filesystem helpers
----------------------------------------------------------------------

local FILE_ATTR_DIR = 0x10

function P.file_exists(path)
    local a = ffi.C.GetFileAttributesA(path)
    return a ~= 0xFFFFFFFF and band(a, FILE_ATTR_DIR) == 0
end

function P.dir_exists(path)
    local a = ffi.C.GetFileAttributesA(path)
    return a ~= 0xFFFFFFFF and band(a, FILE_ATTR_DIR) ~= 0
end

function P.create_dir(path)
    -- tolerate nested paths: create each component
    local partial = ''
    for seg in tostring(path):gmatch('[^/\\]+') do
        partial = partial == '' and seg or (partial .. '\\' .. seg)
        ffi.C.CreateDirectoryA(partial, nil)
    end
end

-- WIN32_FIND_DATAA: enough to read dwFileAttributes + cFileName (@0x2C).
local find_data = ffi.new('unsigned char[592]')
-- [NOT PORTED] mtime listing for the palette-departure watch —
-- io.popen exists under Ashita too, so the Windower impl would probably
-- work, but it's unverified; nil disables the feature there.
P.file_mtimes = nil

function P.get_dir(path)
    local out = {}
    local h = ffi.C.FindFirstFileA(path .. '\\*', find_data)
    if h == ffi.cast('void*', -1) or h == nil then return out end
    repeat
        local name = ffi.string(find_data + 0x2C)
        -- match Windower's get_dir: no . / .. entries
        if name ~= '.' and name ~= '..' then out[#out + 1] = name end
    until ffi.C.FindNextFileA(h, find_data) == 0
    ffi.C.FindClose(h)
    return out
end

----------------------------------------------------------------------
-- Game reads (plat.ffxi)
----------------------------------------------------------------------

local function mem()   return AshitaCore:GetMemoryManager() end
local function ent()   return mem():GetEntity() end
local function inv()   return mem():GetInventory() end
local function party() return mem():GetParty() end
local function play()  return mem():GetPlayer() end
local function rcast() return mem():GetRecast() end

local ffxi = {}
P.ffxi = ffxi

-- Bag name keys matching plat_windower's get_items()/get_bag_info()
-- contract (Windower bag ids == Ashita Container enum values).
local BAG_KEYS = {
    [0] = 'inventory', 'safe', 'storage', 'temporary', 'locker',
    'satchel', 'sack', 'case', 'wardrobe', 'safe2',
    'wardrobe2', 'wardrobe3', 'wardrobe4', 'wardrobe5',
    'wardrobe6', 'wardrobe7', 'wardrobe8',
}

-- Equipment slot names in memory-array order (the equip-slot id used by
-- outgoing 0x050 and by ffxi_inventory_t.Equipment[]).
local EQUIP_SLOT_NAMES = {
    'main', 'sub', 'range', 'ammo', 'head', 'body', 'hands', 'legs',
    'feet', 'neck', 'waist', 'lear', 'rear', 'lring', 'rring', 'back',
}

local function own_index()
    local ok, i = pcall(function() return party():GetMemberTargetIndex(0) end)
    return ok and i or nil
end

function ffxi.get_player()
    local name = party():GetMemberName(0) or ''
    local mj = play():GetMainJob() or 0
    local sj = play():GetSubJob() or 0
    local status = 0
    local idx = own_index()
    if idx then
        local ok, s = pcall(function() return ent():GetStatus(idx) end)
        if ok then status = s or 0 end
    end
    return {
        name = name ~= '' and name or nil,
        main_job_id = mj,
        main_job_level = play():GetMainJobLevel() or 0,
        sub_job_id = sj,
        sub_job_level = play():GetSubJobLevel() or 0,
        status = status,
    }
end

function ffxi.get_info()
    local name = party():GetMemberName(0)
    local zone = party():GetMemberZone(0) or 0
    return {
        logged_in = type(name) == 'string' and name ~= '' or nil,
        zone = zone,
        zoning = pcall(function() return play():GetIsZoning() end) and
            play():GetIsZoning() or false,
    }
end

-- item_t.Extra is uint8[28]; Windower's extdata is the 24-byte aug blob.
-- [UNVERIFIED] whether ours is the first or last 24 of the 28.
local function extra_str(extra)
    if extra == nil then return nil end
    local t = {}
    for i = 0, 23 do
        local ok, b = pcall(function() return extra[i] end)
        t[#t + 1] = string.char((ok and tonumber(b) or 0) % 256)
    end
    return table.concat(t)
end

function ffxi.get_items(bagname)
    if bagname == 'equipment' then
        -- Windower flat map: <slot_name> = item index,
        -- <slot_name>_bag = container id.
        local eq = {}
        for i = 0, 15 do
            local ok, e = pcall(function() return inv():GetEquippedItem(i) end)
            if ok and e and e.Index and e.Index > 0 then
                -- [UNVERIFIED] packing: low byte = item index, high = bag
                local name = EQUIP_SLOT_NAMES[i + 1]
                eq[name] = band(e.Index, 0xFF)
                eq[name .. '_bag'] = band(rshift(e.Index, 8), 0xFF)
            end
        end
        return eq
    end
    local items = {}
    for bag, key in pairs(BAG_KEYS) do
        local bagt = {}
        -- capacity, not count: empty slots interleave and trailing
        -- empties past Count are still addressable
        local ok, n = pcall(function() return inv():GetContainerCountMax(bag) end)
        n = ok and n or 0
        for i = 1, n do
            local ok2, it = pcall(function() return inv():GetContainerItem(bag, i) end)
            if ok2 and it and it.Id and it.Id > 0 then
                local fl = it.Flags or 0
                bagt[#bagt + 1] = {
                    id = it.Id,
                    slot = it.Index or i,
                    index = it.Index or i,
                    count = it.Count or 1,
                    status = band(fl, 0xFF), -- 5 = equipped
                    extdata = extra_str(it.Extra),
                }
            end
        end
        items[key] = bagt
        items[bag] = bagt
    end
    items.equipment = ffxi.get_items('equipment')
    return items
end

function ffxi.get_bag_info()
    local infos = {}
    for bag, key in pairs(BAG_KEYS) do
        local ok, cur = pcall(function() return inv():GetContainerCount(bag) end)
        local ok2, mx = pcall(function() return inv():GetContainerCountMax(bag) end)
        infos[key] = { enabled = true, count = ok and cur or 0,
                       max = ok2 and mx or 0 }
        infos[bag] = infos[key]
    end
    return infos
end

-- Windower's get_ability_recasts() → {recast_id = remaining_secs}.
-- Ashita's recast timers: 32 slots, GetAbilityTimerId(i) + GetAbilityTimer(i).
function ffxi.get_ability_recasts()
    local out = {}
    for i = 0, 31 do
        local ok, id = pcall(function() return rcast():GetAbilityTimerId(i) end)
        local ok2, t = pcall(function() return rcast():GetAbilityTimer(i) end)
        if ok and ok2 and id and id > 0 and t and t > 0 then
            out[id] = t
        end
    end
    return out
end

-- Spell timers are indexed by spell id.
function ffxi.get_spell_recasts()
    local out = {}
    for i = 0, 1023 do
        local ok, t = pcall(function() return rcast():GetSpellTimer(i) end)
        if ok and t and t > 0 then out[i] = t end
    end
    return out
end

-- [UNVERIFIED] learned-set reads: Ashita v4's recast/inventory managers
-- don't expose "known abilities/spells", so the ability book falls back
-- to obtainable-only (learned highlights just won't mark). If a
-- GetLearnedAbilities-style call exists on IPlayer it slots in here.
function ffxi.get_abilities()
    return { job_abilities = {}, weapon_skills = {} }
end
function ffxi.get_spells()
    return {}
end

-- FFXI position struct order is {X, Z, Y} — Z is the vertical axis.
-- Windower's x/y/z convention maps: x=X, y=Y, z=Z.
local function ent_pos(i)
    local e = ent()
    return e:GetLocalPositionX(i), e:GetLocalPositionY(i), e:GetLocalPositionZ(i)
end

function ffxi.get_mob_by_target(t)
    if t ~= 'me' and t ~= 'player' then return nil end
    local idx = own_index()
    if not idx then return nil end
    local x, y, z = ent_pos(idx)
    return {
        index = idx,
        name = party():GetMemberName(0),
        x = x, y = y, z = z,
        facing = pcall(function() return ent():GetHeading(idx) end) and
            ent():GetHeading(idx) or 0,
    }
end

function ffxi.get_mob_by_index(index)
    if not index then return nil end
    local x, y, z = ent_pos(index)
    return {
        index = index,
        name = ent():GetName(index),
        x = x, y = y, z = z,
    }
end

-- get_mob_array: Windower entity fields used by map.lua —
-- name, valid_target, x, y, z, facing, hpp, distance (squared),
-- spawn_type (SpawnFlags), is_npc, in_party, in_alliance.
-- SpawnFlags bits match Windower's spawn_type numbering: 0x01 PC,
-- 0x02 NPC, 0x10 mob, 0x04 party, 0x08 alliance, 0x200 local player.
function ffxi.get_mob_array()
    local e = ent()
    local arr = {}
    local me = own_index()
    for i = 0, 2303 do
        local ok, id = pcall(function() return e:GetServerId(i) end)
        if ok and id and id > 0 then
            local sf = e:GetSpawnFlags(i) or 0
            local etype = 0
            local okt, tp = pcall(function() return e:GetType(i) end)
            if okt then etype = tp or 0 end
            local x, y, z = ent_pos(i)
            local okd, d = pcall(function() return e:GetDistance(i) end)
            arr[i] = {
                index = i,
                name = e:GetName(i),
                x = x, y = y, z = z,
                facing = pcall(function() return e:GetHeading(i) end) and
                    e:GetHeading(i) or 0,
                hpp = pcall(function() return e:GetHPPercent(i) end) and
                    e:GetHPPercent(i) or 0,
                distance = okd and d or 0,
                spawn_type = sf,
                is_npc = etype ~= 0 and band(sf, 0x10) == 0,
                in_party = band(sf, 0x04) ~= 0,
                in_alliance = band(sf, 0x08) ~= 0,
                valid_target = pcall(function()
                        return e:GetWarpTargetIndex(i)
                    end) and e:GetWarpTargetIndex(i) > 0 or false,
            }
            if i == me then arr[i].name = arr[i].name or '' end
        end
    end
    return arr
end

-- [NOT PORTED] get_map_data: Windower reads the client's loaded mapinfo
-- (world->map-pixel transform + map number). Ashita exposes
-- IPlayer:GetSubMapNum() for the map number, but the pixel projection
-- needs the mapinfo floats — they live in a packed section of the zone
-- map DAT (numap block) or the client's in-memory struct. Returning nil
-- disables the map radar cleanly; revisit with a live client to calibrate.
function ffxi.get_map_data()
    return nil
end

-- drop_item: inject outgoing 0x028 (Discard Item).
function ffxi.drop_item(index, count)
    local pk = P._packets.new('outgoing', 0x028, {
        ['Count'] = count or 1, ['Bag'] = 0, ['Inventory Index'] = index,
    })
    P._packets.inject(pk)
end

----------------------------------------------------------------------
-- Actions / events
----------------------------------------------------------------------

function P.send_command(cmd)
    -- mode -1 = parse as if typed (handles / and // prefixes)
    pcall(function() AshitaCore:GetChatManager():QueueCommand(-1, cmd) end)
end

function P.open_url(url)
    ffi.C.ShellExecuteA(nil, 'open', url, nil, nil, 1)
end

function P.add_to_chat(mode, msg)
    local ok = pcall(function()
        AshitaCore:GetChatManager():Write(mode or 207, false, tostring(msg))
    end)
    if not ok then pcall(print, msg) end
end

----------------------------------------------------------------------
-- Events — plat.on maps Windower names onto ashita.events.
-- 'incoming chunk'->packet_in, 'outgoing chunk'->packet_out,
-- 'addon command'->command (parsed), 'prerender'/'time change'->
-- d3d_present, 'load'/'unload' direct, 'login'/'logout' synthesized
-- from login-state edges during the d3d_present pump.
----------------------------------------------------------------------

local handlers = { login = {}, logout = {} }
local was_logged_in = false

local function split_words(s)
    local w = {}
    for word in tostring(s):gmatch('%S+') do w[#w + 1] = word end
    return w
end

local function fire_login_edge(entering)
    local ev = entering and 'login' or 'logout'
    for _, fn in ipairs(handlers[ev]) do pcall(fn) end
end

local event_seq = 0
function P.on(name, fn)
    if name == 'login' or name == 'logout' then
        handlers[name][#handlers[name] + 1] = fn
        return
    end
    local ev
    if name == 'incoming chunk' then
        ev = 'packet_in'
    elseif name == 'outgoing chunk' then
        ev = 'packet_out'
    elseif name == 'addon command' then
        ev = 'command'
    elseif name == 'prerender' or name == 'time change' then
        ev = 'd3d_present'
    else
        ev = name -- 'load', 'unload', any ashita-native name passes through
    end
    event_seq = event_seq + 1
    ashita.events.register(ev, 'xicompanion_' .. ev .. '_' .. event_seq, function(e)
        if ev == 'packet_in' or ev == 'packet_out' then
            -- e.data_modified is the live buffer (post-edit, what the
            -- game sees) — same semantics as Windower's chunk `data`.
            fn(e.id, e.data_modified or e.data, e.modified,
               e.injected, e.blocked)
        elseif ev == 'command' then
            local w = split_words(e.command)
            local first = (w[1] or ''):lower():gsub('^/+', '')
            if first == 'xicompanion' or first == 'xicomp' then
                e.blocked = true
                fn(w[2], unpack(w, 3))
            end
        else
            fn(e)
        end
    end)
end

-- Login edge pump: piggybacks on d3d_present so login/logout semantics
-- exist without Ashita having explicit events for them.
ashita.events.register('d3d_present', 'xicompanion_login_edge', function()
    local ok, name = pcall(function() return party():GetMemberName(0) end)
    local logged = ok and type(name) == 'string' and name ~= ''
    if logged ~= was_logged_in then
        was_logged_in = logged
        fire_login_edge(logged)
    end
end)

----------------------------------------------------------------------
-- Compat shims for Windower host libs (registered before xicompanion.lua's
-- requires run).
----------------------------------------------------------------------

-- 'config' — Windower config.load/save; Ashita equivalent is a plain
-- serialized table under data/settings.lua.
package.preload['config'] = function()
    local settings_path = P.addon_path .. 'data\\settings.lua'

    local function serialize(t, ind)
        ind = ind or ''
        local pad, pad2 = ind .. '    ', ind
        local parts = {}
        local keys = {}
        for k in pairs(t) do keys[#keys + 1] = k end
        table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
        for _, k in ipairs(keys) do
            local v = t[k]
            local key = type(k) == 'string' and k:match('^%a[%w_]*$')
                and k or ('[' .. (type(k) == 'number' and k
                    or string.format('%q', k)) .. ']')
            local val
            if type(v) == 'table' then
                val = serialize(v, pad)
            elseif type(v) == 'string' then
                val = string.format('%q', v)
            else
                val = tostring(v)
            end
            parts[#parts + 1] = pad .. key .. ' = ' .. val
        end
        return '{\n' .. table.concat(parts, ',\n') .. '\n' .. pad2 .. '}'
    end

    local function merge(def, saved)
        if type(def) ~= 'table' then return saved end
        local out = {}
        for k, v in pairs(def) do out[k] = v end
        if type(saved) == 'table' then
            for k, v in pairs(saved) do
                if type(v) == 'table' and type(out[k]) == 'table' then
                    out[k] = merge(out[k], v)
                else
                    out[k] = v
                end
            end
        end
        return out
    end

    local M = {}
    function M.load(defaults)
        local saved
        if P.file_exists(settings_path) then
            local ok, t = pcall(dofile, settings_path)
            if ok and type(t) == 'table' then saved = t end
        end
        return merge(defaults or {}, saved)
    end
    function M.save(settings)
        if not P.dir_exists(P.addon_path .. 'data') then
            P.create_dir(P.addon_path .. 'data')
        end
        local f = io.open(settings_path, 'wb')
        if f then
            f:write('return ' .. serialize(settings or {}) .. '\n')
            f:close()
        end
    end
    return M
end

-- 'packets' — minimal new/inject covering only the outgoing packets we
-- emit (0x028 drop, 0x029 move, 0x050 equip, 0x0F4 widescan, 0x10C/0x10D
-- RoE). Builds the raw buffer by field name, header = id | (size/2)<<16.
local function build_packet(id, fields)
    -- [id u16 | size_words u16][payload...] — sizes below are total bytes
    local layouts = {
        [0x028] = { size = 0x0C, fields = {
            { 'Count', 'u32', 0x04 }, { 'Bag', 'u8', 0x08 },
            { 'Inventory Index', 'u8', 0x09 } } },
        [0x029] = { size = 0x0C, fields = {
            { 'Count', 'u32', 0x04 }, { 'Bag', 'u8', 0x08 },
            { 'Target Bag', 'u8', 0x09 }, { 'Current Index', 'u8', 0x0A },
            { 'Target Index', 'u8', 0x0B } } },
        [0x050] = { size = 0x08, fields = {
            { 'Item Index', 'u8', 0x04 }, { 'Equip Slot', 'u8', 0x05 },
            { 'Bag', 'u8', 0x06 } } },
        [0x03A] = { size = 0x08, fields = {
            { 'Bag', 'u8', 0x04 }, { '_unknown1', 'u8', 0x05 },
            { '_unknown2', 'u16', 0x06 } } },
        [0x0F4] = { size = 0x08, fields = { { 'Flags', 'u8', 0x04 } } },
        [0x10C] = { size = 0x08, fields = { { 'RoE Quest', 'u16', 0x04 } } },
        [0x10D] = { size = 0x08, fields = { { 'RoE Quest', 'u16', 0x04 } } },
    }
    local lay = layouts[id]
    if not lay then return nil end
    local b = {}
    for i = 1, lay.size do b[i] = 0 end
    b[1] = band(id, 0xFF)
    b[2] = band(rshift(id, 8), 0xFF)
    b[3] = band(lay.size / 2, 0xFF)
    b[4] = 0
    for _, f in ipairs(lay.fields) do
        local v = tonumber(fields[f[1]]) or 0
        local off = f[3] + 1 -- 1-based
        if f[2] == 'u8' then
            b[off] = band(v, 0xFF)
        elseif f[2] == 'u16' then
            b[off] = band(v, 0xFF)
            b[off + 1] = band(rshift(v, 8), 0xFF)
        elseif f[2] == 'u32' then
            b[off] = band(v, 0xFF)
            b[off + 1] = band(rshift(v, 8), 0xFF)
            b[off + 2] = band(rshift(v, 16), 0xFF)
            b[off + 3] = band(rshift(v, 24), 0xFF)
        end
    end
    return b
end

local packets_shim = {
    new = function(kind, id, fields)
        return { kind = kind, id = id, bytes = build_packet(id, fields) }
    end,
    inject = function(pkt)
        if not pkt or not pkt.bytes then return end
        -- [UNVERIFIED] AddOutgoingPacket(id, packet) expects a byte array;
        -- if it wants a string instead the pcall below retries that shape.
        local pm = AshitaCore:GetPacketManager()
        local ok = pcall(pm.AddOutgoingPacket, pm, pkt.id, pkt.bytes)
        if not ok then
            pcall(pm.AddOutgoingPacket, pm, pkt.id,
                  string.char(unpack(pkt.bytes)))
        end
    end,
}
P._packets = packets_shim
package.preload['packets'] = function() return packets_shim end

-- 'resources' — subset of Windower's res.* consumed here, backed by
-- Ashita's IResourceManager plus static tables for slots/jobs/bags/zones.
package.preload['resources'] = function()
    local rm = function() return AshitaCore:GetResourceManager() end

    local res = {}

    res.jobs = {}
    local JOB_EN = { 'WAR', 'MNK', 'WHM', 'BLM', 'RDM', 'THF', 'PLD', 'DRK',
        'BST', 'BRD', 'RNG', 'SAM', 'NIN', 'DRG', 'SMN', 'BLU', 'COR', 'PUP',
        'DNC', 'SCH', 'GEO', 'RUN' }
    for i, s in ipairs(JOB_EN) do
        res.jobs[i] = { id = i, en = s, ens = s }
    end

    -- Windower res.slots indexing — FFXI slot bitmask order.
    local SLOT_EN = { 'main', 'sub', 'ranged', 'ammo', 'head', 'neck',
        'lear', 'rear', 'body', 'hands', 'lring', 'rring', 'back', 'waist',
        'legs', 'feet' }
    res.slots = {}
    for i, s in ipairs(SLOT_EN) do res.slots[i - 1] = { id = i - 1, en = s } end

    res.bags = {}
    local BAG_EN = { 'inventory', 'safe', 'storage', 'temporary', 'locker',
        'satchel', 'sack', 'case', 'wardrobe', 'safe2', 'wardrobe2',
        'wardrobe3', 'wardrobe4', 'wardrobe5', 'wardrobe6', 'wardrobe7',
        'wardrobe8' }
    for i, s in ipairs(BAG_EN) do res.bags[i - 1] = { id = i - 1, en = s } end

    -- bitmask -> member-keyed set (Windower resources post-process shape)
    local function mask_set(mask, base)
        local s = {}
        mask = tonumber(mask) or 0
        for b = 0, 31 do
            if band(mask, lshift(1, b)) ~= 0 then s[base + b] = true end
        end
        return s
    end

    -- item flag bit -> Windower flag names
    local FLAG_BITS = {
        [0x0001] = 'Flag01', [0x0040] = 'NoAuction', [0x0100] = 'NoDelivery',
        [0x0200] = 'NoPC',   [0x0800] = 'NoSale',    [0x2000] = 'NoTrade',
        [0x4000] = 'Exclusive', [0x8000] = 'Rare',
    }
    local function flag_set(flags)
        local s = {}
        flags = tonumber(flags) or 0
        for bitv, name in pairs(FLAG_BITS) do
            if band(flags, bitv) ~= 0 then s[name] = true end
        end
        return s
    end

    local function name0(name_table)
        if type(name_table) == 'table' then
            return name_table[0] or name_table[1] or name_table.en
        end
        return name_table
    end

    -- Lazy per-id accessors — avoids enumerating 30k+ items up front.
    local item_cache = {}
    res.items = setmetatable({}, {
        __index = function(_, id)
            id = tonumber(id)
            if not id then return nil end
            if item_cache[id] ~= nil then return item_cache[id] or nil end
            local ok, it = pcall(function() return rm():GetItemById(id) end)
            local rec
            if ok and it then
                rec = {
                    id = id,
                    en = name0(it.Name),
                    enl = name0(it.NameLog or it.Name),
                    level = it.Level, ilvl = it.ItemLevel,
                    stack = it.StackSize, type = it.Type,
                    jobs = mask_set(it.Jobs, 1),
                    slots = mask_set(it.Slots, 0),
                    flags = flag_set(it.Flags),
                }
            end
            item_cache[id] = rec or false
            return rec
        end,
    })

    res.spells = setmetatable({}, {
        __index = function(_, id)
            local ok, s = pcall(function() return rm():GetSpellById(id) end)
            if ok and s then
                return { id = id, en = name0(s.Name),
                         recast = s.RecastDelay and s.RecastDelay / 60 or 0 }
            end
        end,
    })

    res.job_abilities = setmetatable({}, {
        __index = function(_, id)
            local ok, a = pcall(function() return rm():GetAbilityById(id) end)
            if ok and a then return { id = id, en = name0(a.Name) } end
        end,
    })

    -- Windower's ability_recasts maps recast timer id -> ability info.
    -- Ashita equivalent: GetAbilityByTimerId.
    res.ability_recasts = setmetatable({}, {
        __index = function(_, tid)
            local ok, a = pcall(function()
                return rm():GetAbilityByTimerId(tid)
            end)
            if ok and a then
                return { en = name0(a.Name), action_id = a.Id }
            end
        end,
    })

    res.key_items = setmetatable({}, {
        __index = function(_, id)
            local ok, s = pcall(function()
                return rm():GetString('keyitems', id)
            end)
            if ok and type(s) == 'string' and s ~= '' then
                return { id = id, en = s }
            end
        end,
    })

    res.zones = setmetatable({}, {
        __index = function(_, id)
            local ok, s = pcall(function()
                return rm():GetString('zones', id)
            end)
            if ok and type(s) == 'string' and s ~= '' then
                return { id = id, en = s }
            end
        end,
    })

    -- Auto-translate phrases: GetString('autotrans'|'ability'...)? The
    -- resource table name is unverified; xicompanion.lua also falls back to the
    -- generated at_names.lua, so an empty table degrades gracefully.
    res.auto_translates = setmetatable({}, {
        __index = function(_, id)
            local ok, s = pcall(function()
                return rm():GetString('autotranslate', id)
            end)
            if ok and type(s) == 'string' and s ~= '' then
                return { en = s }
            end
        end,
    })

    res.item_descriptions = setmetatable({}, {
        __index = function(_, id)
            local ok, it = pcall(function() return rm():GetItemById(id) end)
            if ok and it and it.Description then
                return { en = name0(it.Description) }
            end
        end,
    })

    return res
end

return P
