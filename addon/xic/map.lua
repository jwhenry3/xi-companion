-- map.lua: player position + nearby entities + widescan entries for the
-- /map page and the /minimap floating window.
--
-- Positions come from windower.ffxi.get_map_data() — the client's own
-- world->map-pixel projection, so multi-map zones and floor selection are
-- already handled. The pixel space is the installed map DAT's resolution
-- (512 retail, larger under hi-res map mods); `ms` in the payload tracks
-- the observed space so the frontend can normalize to u,v fractions.
--
-- Entities come from get_mob_array() (render range ~50y) — the always-on
-- radar layer. Widescan (0x0F4 bursts between 0x0F6 markers, 0x0F5 track
-- updates) reaches much further but only exists while a scan is active;
-- its x/y are map-pixel offsets relative to the player's map position.
--
-- polled from pump() every call; internally throttled to 4Hz. Map px are
-- rounded to ints so the payload diff only fires on real movement.
--
-- Party/alliance membership rides entity flags (f&1/f&2); linkshell has
-- no entity flag, so a per-character roster accumulates the names of
-- everyone heard speaking in the LS channels (0x017 modes 5/27) —
-- persisted under data/lsnames/<char>.lua and matched by name. Only
-- talkers are covered; the client never exposes a full member list.
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
    if windower.file_exists(path) then
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
    if not windower.dir_exists(dir) then
        pcall(windower.create_dir, dir)
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

local function scan(now)
    local ok, me = pcall(windower.ffxi.get_mob_by_target, 'me')
    if not ok or type(me) ~= 'table' or not me.index then return nil end
    local mid, mx, my
    local ok2, a, b, c = pcall(windower.ffxi.get_map_data, me.index)
    if ok2 then mid, mx, my = a, b, c end
    if not mx then
        local ok3, a2, b2, c2 = pcall(windower.ffxi.get_map_data, me.x, me.y, me.z)
        if ok3 then mid, mx, my = a2, b2, c2 end
    end
    if not mx then return nil end -- un-mapped area (limbus cutscenes etc.)
    mid, mx, my = mid or 0, math.floor(mx + 0.5), math.floor(my + 0.5)
    grow_space(math.max(math.abs(mx), math.abs(my)))

    local zone = 0
    local okz, info = pcall(windower.ffxi.get_info)
    if okz and type(info) == 'table' then zone = info.zone or 0 end
    local zn
    local zr = ctx.res and ctx.res.zones and ctx.res.zones[zone]
    if zr then zn = zr.en end

    local ents = ctx.json_array and ctx.json_array({}) or {}
    local okm, arr = pcall(windower.ffxi.get_mob_array)
    if okm and type(arr) == 'table' then
        for idx, e in pairs(arr) do
            -- the mob array is keyed by index and includes the player;
            -- nameless rows are array padding — targetable but not real
            -- entities, so they must not reach the radar or the list
            if type(e) == 'table' and idx ~= me.index and e.valid_target
                and e.name ~= nil and e.name ~= '' then
                local _, ex, ey = windower.ffxi.get_map_data(e.x, e.y, e.z)
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
                    ents[#ents + 1] = {
                        i = idx, n = e.name, x = ex, y = ey,
                        st = e.spawn_type or 0,
                        f = fl,
                        hp = e.hpp or 0,
                        d = e.distance and
                            math.floor(math.sqrt(e.distance) * 10 + 0.5) / 10
                            or 0,
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

    return {
        z = zone, zn = zn, m = mid, ms = mspace,
        me = { x = mx, y = my, f = me.facing or 0 },
        e = ents,
        ws = ws,
        wsa = wsa and 1 or 0,
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
            ws_pending[index] = {
                i = index, l = level, t = typ,
                x = xo, y = yo, n = name,
            }
        end
        ws_deadline = now + 0.35
    elseif id == 0x0F5 and data and #data >= 20 then
        -- tracked target's live world pos (float X@4, Z@8, Y@12 — FFXI's
        -- up axis is Y) → back through get_map_data for an absolute map
        -- position, which beats the stale scan-time offset
        local _, fx = pcall(string.unpack, '<f', data, 5)
        local _, fz = pcall(string.unpack, '<f', data, 9)
        local _, fy = pcall(string.unpack, '<f', data, 13)
        local index = data:byte(19) + data:byte(20) * 256
        local e = ws_pending[index] or ws_list[index]
        if e then
            e.tr = 1
            if fx and fy and fz then
                local _, tx, ty = pcall(
                    windower.ffxi.get_map_data, fx, fy, fz)
                if tx then
                    e.wx = math.floor(tx + 0.5)
                    e.wy = math.floor(ty + 0.5)
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
    mspace = 512
    last_payload = nil
end

return M
