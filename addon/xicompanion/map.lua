-- map.lua: player position + nearby entities + widescan entries for the
-- /map page and the /minimap floating window.
--
-- Positions come from plat.ffxi.get_map_data() — the client's own
-- world->map-pixel projection, so multi-map zones and floor selection are
-- already handled. The pixel space is the installed map DAT's resolution
-- (512 retail, larger under hi-res map mods); `ms` in the payload tracks
-- the observed space so the frontend can normalize to u,v fractions.
--
-- Entities come from get_mob_array() (render range ~50y) — the always-on
-- radar layer. Widescan (0x0F4 bursts between 0x0F6 markers, 0x0F5 track
-- updates) reaches much further but only exists while a scan is active;
-- its x/z are world-yalm deltas from the player, so each entry is
-- projected through get_map_data at receipt into absolute map px
-- (wx/wy) — the same transform the entities and tracked targets use.
--
-- polled from pump() every call; internally throttled to 4Hz. Map px are
-- rounded to ints so the payload diff only fires on real movement.
--
-- Party/alliance membership rides entity flags (f&1/f&2); linkshell has
-- no entity flag, so a per-character roster accumulates the names of
-- everyone heard speaking in the LS channels (0x017 modes 5/27) —
-- persisted under data/lsnames/<char>.lua and matched by name. Only
-- talkers are covered; the client never exposes a full member list.
local plat = require('plat')
local M = {}
local ctx

local ws_pending = {}        -- index -> entry, accumulating a 0x0F4 burst
local ws_deadline = 0        -- commit the burst ~0.3s after it goes quiet
local ws_list = {}           -- last committed scan (index -> entry)
local ws_tracked = nil       -- index the client is tracking (outgoing 0x0F5)
local poll_n = 0
local last_payload = nil     -- last json we broadcast/snapshotted
local mspace = 512           -- observed map pixel space (hi-res mods > 512)

local ls_names = { {}, {} }  -- [1]=linkshell, [2]=linkshell2 name sets
local ls_char = nil          -- character the loaded sets belong to
local ls_dirty = false
local ls_next_save = 0

-- Static points of interest (telepoints, homepoints, books, maws...) from
-- the generated mappois.lua table (scripts/extract-pois.py). Entries are
-- world yalms {x, y=ns, z=height} per zone; they're projected through the
-- client's get_map_data once per zone and cached as map px keyed by the
-- sub-map id the projection assigns — the same transform entities use, so
-- multi-map zones just work. Missing file just means no POI markers.
local poi_world = {}
do
    local ok, t = pcall(dofile, plat.addon_path .. 'mappois.lua')
    if ok and type(t) == 'table' then poi_world = t end
end
local poi_px = {}            -- zone -> {{x,y,m,k,n}} projected+cached
local poi_miss = {}          -- zone -> true: projection attempted, none usable

-- NM set: the client never reports notorious status (no entity flag,
-- nothing in widescan packets) — so it's matched by name against the
-- generated nm_names.lua table (bg-wiki Category:Notorious_Monster via
-- scripts/extract-nms.py). Missing file just means no NM colors.
local zone_lower -- current zone name (lower), set each pump
local nm_names, nm_shared = {}, {}
do
    local ok, t = pcall(dofile, plat.addon_path .. 'nm_names.lua')
    if ok and type(t) == 'table' then nm_names = t end
    -- zone-scoped shared names: {name} = {zone=true}. Shipped seed
    -- (nm_shared.lua, generated/learned-merged on release) plus the
    -- per-install overlay //xicompanion nm writes to data/ — both merge
    for _, p in ipairs({
        plat.addon_path .. 'nm_shared.lua',
        plat.addon_path .. 'data/nm_shared.lua',
    }) do
        local ok2, t2 = pcall(dofile, p)
        if ok2 and type(t2) == 'table' then
            for n, zs in pairs(t2) do
                local d = nm_shared[n] or {}
                if type(zs) == 'table' then
                    for z in pairs(zs) do d[z] = true end
                end
                nm_shared[n] = d
            end
        end
    end
end

local function is_nm(name, zone_lower)
    if nm_names[name] then return true end
    local zs = nm_shared[name]
    return zs ~= nil and zone_lower ~= nil and zs[zone_lower] == true
end

local function persist_shared()
    if plat.create_dir then
        pcall(plat.create_dir, plat.addon_path .. 'data')
    end
    local out = { 'return {' }
    for n, zs in pairs(nm_shared) do
        local parts = {}
        for z in pairs(zs) do
            parts[#parts + 1] = string.format('[%q]=true', z)
        end
        out[#out + 1] = string.format('    [%q] = { %s },',
            n, table.concat(parts, ','))
    end
    out[#out + 1] = '}'
    -- converge to the shipped seed too — data/ is per-install and a
    -- git tag never picks it up
    for _, p in ipairs({
        plat.addon_path .. 'data/nm_shared.lua',
        plat.addon_path .. 'nm_shared.lua',
    }) do
        local g = io.open(p, 'wb')
        if g then g:write(table.concat(out, '\n')) g:close() end
    end
end

-- //xicompanion nm <name>: mark a shared-name mob as an NM in the
-- current zone (learned into the data/ overlay; merged to the shipped
-- nm_shared.lua on release). Returns the name + zone marked.
function M.learn_nm(name, zone_name)
    if not name or name == '' then return nil end
    name = name:lower()
    if nm_names[name] then return name, nil end -- already globally NM
    local d = nm_shared[name] or {}
    d[zone_name:lower()] = true
    nm_shared[name] = d
    persist_shared()
    return name, zone_name
end

function M.setup(deps)
    ctx = deps
end

local function ls_file(char)
    return ctx.join(ctx.data_dir, 'lsnames',
        (char:gsub('[^%w]', '_')) .. '.lua')
end

local function ls_load()
    if not ctx.player_name then return end
    local char = ctx.player_name()
    if not char or char == 'me' or char == '' then return end
    if ls_char == char then return end
    ls_char = char
    ls_names = { {}, {} }
    local path = ls_file(char)
    if plat.file_exists(path) then
        local ok, t = pcall(dofile, path)
        if ok and type(t) == 'table' then
            for _, n in ipairs(t.ls1 or {}) do ls_names[1][n] = true end
            for _, n in ipairs(t.ls2 or {}) do ls_names[2][n] = true end
        end
    end
end

local function ls_save(now)
    if not ls_dirty or not ls_char or now < ls_next_save then return end
    ls_dirty = false
    ls_next_save = now + 15
    local dir = ctx.join(ctx.data_dir, 'lsnames')
    if not plat.dir_exists(dir) then
        pcall(plat.create_dir, dir)
    end
    local function dump(set)
        local names = {}
        for n in pairs(set) do names[#names + 1] = n end
        table.sort(names)
        local out = {}
        for _, n in ipairs(names) do
            out[#out + 1] = string.format('%q', n)
        end
        return '{' .. table.concat(out, ',') .. '}'
    end
    local f = io.open(ls_file(ls_char), 'wb')
    if not f then return end
    f:write('return {ls1=' .. dump(ls_names[1])
        .. ',ls2=' .. dump(ls_names[2]) .. '}')
    f:close()
end

local function grow_space(px)
    while px and px > mspace do mspace = mspace * 2 end
end

local function poi_for(zone)
    local cached = poi_px[zone]
    if cached then return cached end
    if poi_miss[zone] then return nil end
    local rows = poi_world[zone]
    if not rows then
        poi_miss[zone] = true
        return nil
    end
    local out = {}
    for _, p in ipairs(rows) do
        local ok, mid, px, py = pcall(
            plat.ffxi.get_map_data, p.x, p.y, p.z)
        if not (ok and px) then
            -- a few captured heights sit just outside a floor's band;
            -- ground level picks the right sub-map for anything walkable
            ok, mid, px, py = pcall(
                plat.ffxi.get_map_data, p.x, p.y, 0)
        end
        if ok and px then
            px = math.floor(px + 0.5)
            py = math.floor(py + 0.5)
            grow_space(math.max(math.abs(px), math.abs(py)))
            out[#out + 1] = { x = px, y = py, m = mid, k = p.k, n = p.n }
        end
    end
    if #out == 0 then
        poi_miss[zone] = true
        return nil
    end
    poi_px[zone] = out
    return out
end

local function scan(now)
    local ok, me = pcall(plat.ffxi.get_mob_by_target, 'me')
    if not ok or type(me) ~= 'table' or not me.index then return nil end
    local mid, mx, my
    local ok2, a, b, c = pcall(plat.ffxi.get_map_data, me.index)
    if ok2 then mid, mx, my = a, b, c end
    if not mx then
        local ok3, a2, b2, c2 = pcall(plat.ffxi.get_map_data, me.x, me.y, me.z)
        if ok3 then mid, mx, my = a2, b2, c2 end
    end
    if not mx then return nil end -- un-mapped area (limbus cutscenes etc.)
    mid, mx, my = mid or 0, math.floor(mx + 0.5), math.floor(my + 0.5)
    grow_space(math.max(math.abs(mx), math.abs(my)))

    local zone = 0
    local okz, info = pcall(plat.ffxi.get_info)
    if okz and type(info) == 'table' then zone = info.zone or 0 end
    local zn
    local zr = ctx.res and ctx.res.zones and ctx.res.zones[zone]
    if zr then zn = zr.en end
    zone_lower = zn and zn:lower() -- module cache for is_nm + learn_nm

    -- grid coord ("F-10") from the client's own pos function — the same
    -- string <pos> expands to; absent under Ashita (no mapinfo read)
    local pos
    if plat.ffxi.get_position then
        local okp, p = pcall(plat.ffxi.get_position, me.index)
        if okp and type(p) == 'string' and p ~= '' then pos = p end
    end

    local ents = ctx.json_array and ctx.json_array({}) or {}
    local okm, arr = pcall(plat.ffxi.get_mob_array)
    if okm and type(arr) == 'table' then
        for idx, e in pairs(arr) do
            -- the mob array is keyed by index and includes the player;
            -- nameless rows are array padding — targetable but not real
            -- entities, so they must not reach the radar or the list
            if type(e) == 'table' and idx ~= me.index and e.valid_target
                and e.name ~= nil and e.name ~= '' then
                local _, ex, ey = plat.ffxi.get_map_data(e.x, e.y, e.z)
                if ex then
                    ex = math.floor(ex + 0.5)
                    ey = math.floor(ey + 0.5)
                    grow_space(math.max(math.abs(ex), math.abs(ey)))
                    local fl = 0
                    if e.in_party then fl = fl + 1 end
                    if e.in_alliance then fl = fl + 2 end
                    if e.is_npc then fl = fl + 4 end
                    if ls_names[1][e.name] or ls_names[2][e.name] then
                        fl = fl + 8
                    end
                    if is_nm(e.name:lower(), zone_lower) then
                        fl = fl + 16
                    end
                    -- height delta vs the player: the mob struct's z is
                    -- the vertical axis but increases DOWNWARD (mobs
                    -- below read positive), so flip it — +el = above.
                    -- The radar turns |el| >= a few yalms into ▲/▼
                    local elv
                    if e.z ~= nil and me.z ~= nil then
                        elv = math.floor(me.z - e.z + 0.5)
                    end
                    ents[#ents + 1] = {
                        i = idx, n = e.name, x = ex, y = ey,
                        st = e.spawn_type or 0,
                        f = fl,
                        hp = e.hpp or 0,
                        d = e.distance and
                            math.floor(math.sqrt(e.distance) * 10 + 0.5) / 10
                            or 0,
                        el = elv,
                    }
                end
            end
        end
    end

    -- commit a widescan burst once the packet stream has gone quiet
    if ws_deadline > 0 and now > ws_deadline then
        ws_deadline = 0
        ws_list = ws_pending
        ws_pending = {}
    end
    local wsa = next(ws_list) ~= nil or next(ws_pending) ~= nil
    local ws = ctx.json_array and ctx.json_array({}) or {}
    for _, e in pairs(ws_list) do ws[#ws + 1] = e end
    for _, e in pairs(ws_pending) do ws[#ws + 1] = e end

    -- POIs live on the sub-map their height projects to — only emit the
    -- current map's set (mid changes as the player crosses floors)
    local poi
    local ptab = poi_for(zone)
    if ptab then
        poi = ctx.json_array and ctx.json_array({}) or {}
        for _, p in ipairs(ptab) do
            if p.m == mid then
                poi[#poi + 1] = { x = p.x, y = p.y, k = p.k, n = p.n }
            end
        end
    end

    return {
        z = zone, zn = zn, m = mid, ms = mspace, pos = pos,
        me = { x = mx, y = my, f = me.facing or 0 },
        e = ents,
        ws = ws,
        wsa = wsa and 1 or 0,
        poi = poi,
    }
end

-- every 6th pump call — pump fires on prerender (~60fps) so this lands
-- around 10Hz, and during the zoning blackout (no presents) the
-- time-change ticks still tick it along. A count, not os.clock(): pump
-- cadence is what actually drives us.
function M.poll()
    if not ctx then return end
    poll_n = poll_n + 1
    if poll_n % 6 ~= 0 then return end
    if not ctx.logged_in() then
        if last_payload then
            last_payload = nil
            ctx.sse_broadcast('map', '{"on":0}')
        end
        return
    end
    local now = os.clock()
    ls_load()
    ls_save(now)
    local s = scan(now)
    local payload = s and ctx.json.encode(s) or '{"on":0}'
    if payload ~= last_payload then
        last_payload = payload
        ctx.sse_broadcast('map', payload)
    end
end

-- 0x0F4 widescan entry: u16 index@5, u8 level@7, u8 type@8,
-- i16 x@9, i16 y@11, char[16] name@13. 0x0F5 track update: float x,z,y,
-- u8 level, u16 index, u32 status. 0x0F6 mark: u32 type — the client gets
-- one when a scan starts/ends; the pending-burst deadline handles framing,
-- so marks just reset an empty scan.
function M.handle_incoming(id, data)
    local now = os.clock()
    if id == 0x017 and data and #data >= 24 then
        -- chat message: mode byte @5, sender char[15] @9. Linkshell
        -- speakers are by definition members — grow the roster.
        local ch = data:byte(5)
        local which = ch == 5 and 1 or ch == 27 and 2 or nil
        if which then
            ls_load()
            local name = data:sub(9, 23):match('^([^%z]*)')
            if name ~= '' and not ls_names[which][name] then
                ls_names[which][name] = true
                ls_dirty = true
            end
        end
    elseif id == 0x0F4 and data and #data >= 28 then
        local index = data:byte(5) + data:byte(6) * 256
        local level = data:byte(7)
        local typ = data:byte(8)
        local xo = data:byte(9) + data:byte(10) * 256
        local yo = data:byte(11) + data:byte(12) * 256
        if xo >= 0x8000 then xo = xo - 0x10000 end
        if yo >= 0x8000 then yo = yo - 0x10000 end
        local name = data:sub(13, 28):match('^([^%z]*)')
        -- index 0 is the player ("You"); nameless / typeless rows are
        -- padding the client sends in the burst — not real blips
        if index ~= 0 and name ~= nil and name ~= '' and typ ~= 0 then
            local e = {
                i = index, l = level, t = typ,
                x = xo, y = yo, n = name,
                nm = is_nm(name:lower(), zone_lower) and 1 or nil,
            }
            -- xo/yo are world-yalm deltas from the player, not map px —
            -- project (player pos + delta) through the client's own
            -- map transform so the diamond lands where the in-game map
            -- puts it. Widescan is same-floor, so the player's height
            -- selects the right sub-map.
            local mok, me = pcall(plat.ffxi.get_mob_by_target, 'me')
            if mok and type(me) == 'table' and me.x and me.y then
                local _, tx, ty = pcall(plat.ffxi.get_map_data,
                    me.x + xo, me.y + yo, me.z or 0)
                if tx then
                    e.wx = math.floor(tx + 0.5)
                    e.wy = math.floor(ty + 0.5)
                end
            end
            ws_pending[index] = e
        end
        ws_deadline = now + 0.35
    elseif id == 0x0F5 and data and #data >= 20 then
        -- tracked target's live world pos (float X@4, Z@8, Y@12 — the
        -- packet's 'Y' field is height, exposed as .z on mob records) →
        -- back through get_map_data for an absolute map position, which
        -- beats the stale scan-time offset. get_map_data takes mob-struct
        -- order (x, north-south, height), so packet Z precedes packet Y.
        local _, fx = pcall(string.unpack, '<f', data, 5)
        local _, fz = pcall(string.unpack, '<f', data, 9)
        local _, fy = pcall(string.unpack, '<f', data, 13)
        local index = data:byte(19) + data:byte(20) * 256
        local e = ws_pending[index] or ws_list[index]
        if e then
            e.tr = 1
            if fx and fy and fz then
                local _, tx, ty = pcall(
                    plat.ffxi.get_map_data, fx, fz, fy)
                if tx then
                    e.wx = math.floor(tx + 0.5)
                    e.wy = math.floor(ty + 0.5)
                end
                -- fy is the target's live height — keep the same player-
                -- relative elevation delta the radar dots carry
                local mok, pme = pcall(plat.ffxi.get_mob_by_target, 'me')
                if mok and type(pme) == 'table' and pme.z then
                    e.el = math.floor(pme.z - fy + 0.5)
                end
            end
        end
    elseif id == 0x0F6 then
        -- scan markers arrive when widescan opens/closes; a mark with no
        -- pending entries means the last list was cancelled
        if next(ws_pending) == nil then
            ws_list = {}
            ws_tracked = nil
        end
    end
end

-- outgoing 0x0F5 sets the tracked index (0 clears tracking)
function M.handle_outgoing(id, data)
    if id == 0x0F5 and data and #data >= 6 then
        ws_tracked = data:byte(5) + data:byte(6) * 256
        if ws_tracked == 0 then ws_tracked = nil end
    end
end

function M.snapshot_json()
    return last_payload or '{"on":0}'
end

-- logout/zone: stale blips must not leak into the next zone
function M.reset()
    ws_pending = {}
    ws_deadline = 0
    ws_list = {}
    ws_tracked = nil
    poi_px = {}
    poi_miss = {}
    mspace = 512
    last_payload = nil
end

return M
