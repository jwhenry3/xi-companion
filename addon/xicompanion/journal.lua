-- XI Companion journal tracker.
--
-- Parses the incoming quest/mission log (0x056), RoE active objectives
-- (0x111) and RoE completion bitfield (0x112) packets into a per-character
-- journal, persists it under data/, and feeds the frontend through
-- GET /api/journal (+ /api/journal/names) and `journal` SSE events.
--
-- The log packets only arrive on zone-in and when the log changes, so the
-- in-memory state is seeded from the persisted file as soon as the player
-- name is known and rewritten (debounced) whenever packets mutate it.
--
-- Packet references: addons/libs/packets/fields.lua (0x056 subtypes,
-- roe_quest bit type, 0x112 order page), and the generated
-- journal_names.lua for area/storyline tables.

local plat = require('plat')
local M = {}

local QUEST_AREAS = {
    -- subtype -> area key (current quests bitfield, 32 bytes @0x04 unless noted)
    [0x0050] = 'sandoria',   [0x0058] = 'bastok',
    [0x0060] = 'windurst',   [0x0068] = 'jeuno',
    [0x0070] = 'other',      [0x0078] = 'outlands',
    [0x0088] = 'crystal_war',[0x00E0] = 'abyssea',
    [0x00F0] = 'adoulin',    [0x0100] = 'coalition',
}
local QUEST_DONE = {
    [0x0090] = 'sandoria',   [0x0098] = 'bastok',
    [0x00A0] = 'windurst',   [0x00A8] = 'jeuno',
    [0x00B0] = 'other',      [0x00B8] = 'outlands',
    [0x00C8] = 'crystal_war',[0x00E8] = 'abyssea',
    [0x00F8] = 'adoulin',    [0x0108] = 'coalition',
}
-- completed-mission bitfield offsets within 0x00D0 / 0x00D8 (8 bytes each)
local NATION_LINES = { 'sandoria', 'bastok', 'windurst' }
-- storylines that only ever expose a "current mission" pointer: everything
-- with a smaller sort key counts as completed.
local POINTER_LINES = { 'cop', 'soa', 'rov', 'acp', 'mkd', 'asa', 'tvr' }

local join
local json
local json_array
local sse_broadcast
local log
local log_err
local player_name_fn
local data_root
local zones_res   -- resources zones table (id -> {en=...})
local mob_name_fn -- index -> npc/mob display name

local names = nil -- generated journal_names.lua contents
local regime_names = { fov = {}, gov = {} } -- generated regime_names.lua

local state = nil
local dirty = false
local save_timer = 0

local function empty_state(char)
    return {
        char = char,
        nation = nil,
        quests = {},    -- area -> { current={id=1}, done={id=1} }
        missions = {},  -- line -> { current=<id>, done={id=1}, finished=bool }
        roe = { active = {}, done = {} },
        untracked = {}, -- 'kind:key:id' -> true: hidden from the tracker window
        updated = os.time(),
    }
end

----------------------------------------------------------------------
-- persistence: data/journal/<char>.lua holding `return {...}`
----------------------------------------------------------------------

local function serialize(v, out)
    out = out or {}
    local t = type(v)
    if t == 'number' or t == 'boolean' then
        out[#out + 1] = tostring(v)
    elseif t == 'string' then
        out[#out + 1] = string.format('%q', v)
    elseif t == 'table' then
        out[#out + 1] = '{'
        local arr = #v > 0
        if arr then
            for i = 1, #v do
                if i > 1 then out[#out + 1] = ',' end
                serialize(v[i], out)
            end
        else
            local first = true
            for k, val in pairs(v) do
                if not first then out[#out + 1] = ',' end
                first = false
                if type(k) == 'number' then
                    out[#out + 1] = '[' .. k .. ']='
                else
                    out[#out + 1] = '["' .. k .. '"]='
                end
                serialize(val, out)
            end
        end
        out[#out + 1] = '}'
    end
    return table.concat(out)
end

local function journal_dir()
    return join(data_root, 'journal')
end

local function journal_file(char)
    return join(journal_dir(), (char:gsub('[^%w]', '_')) .. '.lua')
end

local function load_persisted(char)
    local path = journal_file(char)
    if not plat.file_exists(path) then return nil end
    local ok, t = pcall(dofile, path)
    if ok and type(t) == 'table' then
        return t
    end
    return nil
end

local function persist()
    if not state or not state.char then return end
    if not plat.dir_exists(journal_dir()) then
        pcall(plat.create_dir, journal_dir())
    end
    local path = journal_file(state.char)
    local f = io.open(path, 'wb')
    if not f then return end
    f:write('return ' .. serialize(state))
    f:close()
end

local function ensure_state()
    local char = player_name_fn and player_name_fn() or nil
    if not char or char == 'me' or char == '' then
        return nil -- not logged in far enough to own a journal yet
    end
    if state and state.char == char then
        return state
    end
    state = load_persisted(char) or empty_state(char)
    state.char = char
    state.untracked = state.untracked or {} -- persisted files predate the field
    return state
end

----------------------------------------------------------------------
-- bitfields / unpacking (packet data strings are 1-indexed)
----------------------------------------------------------------------

local function bit_set(data, first, nbytes, into)
    for i = 0, nbytes - 1 do
        local b = data:byte(first + i) or 0
        if b ~= 0 then
            for bit = 0, 7 do
                if (b % 2) >= 1 then
                    into[i * 8 + bit] = true
                end
                b = (b - (b % 2)) / 2
            end
        end
    end
end

local function u16(data, pos)
    local a, b = data:byte(pos, pos + 1)
    return (a or 0) + (b or 0) * 256
end

local function u32(data, pos)
    local a, b, c, d = data:byte(pos, pos + 3)
    return ((d or 0) * 256 + (c or 0)) * 65536 + ((b or 0) * 256 + (a or 0))
end

local function i32(data, pos)
    local v = u32(data, pos)
    return v >= 0x80000000 and v - 0x100000000 or v
end

local function line_st(line)
    local st = ensure_state()
    if not st then return nil end
    local m = st.missions[line]
    if not m then
        m = { done = {} }
        st.missions[line] = m
    end
    return m
end

local function quest_st(area)
    local st = ensure_state()
    if not st then return nil end
    local q = st.quests[area]
    if not q then
        q = { current = {}, done = {} }
        st.quests[area] = q
    end
    return q
end

local function set_current_mission(line, value)
    local m = line_st(line)
    if m then
        -- negative pointers mean "no active mission" on every storyline
        m.current = (type(value) == 'number' and value >= 0) and value or nil
        dirty = true
    end
end

----------------------------------------------------------------------
-- 0x056 quest/mission log
----------------------------------------------------------------------

local function handle_quest_mission(data)
    if #data < 0x26 then return end
    local st = ensure_state()
    if not st then return end
    local subtype = (data:byte(0x25) or 0) + (data:byte(0x26) or 0) * 256

    local cur_area = QUEST_AREAS[subtype]
    if cur_area then
        local q = quest_st(cur_area)
        q.current = {}
        bit_set(data, 5, 32, q.current)
        dirty = true
        return
    end
    local done_area = QUEST_DONE[subtype]
    if done_area then
        local q = quest_st(done_area)
        q.done = {}
        bit_set(data, 5, 32, q.done)
        dirty = true
        return
    end

    if subtype == 0x0080 then
        local q = quest_st('toau')
        q.current = {}
        bit_set(data, 5, 16, q.current) -- TOAU quests: 16 bytes only
        set_current_mission('assault', i32(data, 0x15))
        set_current_mission('toau', i32(data, 0x19))
        set_current_mission('wotg', i32(data, 0x1D))
        set_current_mission('campaign', i32(data, 0x21))
    elseif subtype == 0x00C0 then
        local q = quest_st('toau')
        q.done = {}
        bit_set(data, 5, 16, q.done)
        local m = line_st('assault')
        m.done = {}
        bit_set(data, 0x15, 16, m.done)
        dirty = true
    elseif subtype == 0x00D0 then
        -- completed nation + zilart mission bitfields, 8 bytes each
        for i, line in ipairs(NATION_LINES) do
            local m = line_st(line)
            m.done = {}
            bit_set(data, 5 + (i - 1) * 8, 8, m.done)
        end
        local z = line_st('zilart')
        z.done = {}
        bit_set(data, 5 + 24, 8, z.done)
        dirty = true
    elseif subtype == 0x00D8 then
        local t = line_st('toau')
        t.done = {}
        bit_set(data, 5, 8, t.done)
        local w = line_st('wotg')
        w.done = {}
        bit_set(data, 0x0D, 8, w.done)
        dirty = true
    elseif subtype == 0x0030 or subtype == 0x0038 then
        local m = line_st('campaign')
        m.done = m.done or {}
        local base = subtype == 0x0038 and 256 or 0
        local into = {}
        bit_set(data, 5, 32, into)
        for bit in pairs(into) do
            m.done[base + bit] = true
        end
        dirty = true
    elseif subtype == 0xFFFF then
        st.nation = i32(data, 5)
        local nation_line = NATION_LINES[(st.nation or 0) + 1]
        local cur_nation = i32(data, 9)
        for _, line in ipairs(NATION_LINES) do
            local m = line_st(line)
            m.current = (line == nation_line) and cur_nation or nil
        end
        set_current_mission('zilart', i32(data, 0x0D))
        set_current_mission('cop', i32(data, 0x11))
        -- the add-on scenario missions live in nibbles; 0 = not started
        local b18 = data:byte(0x19) or 0
        local b19 = data:byte(0x1A) or 0
        set_current_mission('acp', b18 % 16 > 0 and b18 % 16 or nil)
        set_current_mission('mkd', b18 >= 16 and math.floor(b18 / 16) or nil)
        set_current_mission('asa', b19 % 16 > 0 and b19 % 16 or nil)
        set_current_mission('soa', i32(data, 0x1D))
        set_current_mission('rov', i32(data, 0x21))
    elseif subtype == 0xFFFE then
        local raw = i32(data, 5)
        -- bit 31 set = no active TVR mission; low bits carry the mission id
        local m = line_st('tvr')
        m.current = raw < 0 and nil or raw
        dirty = true
    end
end

----------------------------------------------------------------------
-- 0x111 RoE active objectives / 0x112 RoE completion log
----------------------------------------------------------------------

local function handle_roe_update(data)
    local st = ensure_state()
    if not st then return end
    local active = {}
    for i = 0, 29 do
        local v = u32(data, 5 + i * 4)
        local id = v % 4096
        if id > 0 then
            active[#active + 1] = { id = id, progress = math.floor(v / 4096) }
        end
    end
    -- limited-time objective lives at the tail
    if #data >= 0x104 then
        local v = u32(data, 0x101)
        local id = v % 4096
        if id > 0 then
            active[#active + 1] = { id = id, progress = math.floor(v / 4096), limited = true }
        end
    end
    st.roe.active = active
    dirty = true
end

local function handle_roe_log(data)
    local st = ensure_state()
    if not st or #data < 0x88 then return end
    local order = u32(data, 0x85)
    local bits = {}
    bit_set(data, 5, 128, bits)
    for bit in pairs(bits) do
        st.roe.done[order * 1024 + bit] = true
    end
    dirty = true
end

----------------------------------------------------------------------
-- Fields of Valor / Grounds of Valor (training regimes)
--
-- There is no zone-in state sync for regimes; state is learned live:
--  - outgoing 0x05B dialogue choice at a Field Manual/Grounds Tome NPC:
--      option == 3            -> regime canceled
--      option % 16 == 2       -> page select: page = option >> 4
--      option bit 0x80000000  -> re-registering last regime (repeat)
--  - incoming 0x05C menu params (8 u32s @0x04): page preview carries
--    {n1..n4, 0, low, high, regime_id}; a "review" request carries
--    {req1..4, killed1..4}
--  - incoming 0x029/0x02D action messages:
--      558 = defeated a target (param1=killed, param2=needed)
--      559 = completed regime
--      643 = regime begins anew (daily renewal)
--  - incoming 0x113: valor points (tabs) u16 @0x1C
--
-- Page -> objectives/levels comes from generated regime_names.lua.
-- Option/message structure mirrors darkstar/LSB's regimes.lua, which is
-- built from retail captures.
----------------------------------------------------------------------

local MANUAL_NPCS = {
    ['Field Manual'] = 'fov',
    ['Grounds Tome'] = 'gov',
    ['Survival Guide'] = 'gov',
}
local REGIME_MSG = {
    [558] = 'progress', -- killed, needed
    [559] = 'done',
    [643] = 'anew',
}
local MAX_PAGE = { fov = 5, gov = 10 }

local menu_ctx = nil       -- {kind=, zone=, t=} while a manual menu is open
local pending_choice = nil -- last 0x05B option sent to a manual

local function zone_disp_name(zone_id)
    local z = zones_res and zones_res[zone_id]
    return z and (z.en or z.english or z.name) or nil
end

local regime_lookup = nil -- normalized zone name -> kind -> page -> def
local function regime_def(kind, zone_id, page)
    if not regime_lookup then
        regime_lookup = {}
        for k, zones in pairs(regime_names) do
            for zname, pages in pairs(zones or {}) do
                local nk = zname:lower():gsub('[^%w]', '')
                regime_lookup[nk] = regime_lookup[nk] or {}
                local by_page = {}
                for _, p in ipairs(pages) do by_page[p.page] = p end
                regime_lookup[nk][k] = by_page
            end
        end
    end
    local zname = zone_disp_name(zone_id)
    if not zname then return nil, nil end
    local z = regime_lookup[zname:lower():gsub('[^%w]', '')]
    local def = z and z[kind] and z[kind][page]
    return def, zname
end

local function valor_accept(kind, zone_id, page, repeat_)
    local st = ensure_state()
    if not st then return end
    local def, zname = regime_def(kind, zone_id, page)
    local needs = {}
    if def then
        for i, n in ipairs(def.needs or {}) do needs[i] = n end
    end
    local v = st.valor
    local same = v and v.kind == kind and v.zone == zone_id and v.page == page
    if same and not repeat_ then
        return -- re-picked the active page; keep progress
    end
    st.valor = {
        kind = kind,
        zone = zone_id,
        zone_name = zname,
        page = page,
        desc = def and def.desc or nil,
        needs = needs,
        killed = {},
        low = def and def.low or nil,
        high = def and def.high or nil,
        accepted = os.time(),
    }
    dirty = true
end

local function valor_cancel()
    local st = ensure_state()
    if st and st.valor then
        st.valor = nil
        dirty = true
    end
end

-- classify an outgoing 0x05B dialogue choice; kind is only set when the
-- packet's target resolved to a manual/tome NPC
function M.handle_outgoing(id, data)
    if id ~= 0x05B or type(data) ~= 'string' or #data < 0x14 then return end
    local target_index = u16(data, 0x0D)
    local npc = mob_name_fn and mob_name_fn(target_index) or nil
    local kind = npc and MANUAL_NPCS[npc] or nil
    if not kind then return end
    local zone = u16(data, 0x11)
    -- option u32 = low word (choice value) + high word (repeat flag in
    -- bit 15, i.e. u32 bit 31). Reading the words separately sidesteps
    -- 0x80000000 parsing differently across lua flavours
    local option = u16(data, 9)
    local repeat_ = u16(data, 0x0B) >= 0x8000
    menu_ctx = { kind = kind, zone = zone, t = os.clock() }
    pending_choice = { kind = kind, zone = zone, option = option, t = os.clock() }
    if option == 3 then
        valor_cancel()
        return
    end
    if option % 16 == 2 then
        local page = math.floor(option / 16)
        if page >= 1 and page <= MAX_PAGE[kind] then
            valor_accept(kind, zone, page, repeat_)
        end
    end
end

-- incoming menu-open / params while a manual menu has context
local function apply_menu_params(p)
    local st = ensure_state()
    local v = st and st.valor
    -- page preview/select echo: {n1..n4, 0, low, high, regime_id}
    if p[5] == 0 and p[6] > 0 and p[7] > 0 and p[8] > 0 then
        if v then
            v.low, v.high = p[6], p[7]
            v.regime = p[8]
            local needs = {}
            for i = 1, 4 do
                if p[i] > 0 then needs[#needs + 1] = p[i] end
            end
            if #needs > 0 then v.needs = needs end
            dirty = true
        end
        return
    end
    -- review current regime: {req1..4, killed1..4}
    if v and (p[1] > 0 or p[2] > 0 or p[3] > 0 or p[4] > 0) then
        local needs, killed = {}, {}
        for i = 1, 4 do
            if p[i] > 0 then
                needs[#needs + 1] = p[i]
                killed[#killed + 1] = p[i + 4]
            end
        end
        if #needs > 0 then
            v.needs = needs
            v.killed = killed
            dirty = true
        end
    end
end

local function menu_ctx_live()
    return menu_ctx and (os.clock() - menu_ctx.t) < 15 and menu_ctx or nil
end

local function handle_menu_info(data)
    -- 0x05C Dialogue Information: 32B menu params @0x04
    if not menu_ctx_live() then return end
    local p = {}
    for i = 0, 7 do
        p[i + 1] = u32(data, 5 + i * 4)
    end
    apply_menu_params(p)
end

local function handle_npc_menu(id, data)
    -- 0x033: name @0x10, params @0x50; 0x034: index @0x28, params @0x08;
    -- 0x032: index @0x08 only (no params)
    local npc, params_off
    if id == 0x033 then
        if #data < 0x30 then return end
        local name = data:sub(0x11, 0x20):match('^%Z+')
        npc = name
        params_off = 0x51
    else
        if #data < 0x0C then return end
        local idx = id == 0x034 and u16(data, 0x29) or u16(data, 9)
        npc = mob_name_fn and mob_name_fn(idx) or nil
        params_off = id == 0x034 and 9 or nil
    end
    local kind = npc and MANUAL_NPCS[npc] or nil
    if not kind then return end
    menu_ctx = { kind = kind, t = os.clock() }
    if params_off and #data >= params_off + 31 then
        local p = {}
        for i = 0, 7 do
            p[i + 1] = u32(data, params_off + i * 4)
        end
        apply_menu_params(p)
    end
end

local function handle_valor_message(id, data)
    -- 0x029: params @0x0C/0x10, msg @0x18; 0x02D: params @0x10/0x14, msg @0x18
    local msg = u16(data, 0x19) % 0x8000
    local kind = REGIME_MSG[msg]
    if not kind then return end
    local st = ensure_state()
    local v = st and st.valor
    if not v then return end
    if kind == 'done' then
        v.done = true
        for i, n in ipairs(v.needs or {}) do v.killed[i] = n end
        dirty = true
        return
    end
    if kind == 'anew' then
        v.done = nil
        v.killed = {}
        dirty = true
        return
    end
    -- progress: param1 = killed, param2 = needed
    local off = id == 0x02D and 0x11 or 0x0D
    local killed, needed = u32(data, off), u32(data, off + 4)
    local needs = v.needs or {}
    v.killed = v.killed or {}
    local matched = false
    for i = 1, #needs do
        if needs[i] == needed and (v.killed[i] or 0) < needs[i] then
            v.killed[i] = killed
            matched = true
            break
        end
    end
    if not matched then
        for i = 1, #needs do
            if (v.killed[i] or 0) < needs[i] then
                v.killed[i] = math.min(killed, needs[i])
                matched = true
                break
            end
        end
    end
    if not matched and needed > 0 then
        v.last = { killed = killed, needed = needed }
    end
    dirty = true
end

local function handle_valor_points(data)
    if #data < 0x1E then return end
    local st = ensure_state()
    if not st then return end
    st.valor_points = u16(data, 0x1D)
    dirty = true
end

----------------------------------------------------------------------
-- public API
----------------------------------------------------------------------

local function pointer_completion()
    -- storylines with only a "current" pointer: flag them so the UI can
    -- show every record id below the pointer as completed.
    local st = state
    if not st then return end
    for _, line in ipairs(POINTER_LINES) do
        local m = st.missions[line]
        if m then
            m.inferred_done = (type(m.current) == 'number' and m.current > 0)
                or nil
        end
    end
end

local function state_payload()
    local st = state
    if not st then
        return { char = nil, updated = 0, quests = {}, missions = {}, roe = { active = {}, done = {} }, untracked = {}, valor = nil }
    end
    pointer_completion()
    local quests = {}
    for area, q in pairs(st.quests) do
        local cur, done = {}, {}
        for id in pairs(q.current or {}) do cur[#cur + 1] = id end
        for id in pairs(q.done or {}) do done[#done + 1] = id end
        table.sort(cur)
        table.sort(done)
        quests[area] = { current = json_array(cur), done = json_array(done) }
    end
    local missions = {}
    for line, m in pairs(st.missions) do
        local done = {}
        for id in pairs(m.done or {}) do done[#done + 1] = id end
        table.sort(done)
        missions[line] = {
            current = m.current,
            done = json_array(done),
            inferred_done = m.inferred_done or nil,
        }
    end
    local roe_done = {}
    for id in pairs(st.roe.done or {}) do roe_done[#roe_done + 1] = id end
    table.sort(roe_done)
    local un = {}
    for k in pairs(st.untracked or {}) do un[#un + 1] = k end
    table.sort(un)
    local v = st.valor
    local valor = nil
    if v then
        valor = {
            kind = v.kind,
            zone = v.zone,
            zone_name = v.zone_name,
            page = v.page,
            desc = v.desc,
            needs = json_array(v.needs or {}),
            killed = json_array(v.killed or {}),
            low = v.low,
            high = v.high,
            done = v.done or nil,
            regime = v.regime,
            accepted = v.accepted,
            last = v.last,
        }
    end
    return {
        char = st.char,
        nation = st.nation,
        updated = st.updated,
        quests = quests,
        missions = missions,
        roe = { active = json_array(st.roe.active), done = json_array(roe_done) },
        valor = valor,
        valor_points = st.valor_points,
        untracked = json_array(un),
    }
end

-- zone-in fires the log burst before the player struct always resolves;
-- packets dropped here would leave the journal empty until the next zone
local pending = {}

function M.handle_packet(id, data)
    if not ensure_state() then
        pending[#pending + 1] = { id, data }
        if #pending > 64 then
            table.remove(pending, 1)
        end
        return
    end
    if id == 0x056 then
        handle_quest_mission(data)
    elseif id == 0x111 then
        handle_roe_update(data)
    elseif id == 0x112 then
        handle_roe_log(data)
    elseif id == 0x05C then
        handle_menu_info(data)
    elseif id == 0x032 or id == 0x033 or id == 0x034 then
        handle_npc_menu(id, data)
    elseif id == 0x029 or id == 0x02D then
        handle_valor_message(id, data)
    elseif id == 0x113 then
        handle_valor_points(data)
    end
end

-- Called from the addon pump loop: flushes a debounced journal SSE event
-- and a debounced disk write so zone-in bursts coalesce.
function M.flush()
    if pending[1] and ensure_state() then
        local q = pending
        pending = {}
        for _, p in ipairs(q) do
            M.handle_packet(p[1], p[2])
        end
    end
    if not dirty then return end
    dirty = false
    local now = os.clock()
    if state then
        state.updated = os.time()
        sse_broadcast('journal', json.encode(state_payload()))
        -- first change persists immediately, later writes are debounced
        if save_timer == 0 or now - save_timer > 10 then
            save_timer = now
            persist()
        end
    end
end

function M.snapshot_json()
    ensure_state()
    return json.encode(state_payload())
end

-- Toggle an entry's or a whole group's visibility in the detached
-- tracker window. Entries are tracked by default; disabling stores
-- 'kind:key:id' (single entry) or 'kind:key' (the group — future items
-- in it stay hidden too) in state.untracked (persisted per character).
-- The dirty flag feeds the next flush -> both windows update over SSE.
function M.set_tracked(kind, key, id, tracked)
    local st = ensure_state()
    if not st then return nil, 'not logged in' end
    if kind ~= 'quest' and kind ~= 'mission' and kind ~= 'roe' and kind ~= 'valor' then
        return nil, 'bad kind'
    end
    key = tostring(key or '')
    if key == '' then return nil, 'bad key' end
    -- id 0 is a real mission/quest id — presence, not positivity, is
    -- what separates an entry toggle from a group toggle
    local n = tonumber(id)
    local k = n and (kind .. ':' .. key .. ':' .. n)
        or (kind .. ':' .. key)
    st.untracked = st.untracked or {}
    st.untracked[k] = (not tracked) or nil
    dirty = true
    return true
end

-- The generated tables key records by number; the shared encoder drops
-- numeric object keys, so remap id maps to string keys once and cache.
local names_json_cache = nil
local function stringify_keys(ids)
    local out = {}
    for k, v in pairs(ids or {}) do
        out[tostring(k)] = v
    end
    return out
end

local function transform_group(src)
    local out = {}
    for key, grp in pairs(src or {}) do
        out[key] = { name = grp.name, ids = stringify_keys(grp.ids) }
    end
    return out
end

function M.names_json()
    if not names_json_cache then
        names_json_cache = json.encode({
            quest_areas = transform_group(names.quest_areas),
            mission_lines = transform_group(names.mission_lines),
            roe = stringify_keys(names.roe),
            roe_categories = stringify_keys(names.roe_categories),
            roe_tree = stringify_keys(names.roe_tree or {}),
            regimes = regime_names,
        })
    end
    return names_json_cache
end

-- Character left the world: flush to disk and drop the in-memory state so
-- the next character gets a clean view.
function M.reset()
    if state then
        persist()
    end
    state = nil
    dirty = false
    pending = {}
end

function M.setup(deps)
    join = deps.join
    json = deps.json
    json_array = deps.json_array or function(t) return t end
    sse_broadcast = deps.sse_broadcast
    log = deps.log or function() end
    log_err = deps.log_err or log
    player_name_fn = deps.player_name
    data_root = deps.data_dir
    zones_res = deps.zones
    mob_name_fn = deps.mob_name
    local path = join(deps.addon_path, 'journal_names.lua')
    local ok, t = pcall(dofile, path)
    if ok and type(t) == 'table' then
        names = t
    else
        names = { quest_areas = {}, mission_lines = {}, roe = {}, roe_categories = {}, roe_tree = {} }
        log_err('journal_names.lua missing or invalid - run scripts/extract-journal.py')
    end
    local ok2, t2 = pcall(dofile, join(deps.addon_path, 'regime_names.lua'))
    if ok2 and type(t2) == 'table' then
        regime_names = { fov = t2.fov or {}, gov = t2.gov or {} }
    else
        regime_names = { fov = {}, gov = {} }
        log_err('regime_names.lua missing or invalid - run scripts/extract-regimes.py')
    end
end

return M
