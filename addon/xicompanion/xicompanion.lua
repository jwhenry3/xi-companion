_addon.name = 'xicompanion'
_addon.author = 'XI Companion'
_addon.version = '1.0.0'
_addon.commands = { 'xicompanion', 'xicomp' }

-- Ashita v4 reads `addon.*` instead of `_addon.*`; harmless under Windower.
addon = addon or {}
addon.name = 'xicompanion'
addon.author = 'XI Companion'
addon.version = '1.0.0'
addon.desc = 'XI Companion overlay server (GearSwap/inventory/chat/macros/journal)'
addon.commands = { '/xicompanion', '/xicomp' }

--[[
    XI Companion — GearSwap, inventory, chat, macros & journal overlay.

    Runs a small local HTTP server (LuaSocket) that:
      * serves the bundled frontend from ./ui
      * streams player inventory/wardrobe state over SSE at /api/events
      * exposes GearSwap lua files under addons/GearSwap/data for read/write

    Commands:
      //xicompanion          - status + help
      //xicompanion open     - open the UI in the default browser
      //xicompanion overlay  - launch the overlay window
      //xicompanion start    - start the server
      //xicompanion stop     - stop the server
      //xicompanion port <n> - change the port (restarts the server)
      //xicompanion refresh  - push a fresh state snapshot to connected clients
      //xicompanion swap     - toggle the on-screen set picker (see //xicompanion swap help)
      //xicompanion equip <set> - equip a sets.* path via GearSwap (`gs equip`)
]]
local plat = require('plat')

-- socket comes from the host's libs (Windower addons/libs, Ashita
-- addons/libs). Under Ashita this is the only unguarded host dep with no
-- fallback — surface failures loudly rather than dying silently.
local socket_ok, socket = pcall(require, 'socket')
if not socket_ok then
    local msg = '[xicompanion] LuaSocket unavailable — ' .. tostring(socket)
    if plat and plat.add_to_chat then
        pcall(plat.add_to_chat, 39, msg)
    end
    error(msg)
end
local res = require('resources')
local config = require('config')
local ok_macros, macrofs = pcall(require, 'macros')
if not ok_macros then macrofs = nil end

local defaults = {
    port = 17890,
    autostart = true,
    -- auto-launch the floating overlay button once a character logs in;
    -- //xicompanion fab off disables it (then use //xicompanion overlay to open manually)
    fab = true,
    -- auto-launch the transparent quest tracker alongside the fab;
    -- //xicompanion tracker off disables it
    tracker = true,
    -- auto-launch the detached macro bar alongside; //xicompanion macrobar off
    macrobar = true,
    -- auto-launch the detached cooldowns panel; //xicompanion cooldowns off
    cooldowns = true,
    -- auto-launch the detached minimap panel; //xicompanion minimap off
    minimap = true,
    -- auto-launch the party vitals panel; //xicompanion party off
    party = true,
    -- auto-launch the target HP/cast bar; //xicompanion target off
    target = true,
    -- auto-/check new mob targets so the target panel can show level
    -- + difficulty; //xicompanion check off
    target_check = true,
    -- auto-launch the skillchain/burst tracker; //xicompanion skillchain off
    skillchain = true,
    poll_interval = 1.5,
    -- messages kept per chat thread (each channel + each tell peer);
    -- served on reconnect so a reopened UI still has history
    chat_history = 200,
    -- distinct tell-peer threads remembered (LRU beyond this)
    chat_tell_threads = 64,
    -- player-defined filter channels: { { name, channels = {...} } }
    chat_custom_channels = {},
    -- opt-in: steal a key combo to open/focus our chat window while one
    -- is open — our composer opens instead of the client's chat line.
    swapui = {
        -- headless set scanner: custom[] holds sets added via `//xicompanion swap add`
        custom = {},
    },
}
local settings = config.load(defaults)
config.save(settings)

local CHAT_COLOR = 207

local function log(msg)
    plat.add_to_chat(CHAT_COLOR, '[xicompanion] ' .. msg)
end

local function log_err(msg)
    plat.add_to_chat(39, '[xicompanion] ' .. msg)
end

----------------------------------------------------------------------
-- Path helpers
----------------------------------------------------------------------

local function join(a, b)
    if a:sub(-1) ~= '\\' and a:sub(-1) ~= '/' then
        a = a .. '\\'
    end
    return a .. b
end

local ui_dir = join(plat.addon_path, 'ui')

local function gearswap_data_dir()
    local candidates = {
        'addons\\GearSwap\\data',
        'addons\\gearswap\\data',
    }
    for _, rel in ipairs(candidates) do
        local dir = join(plat.windower_path, rel)
        if plat.dir_exists(dir) then
            return dir
        end
    end
    return join(plat.windower_path, 'addons\\GearSwap\\data')
end

----------------------------------------------------------------------
-- Minimal JSON encoder
----------------------------------------------------------------------

local json

do
    local function esc(s)
        return (s:gsub('[%c"\\]', function(c)
            if c == '"' then return '\\"' end
            if c == '\\' then return '\\\\' end
            return string.format('\\u%04x', c:byte())
        end))
    end

    local function encode(v)
        local t = type(v)
        if t == 'nil' then
            return 'null'
        elseif t == 'boolean' or t == 'number' then
            return tostring(v)
        elseif t == 'string' then
            return '"' .. esc(v) .. '"'
        elseif t == 'table' then
            -- Decide array vs object: __json_array forces array, otherwise
            -- array when every key is an integer 1..n. Check the marker first:
            -- it is itself a string key and would defeat the key scan.
            local n = #v
            local is_arr = rawget(v, '__json_array') == true
            if not is_arr then
                is_arr = next(v) ~= nil
                if is_arr then
                    for k in pairs(v) do
                        if type(k) ~= 'number' or k < 1 or k > n or k % 1 ~= 0 then
                            is_arr = false
                            break
                        end
                    end
                end
            end
            if is_arr then
                local parts = {}
                for i = 1, n do
                    parts[i] = encode(v[i])
                end
                return '[' .. table.concat(parts, ',') .. ']'
            end
            local parts = {}
            for k, val in pairs(v) do
                if type(k) == 'string' and k ~= '__json_array' then
                    parts[#parts + 1] = '"' .. esc(k) .. '":' .. encode(val)
                end
            end
            return '{' .. table.concat(parts, ',') .. '}'
        end
        return 'null'
    end

    json = { encode = encode }
end

-- minimal JSON decoder for structured route bodies (our own UI's output
-- — byte-walked like everything else, never pattern machinery). `null`
-- decodes to false, which the validators reject as a wrong type anyway.
local function json_decode(s)
    if type(s) ~= 'string' then return nil end
    local i, n = 1, #s
    local parse_value
    local function ws()
        while i <= n do
            local b = s:byte(i)
            if b ~= 32 and b ~= 9 and b ~= 10 and b ~= 13 then break end
            i = i + 1
        end
    end
    local function parse_str()
        i = i + 1 -- opening quote
        local out = {}
        while i <= n do
            local b = s:byte(i)
            if b == 34 then
                i = i + 1
                return table.concat(out)
            elseif b == 92 then
                local c = s:byte(i + 1)
                if c == 110 then out[#out + 1] = '\n'
                elseif c == 116 then out[#out + 1] = '\t'
                elseif c == 114 then out[#out + 1] = '\r'
                elseif c == 117 then
                    -- \uXXXX → utf8 (bmp only)
                    local code = tonumber(s:sub(i + 2, i + 5), 16) or 63
                    if code < 128 then
                        out[#out + 1] = string.char(code)
                    elseif code < 2048 then
                        out[#out + 1] = string.char(192 + math.floor(code / 64), 128 + code % 64)
                    else
                        out[#out + 1] = string.char(224 + math.floor(code / 4096), 128 + math.floor(code / 64) % 64, 128 + code % 64)
                    end
                    i = i + 4
                else
                    out[#out + 1] = string.char(c or 0)
                end
                i = i + 2
            else
                out[#out + 1] = string.char(b)
                i = i + 1
            end
        end
        return nil -- unterminated
    end
    local function parse_arr()
        i = i + 1 -- [
        local t = {}
        ws()
        if s:byte(i) == 93 then i = i + 1; return t end
        while true do
            local v = parse_value()
            if v == nil then return nil end
            t[#t + 1] = v
            ws()
            local b = s:byte(i)
            if b == 44 then i = i + 1
            elseif b == 93 then i = i + 1; return t
            else return nil end
        end
    end
    local function parse_obj()
        i = i + 1 -- {
        local t = {}
        ws()
        if s:byte(i) == 125 then i = i + 1; return t end
        while true do
            ws()
            if s:byte(i) ~= 34 then return nil end
            local k = parse_str()
            if not k then return nil end
            ws()
            if s:byte(i) ~= 58 then return nil end
            i = i + 1
            local v = parse_value()
            if v == nil then return nil end
            t[k] = v
            ws()
            local b = s:byte(i)
            if b == 44 then i = i + 1
            elseif b == 125 then i = i + 1; return t
            else return nil end
        end
    end
    function parse_value()
        ws()
        local b = s:byte(i)
        if not b then return nil
        elseif b == 34 then return parse_str()
        elseif b == 91 then return parse_arr()
        elseif b == 123 then return parse_obj()
        elseif s:sub(i, i + 3) == 'true' then i = i + 4; return true
        elseif s:sub(i, i + 4) == 'false' then i = i + 5; return false
        elseif s:sub(i, i + 3) == 'null' then i = i + 4; return false
        else
            local j = i
            while j <= n do
                local c = s:byte(j)
                if c == 44 or c == 93 or c == 125 or c == 32
                    or c == 9 or c == 10 or c == 13 then
                    break
                end
                j = j + 1
            end
            local num = tonumber(s:sub(i, j - 1))
            i = j
            return num
        end
    end
    return parse_value()
end

local function json_array(t)
    rawset(t, '__json_array', true)
    return t
end

----------------------------------------------------------------------
-- Inventory collection
----------------------------------------------------------------------

local BAGS = {
    [0] = 'inventory',
    [1] = 'safe',
    [2] = 'storage',
    [4] = 'locker',
    [5] = 'satchel',
    [6] = 'sack',
    [7] = 'case',
    [8] = 'wardrobe',
    [9] = 'safe2',
    [10] = 'wardrobe2',
    [11] = 'wardrobe3',
    [12] = 'wardrobe4',
    [13] = 'wardrobe5',
    [14] = 'wardrobe6',
    [15] = 'wardrobe7',
    [16] = 'wardrobe8',
}

-- resources.lua post-processes bitmasks into S sets: jobs/slots/races hold
-- member ids as keys, flags holds flag-name strings as keys. Iterate pairs.
local function set_has(set, key)
    return type(set) == 'table' and rawget(set, key) == true
end

local SLOT_NAMES = {}
do
    for i = 0, 15 do
        local s = res.slots and res.slots[i]
        SLOT_NAMES[i] = (s and (s.en or s.english)) or ('slot' .. i)
    end
end

local JOB_SHORTS = {}
do
    for i = 1, 23 do
        local j = res.jobs and res.jobs[i]
        JOB_SHORTS[i] = j and (j.ens or j.en) or nil
    end
end

local function decode_slots(slotset)
    local out = json_array({})
    if type(slotset) ~= 'table' then return out end
    for slot_id in pairs(slotset) do
        if SLOT_NAMES[slot_id] then
            out[#out + 1] = SLOT_NAMES[slot_id]
        end
    end
    return out
end

local function decode_jobs(jobset)
    local out = json_array({})
    local count = 0
    if type(jobset) == 'table' then
        for job_id in pairs(jobset) do
            local name = JOB_SHORTS[job_id]
            if name then
                out[#out + 1] = name
                count = count + 1
            end
        end
    end
    return out, count >= 22
end

local function decode_flags(flagset)
    local out = json_array({})
    if type(flagset) == 'table' then
        for name in pairs(flagset) do
            if type(name) == 'string' then
                out[#out + 1] = name
            end
        end
        table.sort(out)
    end
    return out
end

-- Optional: reuse the shared extdata augment decoder (addons/libs/extdata.lua —
-- the same one GearSwap's `require 'extdata'` resolves).
local extdata_decoder = nil
local extdata_tried = false

local function try_extdata(item_id, extdata_hex)
    if not extdata_tried then
        extdata_tried = true
        if type(_G.extdata) == 'table' and type(_G.extdata.decode) == 'function' then
            extdata_decoder = _G.extdata
        else
            local ok, ret = pcall(require, 'extdata')
            if ok and type(ret) == 'table' and type(ret.decode) == 'function' then
                extdata_decoder = ret
            else
                local path = join(plat.windower_path, 'addons\\libs\\extdata.lua')
                if plat.file_exists(path) then
                    local ok2, ret2 = pcall(dofile, path)
                    if ok2 and type(ret2) == 'table' and type(ret2.decode) == 'function' then
                        extdata_decoder = ret2
                    end
                end
            end
        end
        if extdata_decoder == nil then
            log('extdata decoder not available; sending raw extdata only.')
        end
    end
    if not extdata_decoder or not extdata_hex or extdata_hex == '' then
        return nil
    end
    -- Rebuild the binary extdata string from hex.
    local raw = (extdata_hex:gsub('..', function(cc)
        return string.char(tonumber(cc, 16))
    end))
    local ok, decoded = pcall(extdata_decoder.decode, { id = item_id, extdata = raw })
    if ok and type(decoded) == 'table' and type(decoded.augments) == 'table' then
        local out = json_array({})
        for _, aug in pairs(decoded.augments) do
            if type(aug) == 'string' then
                out[#out + 1] = aug
            elseif type(aug) == 'table' then
                out[#out + 1] = aug
            end
        end
        if #out > 0 then
            return out
        end
    end
    return nil
end

local function item_meta(id)
    local item = res.items and res.items[id]
    if not item then
        return nil
    end
    local jobs, all_jobs = decode_jobs(item.jobs)
    local flags = item.flags
    return {
        id = id,
        name = item.en or item.english or item.name or ('item ' .. id),
        name_log = item.enl,
        category = item.category,
        level = item.level,
        ilvl = item.ilvl or item.ilevel or item.superior_level,
        slots = decode_slots(item.slots),
        jobs = jobs,
        all_jobs = all_jobs,
        flags = decode_flags(flags),
        rare = set_has(flags, 'Rare'),
        ex = set_has(flags, 'Exclusive'),
        stack = item.stack,
        type = item.type,
    }
end

local function hex(s)
    if not s then return nil end
    return (s:gsub('.', function(c)
        return string.format('%02X', c:byte())
    end))
end

local function collect_state()
    local state = {
        timestamp = os.time(),
        bags = json_array({}),
        catalog = {},
    }

    local player = plat.ffxi.get_player()
    if player then
        local main_job = res.jobs and res.jobs[player.main_job_id]
        local sub_job = player.sub_job_id and res.jobs and res.jobs[player.sub_job_id]
        state.player = {
            name = player.name,
            main_job = main_job and (main_job.ens or main_job.en) or tostring(player.main_job_id),
            main_job_id = player.main_job_id,
            main_job_level = player.main_job_level,
        }
        if player.sub_job_id and player.sub_job_id > 0 then
            state.player.sub_job = sub_job and (sub_job.ens or sub_job.en)
                or tostring(player.sub_job_id)
            state.player.sub_job_id = player.sub_job_id
            state.player.sub_job_level = player.sub_job_level
        end
    end

    -- get_items() / get_bag_info() are keyed by lowercase bag name
    -- ('inventory', 'wardrobe2', ...) matching the BAGS values; numeric ids
    -- are accepted too, so fall back to both.
    local all_items, bag_infos = nil, nil
    local ok_items, items_t = pcall(plat.ffxi.get_items)
    if ok_items and type(items_t) == 'table' then all_items = items_t end
    local ok_infos, infos_t = pcall(plat.ffxi.get_bag_info)
    if ok_infos and type(infos_t) == 'table' then bag_infos = infos_t end

    -- items.equipment maps equip slot -> where it's equipped. The real
    -- get_items() shape is FLAT: <slot>=<bag index> plus <slot>_bag=<bag>
    -- (GearSwap rebuilds the nested {slot,bag_id} form internally). Accept
    -- both and flatten to 'bag:index -> slot name' so equipped items can
    -- report which slot they occupy.
    local EQUIP_CMD = {
        lear = 'l.ear', rear = 'r.ear',
        lring = 'l.ring', rring = 'r.ring',
    }
    local equipment = type(all_items) == 'table' and all_items.equipment or nil
    if type(equipment) ~= 'table' then
        -- the no-arg call doesn't always carry it — the dedicated form does
        local ok_eq, eq_t = pcall(plat.ffxi.get_items, 'equipment')
        if ok_eq and type(eq_t) == 'table' then equipment = eq_t end
    end
    local equip_slots = {}
    if type(equipment) == 'table' then
        for slot_name, eq in pairs(equipment) do
            local slot_idx, bag_id
            if type(eq) == 'table' then
                slot_idx, bag_id = tonumber(eq.slot), tonumber(eq.bag_id)
            elseif not slot_name:find('_bag$') then
                slot_idx = tonumber(eq)
                bag_id = tonumber(equipment[slot_name .. '_bag'])
            end
            -- slot_idx 0 is the empty-slot sentinel
            if slot_idx and slot_idx > 0 then
                local key = ('%.0f:%.0f'):format(bag_id or 0, slot_idx)
                equip_slots[key] = EQUIP_CMD[slot_name] or slot_name
            end
        end
    end

    for bag_id, bag_key in pairs(BAGS) do
        local items = all_items and (all_items[bag_key] or all_items[bag_id])
        local info = bag_infos and (bag_infos[bag_key] or bag_infos[bag_id])
        if type(items) == 'table' or type(info) == 'table' then
            local bag = {
                id = bag_id,
                key = bag_key,
                name = bag_key:gsub('(%a)(%a*)', function(a, b) return a:upper() .. b end),
                enabled = not (type(info) == 'table' and info.enabled == false),
                max = type(info) == 'table' and info.max or nil,
                count = type(info) == 'table' and info.count or nil,
                items = json_array({}),
            }
            local res_bag = res.bags and res.bags[bag_id]
            if res_bag and (res_bag.en or res_bag.english) then
                bag.name = res_bag.en or res_bag.english
            end

            if type(items) == 'table' then
                for slot, entry in pairs(items) do
                    if type(slot) == 'number' and type(entry) == 'table' and entry.id and entry.id > 0 then
                        local ext = hex(entry.extdata)
                        local rec = {
                            slot = entry.slot or slot,
                            id = entry.id,
                            count = entry.count,
                            status = entry.status,
                            equipped = entry.status == 5,
                            equip_slot = equip_slots[('%.0f:%.0f'):format(bag_id, tonumber(entry.slot) or tonumber(slot) or -1)],
                            extdata = ext,
                        }
                        local augs = try_extdata(entry.id, ext)
                        if augs then
                            rec.augments = augs
                        end
                        bag.items[#bag.items + 1] = rec
                        -- Explicit int format: tostring() on a float can
                        -- produce '12345.0' and break id lookups.
                        local key = ('%.0f'):format(entry.id)
                        if state.catalog[key] == nil then
                            state.catalog[key] = item_meta(entry.id) or { id = entry.id, name = 'item ' .. entry.id }
                        end
                    end
                end
            end
            table.sort(bag.items, function(a, b) return a.slot < b.slot end)
            state.bags[#state.bags + 1] = bag
        end
    end
    table.sort(state.bags, function(a, b) return a.id < b.id end)

    return state
end

----------------------------------------------------------------------
-- GearSwap file API
----------------------------------------------------------------------

local function sanitize_rel_path(p)
    if type(p) ~= 'string' or p == '' then return nil end
    if p:find('%.%.') or p:find('^[/\\]') or p:find('^%a:') then return nil end
    if not p:match('^[%w%._%-%/\\ ]+$') then return nil end
    if not p:lower():match('%.lua$') then return nil end
    return p
end

local function list_gearswap_files()
    local dir = gearswap_data_dir()
    local files = json_array({})
    local found = plat.dir_exists(dir)
    if found then
        local function scan(sub)
            local base = sub and join(dir, sub) or dir
            local entries = plat.get_dir(base)
            if type(entries) ~= 'table' then return end
            table.sort(entries)
            for _, name in ipairs(entries) do
                local full = join(base, name)
                if plat.dir_exists(full) then
                    if not sub then
                        scan(name) -- one level deep: player-named folders
                    end
                elseif name:lower():match('%.lua$') then
                    files[#files + 1] = {
                        path = sub and (sub .. '/' .. name) or name,
                        name = name,
                        dir = sub or '',
                    }
                end
            end
        end
        scan(nil)
    end
    return { dir = dir, found = found, files = files }
end

local function read_gearswap_file(rel)
    rel = sanitize_rel_path(rel)
    if not rel then return nil, 'invalid path' end
    local full = join(gearswap_data_dir(), rel)
    local f = io.open(full, 'rb')
    if not f then return nil, 'not found' end
    local content = f:read('*a')
    f:close()
    return { path = rel, content = content }
end

local function write_gearswap_file(rel, content)
    rel = sanitize_rel_path(rel)
    if not rel then return nil, 'invalid path' end
    if type(content) ~= 'string' then return nil, 'missing content' end
    local full = join(gearswap_data_dir(), rel)
    -- Create the parent directory when writing into a new player folder.
    local parent = full:match('^(.*)[/\\][^/\\]+$')
    if parent and not plat.dir_exists(parent) then
        plat.create_dir(parent)
    end
    local f, err = io.open(full, 'wb')
    if not f then return nil, tostring(err) end
    f:write(content)
    f:close()
    return { ok = true, path = rel }
end

----------------------------------------------------------------------
-- On-screen swap UI
----------------------------------------------------------------------

local swapui = nil
do
    local ok, mod = pcall(dofile, join(plat.addon_path, 'swapui.lua'))
    if ok and type(mod) == 'table' then
        swapui = mod
        swapui.setup({
            cfg = settings.swapui,
            save = function() config.save(settings) end,
            data_dir = gearswap_data_dir,
            player = function()
                local ok2, p = pcall(plat.ffxi.get_player)
                if ok2 then return p end
                return nil
            end,
            jobs = res.jobs,
            log = log,
            log_err = log_err,
        })
    else
        log_err('swapui.lua failed to load: ' .. tostring(mod))
    end
end

----------------------------------------------------------------------
-- HTTP server
----------------------------------------------------------------------

local MIME = {
    html = 'text/html; charset=utf-8',
    js = 'text/javascript; charset=utf-8',
    mjs = 'text/javascript; charset=utf-8',
    css = 'text/css; charset=utf-8',
    json = 'application/json; charset=utf-8',
    svg = 'image/svg+xml',
    png = 'image/png',
    jpg = 'image/jpeg',
    ico = 'image/x-icon',
    map = 'application/json',
    woff = 'font/woff',
    woff2 = 'font/woff2',
    ttf = 'font/ttf',
    txt = 'text/plain; charset=utf-8',
}

local server = nil
local bound_port = nil
local conns = {}          -- all accepted connections: {sock, buf}
local last_state_json = nil
local last_poll = 0
local pending_state = nil -- cached state table between polls
local heartbeat_at = 0
local last_job_id = nil   -- job the swap list was last scanned for
local zoning = false      -- between zone-out (0x00B) and zone-in (0x00A) packets

local CORS = 'Access-Control-Allow-Origin: *\r\n'
    .. 'Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n'
    .. 'Access-Control-Allow-Headers: Content-Type\r\n'

local function status_line(code)
    local names = {
        [200] = 'OK', [204] = 'No Content', [400] = 'Bad Request',
        [404] = 'Not Found', [405] = 'Method Not Allowed',
        [500] = 'Internal Server Error',
    }
    return 'HTTP/1.1 ' .. code .. ' ' .. (names[code] or 'Status')
end

-- Non-blocking send can write partially; loop until the buffer drains.
local function send_all(sock, data)
    local i = 1
    local tries = 0
    while i <= #data do
        local sent, err, last = sock:send(data, i)
        if sent then
            if sent < i then
                -- No forward progress: don't spin the prerender loop forever.
                tries = tries + 1
                if tries > 2000 then return false end
            end
            i = sent + 1
        elseif last and last >= i then
            i = last + 1
        else
            if err == 'closed' then return false end
            tries = tries + 1
            if tries > 2000 then return false end
        end
    end
    return true
end

local function send_and_close(conn, code, body, ctype, no_cache)
    body = body or ''
    local resp = status_line(code) .. '\r\n'
        .. 'Content-Type: ' .. (ctype or 'text/plain; charset=utf-8') .. '\r\n'
        .. 'Content-Length: ' .. #body .. '\r\n'
        .. (no_cache and 'Cache-Control: no-cache\r\n' or '')
        .. CORS
        .. 'Connection: close\r\n\r\n'
        .. body
    pcall(send_all, conn.sock, resp)
    conn.closed = true
    pcall(function() conn.sock:close() end)
end

local function send_json(conn, code, tbl)
    send_and_close(conn, code, json.encode(tbl), 'application/json; charset=utf-8')
end

local function current_state_json()
    if pending_state == nil then
        pending_state = collect_state()
        last_state_json = json.encode(pending_state)
    end
    return last_state_json
end

local function sse_broadcast(event, payload)
    local body = 'event: ' .. event .. '\ndata: ' .. payload .. '\n\n'
    for _, conn in ipairs(conns) do
        if conn.sse and not conn.closed then
            local ok = send_all(conn.sock, body)
            if not ok then
                conn.closed = true
                pcall(function() conn.sock:close() end)
            end
        end
    end
end

local function broadcast_state()
    sse_broadcast('state', current_state_json())
end

----------------------------------------------------------------------
-- Chat: incoming chat packets (0x017) are parsed into a bounded ring
-- buffer streamed to clients over SSE; POST /api/chat sends through
-- `input /<cmd>` — the same path as the game's own chat line.
-- Layout per addons/libs/packets/fields.lua: Mode @0x04, GM @0x05,
-- Sender Name char[0xF] @0x08, Message char* @0x17.
----------------------------------------------------------------------
local chat_seq = 0
-- per-thread buckets keyed like the client's threads (channel key, or
-- 'tell:<peer>' for DMs) so a busy channel can't evict a quiet one's
-- history while the UI is closed
local chat_threads = {}
local chat_focus_windows = 0 -- chat views mounted; spacebar steal gates on >0
local chat_log_dirty = {}     -- thread keys changed → debounced writes
local chat_log_save_at = 0
-- rendered-line dedupe: texts the 0x017 parse pushed in the last ~3s —
-- 'incoming text' skips a packet-mode line only when the packet really
-- delivered it; client-rendered lines at those modes (assist notices,
-- add_to_chat) get captured rather than falling through both paths
local recent_packet_text = {}
local tell_thread_order = {} -- FIFO of tell-peer keys for LRU eviction
-- per-load marker so clients can detect a reload and resync their seq
local chat_boot = math.random(0x7fffffff)
local ls_names = {}
local ls_poll_n = 0

-- mode byte -> channel key (res/chat.lua). Anything outside the named
-- set still lands in 'system' — 0x017 is always chat-log text, so an
-- unmapped mode is better surfaced there than dropped
local CHAT_CHANNELS = {
    [0] = 'say', [1] = 'shout', [3] = 'tell', [4] = 'party',
    [5] = 'linkshell', [6] = 'system', [7] = 'system', [8] = 'emote',
    [12] = 'system', [26] = 'yell', [27] = 'linkshell2', [33] = 'unity',
    [34] = 'assistj', [35] = 'assiste',
}
-- channel -> chat-line command for sending (system/assist are read-only).
-- linkshell3 + the !channels are private-server extras — harmless on
-- retail, only reachable if the server offers them
local CHAT_SEND = {
    say = '/say', shout = '/shout', yell = '/yell', emote = '/emote',
    party = '/party', linkshell = '/linkshell', linkshell2 = '/linkshell2',
    linkshell3 = '/linkshell3', unity = '/unity',
    global = '!global', lfp = '!lfp', market = '!market',
    general = '!general', crafting = '!crafting', help = '!help',
    politics = '!politics',
}
-- private-server custom channels: rendered lines carry a [Tag] prefix
-- ('[Global] Name: msg') — tag -> channel key
local CUSTOM_TAGS = {
    global = 'global', lfp = 'lfp', market = 'market',
    general = 'general', crafting = 'crafting', help = 'help',
    politics = 'politics',
}

local function chat_thread_key(m)
    if m.channel == 'tell' then
        return 'tell:' .. tostring(m.peer or m.sender or '')
    end
    return m.channel
end

local function push_chat(m, quiet)
    chat_seq = chat_seq + 1
    m.seq = chat_seq
    m.boot = chat_boot
    m.ts = m.ts or os.time() -- restored messages keep their original stamp
    local key = chat_thread_key(m)
    local t = chat_threads[key]
    if not t then
        t = {}
        chat_threads[key] = t
        if m.channel == 'tell' then
            tell_thread_order[#tell_thread_order + 1] = key
            -- bound total memory: evict the oldest peer thread entirely
            local max_threads = tonumber(settings.chat_tell_threads) or 64
            if #tell_thread_order > max_threads then
                chat_threads[table.remove(tell_thread_order, 1)] = nil
            end
        end
    end
    t[#t + 1] = m
    if not m.restored then chat_log_dirty[key] = true end
    local max_msgs = tonumber(settings.chat_history) or 200
    if #t > max_msgs then
        table.remove(t, 1)
    end
    if not quiet then
        sse_broadcast('chat', json.encode(m))
    end
end

-- Chat persistence: every thread survives sessions — each writes its
-- own flat row list under data/chat/<char>/<thread>.lua (per-character,
-- per-thread, like data/journal/), capped at CHAT_LOG_MAX lines per
-- file and written debounced from pump() — the dirty set marks which
-- threads changed so quiet threads' files aren't rewritten. Clears map
-- straight to file deletes. Restored messages keep their timestamps
-- and carry restored=true so clients can tell them apart from live
-- traffic (no unread badges on history).
local CHAT_LOG_MAX = 1000
local player_name -- forward-decl: defined below, used by the path helper

local function chat_log_dir()
    return join(join(join(plat.addon_path, 'data'), 'chat'),
                player_name() or 'me')
end

-- thread key -> file: ':' can't sit in a filename, so 'tell:<peer>'
-- writes tell_<peer>.lua; channel names are already path-safe
local function thread_file(key)
    return join(chat_log_dir(), (key:gsub(':', '_')) .. '.lua')
end

-- legacy read-only fallbacks: the global log and the DM-only file
local CHAT_LOG_PATH = join(join(plat.addon_path, 'data'), 'chat_log.lua')
local CHAT_DMS_PATH = join(join(plat.addon_path, 'data'), 'chat_dms.lua')

local function write_chat_log(key)
    local msgs = chat_threads[key]
    if not msgs then return end
    local n = #msgs
    local out = { 'return {' }
    for i = math.max(1, n - CHAT_LOG_MAX + 1), n do
        local m = msgs[i]
        out[#out + 1] = string.format(
            '  {ts=%d,channel=%q,sender=%q,peer=%q,self=%s,text=%q,kind=%q,mode=%d,zone=%q},',
            m.ts or 0, m.channel or '', m.sender or '', m.peer or '',
            m.self and 'true' or 'false', m.text or '',
            m.kind or '', m.mode or 0, m.zone or '')
    end
    out[#out + 1] = '}'
    if plat.create_dir then
        local d = join(plat.addon_path, 'data')
        pcall(plat.create_dir, d)
        pcall(plat.create_dir, join(d, 'chat'))
        pcall(plat.create_dir, chat_log_dir())
    end
    local path = thread_file(key)
    local f = io.open(path, 'w')
    if not f then
        log_err('chat log: cannot write ' .. path)
        return
    end
    f:write(table.concat(out, '\n'))
    f:close()
end

local function remove_chat_logs(key)
    -- '*' = every thread file in the char's dir
    if key == '*' then
        local ok, names = pcall(plat.get_dir, chat_log_dir())
        if ok and type(names) == 'table' then
            for _, name in ipairs(names) do
                if type(name) == 'string' and name:match('%.lua$') then
                    os.remove(join(chat_log_dir(), name))
                end
            end
        end
        chat_log_dirty = {}
        return
    end
    chat_log_dirty[key] = nil
    os.remove(thread_file(key))
end

-- push one persisted row; restores keep original ts and don't badge
local function restore_chat_msg(m, peer_fallback)
    if type(m) ~= 'table' or type(m.text) ~= 'string' then return nil end
    local r = {
        channel = type(m.channel) == 'string' and m.channel ~= ''
            and m.channel or 'system',
        sender = (type(m.sender) == 'string' and m.sender ~= '')
            and m.sender or nil,
        peer = (type(m.peer) == 'string' and m.peer ~= '')
            and m.peer or peer_fallback,
        self = m.self or nil,
        kind = (type(m.kind) == 'string' and m.kind ~= '') and m.kind or nil,
        mode = tonumber(m.mode) or nil,
        zone = (type(m.zone) == 'string' and m.zone ~= '') and m.zone or nil,
        text = m.text,
        ts = tonumber(m.ts) or nil,
        restored = true,
    }
    push_chat(r, true) -- quiet: history loads en masse, one tail broadcast suffices
    return r
end

local function load_chat_log()
    -- per-char per-thread files first; the legacy globals are a
    -- one-time migration source for installs that predate them
    local files = {}
    local okd, names = pcall(plat.get_dir, chat_log_dir())
    if okd and type(names) == 'table' then
        for _, name in ipairs(names) do
            if type(name) == 'string' and name:match('%.lua$') then
                files[#files + 1] = join(chat_log_dir(), name)
            end
        end
    end
    if #files == 0 then
        files = { CHAT_LOG_PATH, CHAT_DMS_PATH }
    end
    local tail
    for _, path in ipairs(files) do
        local ok, t = pcall(dofile, path)
        if ok and type(t) == 'table' then
            if t[1] ~= nil then
                -- flat seq-ordered rows — ipairs keeps recorded order
                for _, m in ipairs(t) do
                    tail = restore_chat_msg(m) or tail
                end
            else
                for key, msgs in pairs(t) do
                    -- legacy chat_dms.lua shape: 'tell:<peer>' -> msgs
                    if type(key) == 'string' and key:sub(1, 5) == 'tell:'
                        and type(msgs) == 'table' then
                        for _, m in ipairs(msgs) do
                            tail = restore_chat_msg(m, key:sub(6)) or tail
                        end
                    end
                end
            end
        end
    end
    -- broadcast the last restored row: a real seq + the fresh boot
    -- marker makes connected windows reset and refetch the full log
    if tail then
        sse_broadcast('chat', json.encode(tail))
    end
end

player_name = function()
    local ok, p = pcall(plat.ffxi.get_player)
    return (ok and type(p) == 'table' and p.name) or 'me'
end

-- auto-translate phrase lookup: res.auto_translates[id] -> {en, ja}.
-- Lazy because resources resolves on first access; false == unavailable.
local auto_translates
-- id -> en name, generated by scripts/extract-autotranslate.py straight
-- from the client's AT DAT — newer than res when phrases were added
-- after the last resources regeneration
local at_names
local res_items, res_key_items

local function at_names_table()
    if at_names == nil then
        local ok, t = pcall(dofile, plat.addon_path .. 'at_names.lua')
        at_names = (ok and type(t) == 'table') and t or false
    end
    return at_names or {}
end

local at_marker_ids -- lazily inverted '@X' marker -> phrase id
local function at_marker(marker)
    if at_marker_ids == nil then
        at_marker_ids = {}
        for id, n in pairs(at_names_table()) do
            if type(n) == 'string' and n:sub(1, 1) == '@' then
                at_marker_ids[n] = id
            end
        end
    end
    local id = at_marker_ids[marker]
    if not id then return nil end
    if auto_translates == nil then
        local ok, t = pcall(function() return res.auto_translates end)
        auto_translates = (ok and type(t) == 'table') and t or false
    end
    local p = auto_translates and auto_translates[id]
    if p then return p.en or p.ja end
    local n = at_names_table()[id]
    return (type(n) == 'string' and n:sub(1, 1) ~= '@') and n or nil
end

local function at_phrase(id)
    local n = at_names_table()[id]
    -- DAT placeholders store '@X' markers as the 'name' — treat them as
    -- unresolved and fall through to res.auto_translates
    if n and n:sub(1, 1) ~= '@' then return n end
    if auto_translates == nil then
        local ok, t = pcall(function() return res.auto_translates end)
        auto_translates = (ok and type(t) == 'table') and t or false
    end
    local p = auto_translates and auto_translates[id]
    return p and (p.en or p.ja)
end

-- FD chat blocks: type byte picks the id's source table; item/key-item
-- ids with a 0x00 byte go over the wire masked as 0xFF (a literal 0x00
-- would corrupt the packet), so 0x09/0x15 unmask the high byte and
-- 0x0A/0x16 the low byte.
local function at_resolve(typ, hi, lo)
    if typ == 0x09 or typ == 0x15 then hi = 0 end
    if typ == 0x0A or typ == 0x16 then lo = 0 end
    local id = hi * 256 + lo
    if typ == 0x02 then
        return at_phrase(id)
    elseif typ == 0x07 or typ == 0x09 or typ == 0x0A then
        if res_items == nil then
            local ok, t = pcall(function() return res.items end)
            res_items = (ok and type(t) == 'table') and t or false
        end
        local it = res_items and res_items[id]
        return it and (it.en or it.enl)
    elseif typ == 0x13 or typ == 0x15 or typ == 0x16 then
        if res_key_items == nil then
            local ok, t = pcall(function() return res.key_items end)
            res_key_items = (ok and type(t) == 'table') and t or false
        end
        local ki = res_key_items and res_key_items[id]
        return ki and (ki.en or ki.enl)
    end
end

-- packet text is fixed-width / auto-translate encoded: byte-walk it
-- instead of gsub so malformed content can never trip strings.lua's
-- pattern machinery; printable ASCII survives, auto-translate blocks
-- (0xFD <type> <lang> <id hi> <id lo> 0xFD — 6 bytes; type selects the
-- id's source: 0x02 phrase, 0x07/09/0A item, 0x13/15/16 key item) decode
-- to their real text, everything else is dropped
local function sanitize_chat(text)
    local out, i, n = {}, 1, #text
    while i <= n do
        local b = text:byte(i)
        if b == 0xFD then
            if i + 5 <= n and text:byte(i + 5) == 0xFD then
                local b1, b2, b3, b4 = text:byte(i + 1, i + 4)
                out[#out + 1] = '{'
                    .. (at_resolve(b1, b3, b4)
                        or ('AT:%02x%02x%02x%02x'):format(b1, b2, b3, b4))
                    .. '}'
                i = i + 6
            else
                -- truncated/malformed run: drop bytes to the next 0xFD/end
                local j = i + 1
                while j <= n do
                    local c = text:byte(j)
                    if c == 0 or c == 0xFD then break end
                    j = j + 1
                end
                out[#out + 1] = '{AT}'
                i = (j <= n and text:byte(j) == 0xFD) and j + 1 or j
            end
        elseif b == 0 then
            break
        elseif b >= 0x20 and b < 0x7F then
            out[#out + 1] = string.char(b)
            i = i + 1
        else
            i = i + 1
        end
    end
    return table.concat(out)
end

-- outbound side of auto-translate: the composer wraps chosen phrases in
-- braces — {Hello!} — the same convention Windower's chat line uses.
-- Names that resolve decode into the real wire bytes the client would
-- produce; anything between braces that doesn't resolve stays literal.
local AT_OPEN = '{'
local AT_CLOSE = '}'

-- name -> {type, id} reverse map, lazy + cached. Phrases win on name
-- collisions, then items, then key items — the same precedence a player
-- picking from the AT menu effectively gets.
local at_id_by_name
local function at_target(name)
    if at_id_by_name == nil then
        local t = {}
        local add = function(tbl, typ, fld)
            for id, p in pairs(tbl) do
                local n = type(p) == 'table' and p[fld]
                    or (fld == 'en' and type(p) == 'string' and p)
                if type(n) == 'string' then
                    local k = n:lower()
                    t[k] = t[k] or { typ, id }
                end
            end
        end
        local ok, at = pcall(function() return res.auto_translates end)
        add(ok and type(at) == 'table' and at or {}, 0x02, 'en')
        add(at_names_table(), 0x02, 'en')
        local ok3, items = pcall(function() return res.items end)
        add(ok3 and type(items) == 'table' and items or {}, 0x07, 'en')
        local ok4, ki = pcall(function() return res.key_items end)
        add(ok4 and type(ki) == 'table' and ki or {}, 0x13, 'en')
        at_id_by_name = t
    end
    return at_id_by_name[name:lower()]
end

-- {type, id} -> FD wire bytes. Item/key-item ids with a 0x00 byte must
-- be masked (see at_resolve); phrase ids containing 0x00 are category
-- headers — un-sendable, so the braces stay literal.
local function at_encode(tgt)
    local typ, id = tgt[1], tgt[2]
    local hi = math.floor(id / 256) % 256
    local lo = id % 256
    if typ == 0x02 then
        if hi == 0 or lo == 0 then return nil end
    else
        if lo == 0 then lo, typ = 0xFF, typ + 3 end -- 07->0A, 13->16
        if hi == 0 then hi, typ = 0xFF, typ + 2 end -- 07->09, 13->15
    end
    return string.char(0xFD, typ, 0x02, hi, lo, 0xFD)
end

-- marked phrases -> wire bytes; also returns a display form with the
-- markers swapped for {Name} (matches what the incoming parser emits)
local function decode_outgoing_chat(text)
    local wire, disp = {}, {}
    local pos = 1
    while true do
        local s = text:find(AT_OPEN, pos, true)
        if not s then
            local rest = text:sub(pos)
            wire[#wire + 1] = rest
            disp[#disp + 1] = rest
            break
        end
        local lead = text:sub(pos, s - 1)
        wire[#wire + 1] = lead
        disp[#disp + 1] = lead
        local e = text:find(AT_CLOSE, s + #AT_OPEN, true)
        if not e then
            -- dangling open brace: leave the text untouched
            local rest = text:sub(s)
            wire[#wire + 1] = rest
            disp[#disp + 1] = rest
            break
        end
        local name = text:sub(s + #AT_OPEN, e - 1)
        local tgt = name ~= '' and at_target(name) or nil
        local enc = tgt and at_encode(tgt)
        if enc then
            wire[#wire + 1] = enc
            disp[#disp + 1] = '{' .. name .. '}'
        else
            -- not a phrase — the braces are literal text
            local lit = '{' .. name .. '}'
            wire[#wire + 1] = lit
            disp[#disp + 1] = lit
        end
        pos = e + #AT_CLOSE
    end
    return table.concat(wire), table.concat(disp)
end

local function read_cstr(data, off, max)
    local z = data:find('\0', off, true)
    local hi = z and z - 1 or #data
    if max and hi > max then hi = max end
    return data:sub(off, hi)
end

-- outgoing channel messages are appended optimistically (like tells) —
-- channels may or may not echo back as 0x017 depending on the command
-- path. pending_self[channel][text] = send time, so a real echo that
-- DOES arrive inside the window is dropped as a duplicate.
local pending_self = {}

-- sender names come out of the same binary packet as message text —
-- keep to a byte walk (no gsub, see sanitize_chat) so junk can't trip
-- the wrapped string library
local function sanitize_name(s)
    local out = {}
    for i = 1, #s do
        local b = s:byte(i)
        if b >= 0x20 and b < 0x7F then out[#out + 1] = string.char(b) end
    end
    return table.concat(out)
end

local function handle_chat_packet(data)
    if type(data) ~= 'string' or #data < 0x17 then return end
    local channel = CHAT_CHANNELS[data:byte(5)]
    -- unknown channel id (private-server extras like a third linkshell):
    -- don't push as 'system' — the rendered log line carries the same
    -- text and classifies it properly (linkshell3, [Tag] channels);
    -- pushing here would mislabel it and dedupe the real one
    if not channel then return end
    local sender = sanitize_name(read_cstr(data, 9, 23)) -- char[0xF], may lack a terminator
    if sender == '' then sender = nil end
    local text = sanitize_chat(read_cstr(data, 24))
    if text == '' then return end
    -- machine hex dumps injected as chat (comma-separated hex runs —
    -- e.g. '0a,00c7,00000004,...' showing under unity) aren't
    -- conversation; drop them at the packet edge
    if text:match('^%x+,%x+,%x+') then return end
    local m = { channel = channel, sender = sender, text = text,
                mode = data:byte(5) }
    if channel == 'yell' and #data >= 8 then
        -- Zone u16 @0x06 is only meaningful on yells — resolve it so
        -- the row can show where the shouter is
        local zid = data:byte(7) + data:byte(8) * 256
        local okz, zn = pcall(function()
            local z = res.zones[zid]
            return z and z.en or nil
        end)
        if okz and zn then m.zone = zn end
    end
    if sender == player_name() then
        -- our own send coming back (typed in-game or UI echo): style it
        -- as self, and if it matches a message we already appended
        -- optimistically, eat the duplicate
        m.self = true
        local pend = pending_self[channel]
        local t = pend and pend[text]
        if t and os.time() - t < 10 then
            pend[text] = nil
            return
        end
    end
    if channel == 'tell' then m.peer = sender end
    -- linkshell senders build the LS-member roster the target window
    -- uses for name coloring (no LS roster API exists)
    if sender and (channel == 'linkshell' or channel == 'linkshell2')
        and party then
        pcall(party.ls_seen, sender)
    end
    push_chat(m)
    recent_packet_text[text] = os.time()
end

plat.on('incoming chunk', function(id, data)
    if id ~= 0x017 then return end
    -- never let a malformed packet kill the routing path — log and move on
    local ok, err = pcall(handle_chat_packet, data)
    if not ok then log_err('chat: ' .. tostring(err)) end
end)

-- 'incoming text' — the client's rendered log-line stream: packet chat,
-- combat text, system lines, and every addon/plugin add_to_chat all
-- funnel through here (with the client's filters already applied). The
-- 0x017 packet parse stays for the social channels — sender metadata
-- powers grouping and tell threads — so lines at a packet-covered
-- display mode are skipped; the rest classify into 'battle' (combat
-- colors), 'system' (basic system color), or 'echo'.
local PACKET_TEXT_MODES = {
    -- res/chat.lua incoming ∪ outgoing columns — rendered packet chat
    [1]=true,[2]=true,[3]=true,[4]=true,[5]=true,[6]=true,[7]=true,
    [9]=true,[10]=true,[11]=true,[12]=true,[13]=true,[14]=true,[15]=true,
    [200]=true,[211]=true,[212]=true,[213]=true,[214]=true,
    [219]=true,[220]=true,[221]=true,[222]=true,
}

-- combat colors: the Font-Colors battle ids (self/other hurt/heal/
-- evade/buff/resist + calls-for-help + standard battle) plus every
-- numeric action_messages color — rendered 0x029 text is combat too
local BATTLE_MODES = {
    [8]=true,[20]=true,[21]=true,[22]=true,[28]=true,[29]=true,[30]=true,
    [50]=true,[56]=true,[57]=true,[59]=true,[60]=true,[61]=true,[63]=true,
}
do
    local ok, am = pcall(function() return res.action_messages end)
    if ok and type(am) == 'table' then
        for _, m in pairs(am) do
            if type(m) == 'table' and type(m.color) == 'number' then
                BATTLE_MODES[m.color] = true
            end
        end
    end
end
BATTLE_MODES[121] = nil -- basic-system color routes to 'system', not battle
local SYSTEM_TEXT_MODE = 121

-- display-mode → channel: a rendered line at a packet-chat color that
-- did NOT come from a 0x017 packet (NPC dialog rendered at unity's
-- color, addon output mimicking a channel) still belongs to the channel
-- its mode says it is — the map is built from res/chat.lua's
-- incoming/outgoing columns so it tracks the client's mode table
local DISPLAY_CHANNEL = {}
do
    local NAME_TO_CHANNEL = {
        say = 'say', shout = 'shout', tell = 'tell', party = 'party',
        linkshell = 'linkshell', linkshell2 = 'linkshell2',
        emote = 'emote', yell = 'yell', unity = 'unity',
        assistj = 'assist', assiste = 'assist',
        ['system message'] = 'system',
    }
    local ok, chat = pcall(function() return res.chat end)
    if ok and type(chat) == 'table' then
        for _, e in pairs(chat) do
            local ch = type(e) == 'table' and NAME_TO_CHANNEL[e.en] or nil
            if ch then
                for _, col in ipairs({ 'incoming', 'outgoing' }) do
                    local m = tonumber(e[col])
                    if m then DISPLAY_CHANNEL[m] = ch end
                end
            end
        end
    end
end
-- informational text modes (readable.lua's set + NPC conversations
-- 142): game-rendered announcements — conquest results, signet/besieged
-- notices, NPC dialog — are 'system', not 'echo'
for _, m in ipairs({ 121, 142, 148, 150, 151, 152, 190, 210 }) do
    DISPLAY_CHANNEL[m] = 'system'
end
-- third linkshell: res.chat stops at two, so the render mode is
-- hardcoded (LS2 renders at 214)
DISPLAY_CHANNEL[215] = 'linkshell3'

-- rendered log lines carry FFXI color controls (0x1E/0x1F + param byte);
-- strip those, then run the same byte-walker as packet text (decodes FD
-- auto-translate runs, drops the rest of the control range)
local function sanitize_log_text(text)
    local out, i, n = {}, 1, #text
    while i <= n do
        local b = text:byte(i)
        if b == 0x1E or b == 0x1F or b == 0x01 then
            i = i + 2
        else
            out[#out + 1] = string.char(b)
            i = i + 1
        end
    end
    return sanitize_chat(table.concat(out))
end

local OWN_CHAT_PREFIX = '[xicompanion]'

-- normalize for dedupe: trim edges + canonicalize auto-translate
-- markers — the packet path decodes FD..FD into names ({box}) while a
-- rendered line may keep raw ids ({AT} / {AT:xxxx}) or drop a trailing
-- marker entirely, so neither is byte-identical to the other
local function atnorm(x)
    x = (x or ''):gsub('%s+$', ''):gsub('^%s+', '')
    return (x:gsub('{[^}]*}', '{AT}'))
end

local function packet_recent(text)
    -- rendered lines prepend sender metadata the packet doesn't carry
    -- ('Fczjsgdl[BastokMine]: msg' vs 'msg') and can truncate the tail —
    -- compare in BOTH directions after normalization, plus the
    -- post-prefix tail as a fallback (senderless re-renders)
    local now = os.time()
    local tail = text:match('^%S+%[%S*%]: (.+)$') -- 'Sender[Zone]: tail'
        or text:match('^%S+: (.+)$')            -- 'Sender: tail'
    local a = atnorm(text)
    local b = tail and atnorm(tail) or nil
    for ptext, t in pairs(recent_packet_text) do
        if now - t > 10 then
            recent_packet_text[ptext] = nil
        else
            local p = atnorm(ptext)
            if a == p
                or (#a >= #p and a:sub(-#p) == p)
                or (#p >= #a and p:sub(-#a) == a)
                or (b and (b == p
                    or (#b >= #p and b:sub(-#p) == p)
                    or (#p >= #b and p:sub(-#b) == b))) then
                return true
            end
        end
    end
    return false
end

-- forward-declared so the text handler below can feed party's
-- /check+TH parser; assigned when the module loads further down
local party = nil

plat.on('incoming text', function(original, modified, original_mode, modified_mode, blocked)
    if blocked then return end -- another addon hid the line — it's invisible
    local mode = modified_mode or original_mode or 0
    local text = sanitize_log_text(modified or original or '')
    if text == '' then return end
    -- /check replies + TH procs feed party's target tracking — parse
    -- before the packet-dedupe below could skip the line
    if party then
        local okp, e = pcall(party.log_line, text)
        if not okp then log_err('party logline: ' .. tostring(e)) end
    end
    -- client-rendered unknown ATs show as {@id} markers — at_names.lua
    -- maps id -> marker (the DAT's own placeholder, e.g. [5297]='@A25'),
    -- so invert it and resolve the real name via res.auto_translates
    if text:find('{@') then
        text = text:gsub('%{(@[%w]+)%}', function(h)
            local n = at_marker(h)
            return n and ('{' .. n .. '}') or ('{' .. h .. '}')
        end)
    end
    -- packet-mode lines are only skipped when the 0x017 handler actually
    -- pushed this text — otherwise it's a client-rendered line (assist
    -- notice, add_to_chat at a shared mode) and it's ours to capture
    if PACKET_TEXT_MODES[mode] and packet_recent(text) then return end
    -- same packet-edge filter for machine hex dumps rendered as lines
    if text:match('^%x+,%x+,%x+') then return end
    local own = text:sub(1, #OWN_CHAT_PREFIX) == OWN_CHAT_PREFIX
    -- private-server custom channels render '[Tag] Name: msg' — the tag
    -- outranks the color-mode guess since it's the channel's own marker
    local tagch, tagrest = text:match('^%[([%a]+)%]%s*(.*)$')
    tagch = tagch and CUSTOM_TAGS[tagch:lower()] or nil
    local channel
    if own then
        channel = 'echo' -- our own log() lines — surface, don't drop
    elseif tagch then
        channel = tagch
    elseif DISPLAY_CHANNEL[mode] then
        channel = DISPLAY_CHANNEL[mode]
    elseif BATTLE_MODES[mode] then
        channel = 'battle'
    else
        channel = 'echo'
    end
    local m = { channel = channel, text = text, self = own or nil,
                mode = mode }
    if tagch then
        -- '[Tag] Speaker: body' — grab the speaker for grouping
        local sp = tagrest and tagrest:match('^([^:]+):%s*') or nil
        if sp and sp ~= '' then m.sender = sp end
    end
    -- learn notices flag for the ★ badge — mode 81/91 colors are shared
    -- with unrelated lines, so it's a text match not a mode check
    if text:lower():find('learn', 1, true) then
        m.kind = 'learn'
    end
    push_chat(m)
end)

----------------------------------------------------------------------
-- Journal: quest/mission log (0x056) + RoE objectives (0x111/0x112),
-- parsed by journal.lua into per-character state under data/journal/.
----------------------------------------------------------------------
local journal = nil
do
    local ok, mod = pcall(dofile, join(plat.addon_path, 'journal.lua'))
    if ok and type(mod) == 'table' then
        journal = mod
        journal.setup({
            join = join,
            json = json,
            json_array = json_array,
            sse_broadcast = sse_broadcast,
            data_dir = join(plat.addon_path, 'data'),
            addon_path = plat.addon_path,
            player_name = player_name,
            log = log,
            log_err = log_err,
        })
    else
        log_err('journal.lua failed to load: ' .. tostring(mod))
    end
end

-- forward-declared so the packet handlers below close over it; the
-- module itself loads later (after logged_in exists) in the recasts do.
-- `party` itself is declared above the 'incoming text' handler.
local map = nil

plat.on('incoming chunk', function(id, data, modified, injected, blocked)
    if injected or blocked or not journal then return end
    if id == 0x056 or id == 0x111 or id == 0x112 then
        -- same rule as chat: a bad packet must never kill the pump
        local ok, err = pcall(journal.handle_packet, id, data)
        if not ok then log_err('journal: ' .. tostring(err)) end
    end
end)

-- widescan traffic: 0x0F4 entries, 0x0F5 track updates, 0x0F6 scan marks;
-- 0x017 chat feeds the linkshell-member roster (LS channel senders)
plat.on('incoming chunk', function(id, data, modified, injected, blocked)
    if injected or blocked or not map then return end
    if id == 0x0F4 or id == 0x0F5 or id == 0x0F6 or id == 0x017 then
        local ok, err = pcall(map.handle_incoming, id, data)
        if not ok then log_err('map: ' .. tostring(err)) end
    end
end)

-- outgoing 0x0F5 records which widescan target the player tracks
plat.on('outgoing chunk', function(id, data, modified, injected, blocked)
    if injected or blocked then
        -- GearSwap fires injected 0x01As for /ma — they're still OUR
        -- casts; only the arm needs to see them
        if party and id == 0x01A then
            local ok3, err3 = pcall(party.handle_outgoing, id, data)
            if not ok3 then log_err('party-out: ' .. tostring(err3)) end
        end
        return
    end
    if map and id == 0x0F5 then
        local ok, err = pcall(map.handle_outgoing, id, data)
        if not ok then log_err('map-out: ' .. tostring(err)) end
    end
    if party and id == 0x01A then
        local ok2, err2 = pcall(party.handle_outgoing, id, data)
        if not ok2 then log_err('party-out: ' .. tostring(err2)) end
    end
end)

-- party buffs (0x076), action packets (0x028) for the cast bar, and
-- entity updates (0x00D/0x00E) that teach the wire-id → index map
plat.on('incoming chunk', function(id, data, modified, injected, blocked)
    if injected or blocked or not party then return end
    if id == 0x076 or id == 0x028 or id == 0x00E or id == 0x00D then
        local ok, err = pcall(party.handle_incoming, id, data)
        if not ok then log_err('party: ' .. tostring(err)) end
    end
end)

local function serve_static(conn, url_path)
    local path = url_path:gsub('^/+', '')
    if path == '' then path = 'index.html' end
    path = path:gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end)
    if path:find('%.%.') then
        return send_and_close(conn, 400, 'bad path')
    end
    local full = join(ui_dir, path)
    local f = io.open(full, 'rb')
    if not f then
        -- SPA fallback: extensionless paths get index.html
        if not path:match('%.[%w]+$') then
            f = io.open(join(ui_dir, 'index.html'), 'rb')
            path = 'index.html'
        end
        if not f then
            return send_and_close(conn, 404,
                'not found - is the UI built? expected files in ' .. ui_dir)
        end
    end
    local body = f:read('*a')
    f:close()
    local ext = path:match('%.([%w]+)$')
    -- hashed assets can cache hard; index.html and friends must revalidate or
    -- a stale cached shell pins the browser to an old bundle after a rebuild
    local no_cache = ext == nil or ext:lower() == 'html'
    send_and_close(
        conn,
        200,
        body,
        MIME[ext and ext:lower()] or 'application/octet-stream',
        no_cache
    )
end

-- Hidden from the overlay's perspective: in the zoning blackout or an
-- event/cutscene (player status 4) — the same states in-render addons
-- stop drawing for. The overlay polls this via /api/status.
local function overlay_hidden()
    if zoning then return true end
    local ok, player = pcall(plat.ffxi.get_player)
    return ok and type(player) == 'table' and player.status == 4
end

local routes = {}

-- detached-window spawn queue: the overlay drains it via /api/spawn
-- on its status poll. Routes open as panels; '!show' surfaces the
-- fab/uncollapses. Enqueuing beats launching the exe per panel — every
-- launch blipped a taskbar entry (login = fab + up to 7 panels).
local spawn_queue = {}
local last_spawn_drain = 0

routes['GET /api/spawn'] = function(conn)
    last_spawn_drain = os.time()
    local q = spawn_queue
    spawn_queue = {}
    send_json(conn, 200, { routes = q })
end

routes['GET /api/status'] = function(conn)
    send_json(conn, 200, {
        addon = _addon.name,
        version = _addon.version,
        port = bound_port or settings.port,
        hidden = overlay_hidden(),
        -- per-load marker: a reload replaces it, so the overlay
        -- treats a changed boot as a restart and quits itself
        boot = chat_boot,
        sse_clients = (function()
            local n = 0
            for _, c in ipairs(conns) do if c.sse and not c.closed then n = n + 1 end end
            return n
        end)(),
        gearswap_dir = gearswap_data_dir(),
    })
end

routes['GET /api/state'] = function(conn)
    send_and_close(conn, 200, current_state_json(), 'application/json; charset=utf-8')
end

routes['GET /api/gearswap/files'] = function(conn)
    send_json(conn, 200, list_gearswap_files())
end

routes['GET /api/gearswap/file'] = function(conn, req)
    local rel = req.query.path
    local out, err = read_gearswap_file(rel)
    if not out then
        return send_json(conn, 404, { error = err })
    end
    send_json(conn, 200, out)
end

routes['PUT /api/gearswap/file'] = function(conn, req)
    local out, err = write_gearswap_file(req.query.path, req.body)
    if not out then
        return send_json(conn, 400, { error = err })
    end
    send_json(conn, 200, out)
end

routes['POST /api/gearswap/file'] = routes['PUT /api/gearswap/file']

routes['POST /api/gearswap/reload'] = function(conn)
    plat.send_command('gs reload')
    send_json(conn, 200, { ok = true })
end

-- Run a windower command on behalf of the UI (`//gs equip`, etc.)
-- Pull a top-level string field out of a JSON body by hand: the bundled
-- json table is encode-only, and Lua patterns can't quantify captures so
-- "(escape|char)*" style matchers silently fail. Scan the string literal
-- directly, honoring backslash escapes.
local function json_string(body, key)
    local _, e = body:find('"' .. key .. '"%s*:%s*"')
    if not e then return nil end
    local i, out = e + 1, {}
    while i <= #body do
        local c = body:sub(i, i)
        if c == '"' then
            return table.concat(out)
        elseif c == '\\' then
            local n = body:sub(i + 1, i + 1)
            if n == 'n' then out[#out + 1] = '\n'
            elseif n == 't' then out[#out + 1] = '\t'
            elseif n == 'r' then out[#out + 1] = '\r'
            elseif n == 'u' then i = i + 4 -- \uXXXX: commands are ASCII, skip
            else out[#out + 1] = n end
            i = i + 2
        else
            out[#out + 1] = c
            i = i + 1
        end
    end
    return nil -- unterminated string
end

routes['POST /api/command'] = function(conn, req)
    local cmd = json_string(req.body or '', 'cmd')
    if type(cmd) ~= 'string' or cmd == '' then
        return send_json(conn, 400, { error = 'missing cmd' })
    end
    plat.send_command(cmd)
    send_json(conn, 200, { ok = true })
end

-- Item actions that need native calls/packet injection rather than a
-- windower command (equip/use go through POST /api/command instead).
-- body: {"action":"drop","bag":0,"index":<slot>,"count":<n>}
--       {"action":"move","bag":<id>,"index":<slot>,"count":<n>,"target":<bag id>}
--       {"action":"unequip","slot":"<windower slot name>"}

-- items.equipment keys (and the cmd-style aliases the UI reports via
-- equip_slot: 'l.ear' etc.) -> numeric equip slot for the 0x050 chunk
local UNEQUIP_SLOT = {
    main = 0, sub = 1, range = 2, ammo = 3,
    head = 4, body = 5, hands = 6, legs = 7, feet = 8,
    neck = 9, waist = 10,
    lear = 11, ['l.ear'] = 11, left_ear = 11,
    rear = 12, ['r.ear'] = 12, right_ear = 12,
    lring = 13, ['l.ring'] = 13, left_ring = 13,
    rring = 14, ['r.ring'] = 14, right_ring = 14,
    back = 15,
}

routes['POST /api/item'] = function(conn, req)
    local body = req.body or ''
    local action = body:match('"action"%s*:%s*"([^"]+)"')
    local function num(k) return tonumber((body:match('"' .. k .. '"%s*:%s*(%d+)'))) end
    local bag, index = num('bag'), num('index')
    local count, target = num('count') or 1, num('target')
    if action == 'drop' then
        if bag ~= 0 or index == nil then
            return send_json(conn, 400, { error = 'drop needs inventory bag + index' })
        end
        local ok, err = pcall(plat.ffxi.drop_item, index, count)
        if not ok then
            return send_json(conn, 500, { error = tostring(err) })
        end
        return send_json(conn, 200, { ok = true })
    elseif action == 'move' then
        if not (bag and index and target) then
            return send_json(conn, 400, { error = 'move needs bag/index/target' })
        end
        local ok_p, packets = pcall(require, 'packets')
        if not ok_p or type(packets) ~= 'table' then
            return send_json(conn, 500, { error = 'packets lib unavailable' })
        end
        -- 0x029 move item; target index 0x52 = "any free slot" in the dest bag
        packets.inject(packets.new('outgoing', 0x029, {
            ['Count'] = count,
            ['Bag'] = bag,
            ['Target Bag'] = target,
            ['Current Index'] = index,
            ['Target Index'] = 0x52,
        }))
        return send_json(conn, 200, { ok = true })
    elseif action == 'unequip' then
        -- There is no /unequip client command: unequipping is an equip
        -- packet (0x050) with Item Index 0 — the same chunk GearSwap
        -- emits when a slot should be emptied.
        local slot = body:match('"slot"%s*:%s*"([^"]+)"')
        local slot_id = slot and UNEQUIP_SLOT[slot]
        if not slot_id then
            return send_json(conn, 400, { error = 'unequip needs a valid slot name' })
        end
        local ok_p, packets = pcall(require, 'packets')
        if not ok_p or type(packets) ~= 'table' then
            return send_json(conn, 500, { error = 'packets lib unavailable' })
        end
        packets.inject(packets.new('outgoing', 0x050, {
            ['Item Index'] = 0,
            ['Equip Slot'] = slot_id,
            ['Bag'] = 0,
        }))
        return send_json(conn, 200, { ok = true })
    end
    send_json(conn, 400, { error = 'unknown action' })
end

----------------------------------------------------------------------
-- FFXI macro files (<ffxi>/USER/<content id>/mcr*.dat + mcr*.ttl)
-- The client only guarantees reading these at login; while a character is
-- logged in it may rewrite them from memory, so PUT responses carry a
-- `logged_in` flag the UI turns into a warning.
----------------------------------------------------------------------

local function logged_in()
    local ok, info = pcall(plat.ffxi.get_info)
    return ok and type(info) == 'table' and info.logged_in == true
end

-- Recasts: ability/spell cooldown timers, polled each pump and pushed
-- over SSE to the tracker window's Cooldowns section.
local recasts = nil
do
    local ok, mod = pcall(dofile, join(plat.addon_path, 'recasts.lua'))
    if ok and type(mod) == 'table' then
        recasts = mod
        recasts.setup({
            json = json,
            json_array = json_array,
            sse_broadcast = sse_broadcast,
            logged_in = logged_in,
            res = res,
        })
    else
        log_err('recasts.lua failed to load: ' .. tostring(mod))
    end
end

-- Map: player position + nearby entities + widescan for the /map page
-- and the detached /minimap window. `map` was forward-declared above the
-- packet handlers — this assigns it.
do
    local ok, mod = pcall(dofile, join(plat.addon_path, 'map.lua'))
    if ok and type(mod) == 'table' then
        map = mod
        map.setup({
            json = json,
            json_array = json_array,
            sse_broadcast = sse_broadcast,
            logged_in = logged_in,
            res = res,
            join = join,
            data_dir = join(plat.addon_path, 'data'),
            player_name = player_name,
        })
    else
        log_err('map.lua failed to load: ' .. tostring(mod))
    end
end

-- Party: member vitals/buffs + target + casting tracker for the /party
-- and /target detached windows. `party` was forward-declared above the
-- packet handlers — this assigns it.
do
    local ok, mod = pcall(dofile, join(plat.addon_path, 'party.lua'))
    if ok and type(mod) == 'table' then
        party = mod
        party.setup({
            json = json,
            json_array = json_array,
            sse_broadcast = sse_broadcast,
            logged_in = logged_in,
            res = res,
            join = join,
            data_dir = join(plat.addon_path, 'data'),
            autocheck = function() return settings.target_check end,
        })
    else
        log_err('party.lua failed to load: ' .. tostring(mod))
    end
end

-- Ability/spell book for the /abilities page — obtainable-vs-learned
-- lists for the current job plus the command lines to trigger them.
local abilities = nil
do
    local ok, mod = pcall(dofile, join(plat.addon_path, 'abilities.lua'))
    if ok and type(mod) == 'table' then
        abilities = mod
        abilities.setup({
            res = res,
            json_array = json_array,
        })
    else
        log_err('abilities.lua failed to load: ' .. tostring(mod))
    end
end

-- Map image DATs: zone+map -> client DAT bytes (browser decodes them).
local mapimg
do
    local ok, mod = pcall(dofile, join(plat.addon_path, 'mapimg.lua'))
    if ok and type(mod) == 'table' then
        mapimg = mod
        mapimg.setup()
    else
        log_err('mapimg.lua failed to load: ' .. tostring(mod))
    end
end

local function macro_char_dir(char_id)
    if type(char_id) ~= 'string' or not char_id:match('^[%w]+$')
        or type(plat.ffxi_path) ~= 'string' then
        return nil
    end
    local dir = join(join(plat.ffxi_path, 'USER'), char_id)
    return plat.dir_exists(dir) and dir or nil
end

-- Active-palette + macro-content tracking. mcr.sys holds the client's
-- active palette index and is rewritten on every in-game book/page
-- switch — the authoritative sel source (the newest-written mcr*.dat
-- only names the page just left). Any stamp move on mcr* — client
-- writes, our PUT writes, external edits — pings views to refetch
-- ('macros'). macro_watch holds the last-seen stamp per file so each
-- poll diffs rather than re-stating.
local macro_sel = {}
local macro_watch = {}
local memscan_hits

local function poll_macro_sel()
    if not logged_in() or not plat.file_mtimes or not macrofs then return end
    for _, d in ipairs(macrofs.find_char_dirs(plat.ffxi_path)) do
        -- mcr.sys mirrors the client's live palette index; when the
        -- memory dll is present, the in-memory copy is the same read
        -- without disk latency (mem_index returns nil until a verified
        -- signature exists — file stays authoritative)
        local idx = (macrofs.mem_index and plat.memory)
            and macrofs.mem_index(d.path)
            or macrofs.read_sys_index(d.path)
        if idx then
            local v = {
                b = math.floor(idx / 10) + 1,
                p = idx % 10 + 1,
            }
            local was = macro_sel[d.id]
            if not was or was.b ~= v.b or was.p ~= v.p then
                macro_sel[d.id] = v
                sse_broadcast('macrosel', json.encode(macro_sel))
            end
        end
        local cur = plat.file_mtimes(d.path, 'mcr*')
        if cur then
            local prev = macro_watch[d.id]
            macro_watch[d.id] = cur
            if prev then
                for fname, stamp in pairs(cur) do
                    if prev[fname] ~= stamp then
                        sse_broadcast('macros', '{}')
                        break
                    end
                end
            end
        end
    end
end

routes['GET /api/macrosel'] = function(conn)
    send_json(conn, 200, macro_sel)
end

routes['GET /api/macros'] = function(conn)
    if not macrofs then
        return send_json(conn, 500, { error = 'macros module unavailable' })
    end
    local chars = {}
    for _, d in ipairs(macrofs.find_char_dirs(plat.ffxi_path)) do
        local pals = macrofs.read_palettes(d.path)
        for _, p in ipairs(pals) do
            for _, m in ipairs(p.macros) do
                m.lines = json_array(m.lines)
            end
            p.macros = json_array(p.macros)
        end
        chars[#chars + 1] = {
            id = d.id,
            titles = json_array(macrofs.read_titles(d.path)),
            palettes = json_array(pals),
        }
    end
    send_json(conn, 200, {
        logged_in = logged_in(),
        characters = json_array(chars),
    })
end

-- Delay between client macro-book switches. PR #1892: loading a book twice
-- in rapid succession can corrupt + wipe its files — pace commands at the
-- client's own minimum delay.
local MACRO_SWITCH_DELAY = 1.5
local macro_schedule = coroutine.schedule or function(f) f() end
local macro_sel_n = 0

-- body: {"char":"<content id>","index":<0-399>,
--        "macros":[{"name":"x","lines":["/a",...x6]}, ... x20]}
-- ?apply=1 (and logged in): force the client to re-read the book by
-- switching away before writing, then switching back — the file lands
-- while the book is unloaded so the stale in-memory copy can't clobber it.
routes['PUT /api/macros/palette'] = function(conn, req)
    if not macrofs then
        return send_json(conn, 500, { error = 'macros module unavailable' })
    end
    local body = macrofs.json_decode(req.body or '')
    if type(body) ~= 'table' then
        return send_json(conn, 400, { error = 'invalid json' })
    end
    local dir = macro_char_dir(body.char)
    local index = tonumber(body.index)
    if not dir then
        return send_json(conn, 400, { error = 'unknown character' })
    end
    if not index or index < 0 or index >= 400 or index % 1 ~= 0 then
        return send_json(conn, 400, { error = 'bad palette index' })
    end
    if type(body.macros) ~= 'table' or #body.macros > 20 then
        return send_json(conn, 400, { error = 'macros must be an array of up to 20' })
    end

    local apply = (req.query.apply == '1' or req.query.apply == 'true')
        and logged_in()
    -- book switches via ffxi.run — the client's command parser, no
    -- input-line involvement (an `input` firing while the user has the
    -- chat line open is what wedged the input modal)
    local function macro_cmd(cmd)
        if plat.ffxi.run then
            pcall(plat.ffxi.run, cmd)
        else
            plat.send_command('input ' .. cmd)
        end
    end
    -- self-heal: probe the client's menu state after the apply chain —
    -- a wedged chat-input line reports as an open chat/input menu;
    -- dismiss it like a physical Esc (sendkey injects at the client
    -- input level, past whatever ate the real keypress)
    local function unstick_input()
        if not plat.ffxi.get_menu then return end
        local ok, m = pcall(plat.ffxi.get_menu)
        if not ok or not m then return end
        local name = tostring(type(m) == 'table' and (m.name or m[1]) or m)
        if name:lower():find('chat') or name:lower():find('input') then
            plat.send_command('sendkey escape')
            log_err('macro apply: cleared stuck input (' .. name .. ')')
        end
    end
    if apply then
        -- Validate + build the image now so errors stay synchronous; the
        -- bytes land in a scheduled step between book switches.
        local image, path = macrofs.palette_image(dir, index, body.macros)
        if not image then
            return send_json(conn, 400, { error = tostring(path) })
        end
        local book = math.floor(index / 10) + 1
        local page = index % 10 + 1
        local other = book == 1 and 2 or 1
        macro_cmd(('/macro book %d'):format(other))
        macro_schedule(function()
            macrofs.commit_image(path, image)
            sse_broadcast('macros', '{}')
            macro_schedule(function()
                macro_cmd(('/macro book %d'):format(book))
                macro_schedule(function()
                    macro_cmd(('/macro set %d'):format(page))
                macro_schedule(unstick_input, MACRO_SWITCH_DELAY)
                end, MACRO_SWITCH_DELAY)
            end, MACRO_SWITCH_DELAY)
        end, MACRO_SWITCH_DELAY)
        return send_json(conn, 200, {
            ok = true,
            applied = true,
            file = macrofs.palette_file(index),
            book = book,
            palette = page,
            logged_in = true,
        })
    end

    local ok, err = macrofs.write_palette(dir, index, body.macros)
    if not ok then
        return send_json(conn, 400, { error = tostring(err) })
    end
    sse_broadcast('macros', '{}')
    send_json(conn, 200, {
        ok = true,
        file = macrofs.palette_file(index),
        logged_in = logged_in(),
    })
end

-- body: {"char":"<content id>","book":<1-40>,"title":"RDM"}
routes['PUT /api/macros/title'] = function(conn, req)
    if not macrofs then
        return send_json(conn, 500, { error = 'macros module unavailable' })
    end
    local body = macrofs.json_decode(req.body or '')
    if type(body) ~= 'table' then
        return send_json(conn, 400, { error = 'invalid json' })
    end
    local dir = macro_char_dir(body.char)
    local book = tonumber(body.book)
    if not dir then
        return send_json(conn, 400, { error = 'unknown character' })
    end
    if not book or book < 1 or book > 40 or book % 1 ~= 0 then
        return send_json(conn, 400, { error = 'book must be 1-40' })
    end
    if type(body.title) ~= 'string' then
        return send_json(conn, 400, { error = 'missing title' })
    end
    local ok, err = macrofs.write_title(dir, book, body.title)
    if not ok then
        return send_json(conn, 400, { error = tostring(err) })
    end
    sse_broadcast('macros', '{}')
    send_json(conn, 200, { ok = true, logged_in = logged_in() })
end

-- Replay one macro cell the way the client's macro executor does: every
-- line goes through the client's own input line (`input`), and /wait N
-- lines pause the rest of the sequence through the scheduler instead of
-- being sent as commands.
local function run_macro_lines(lines, i)
    while i <= #lines do
        local l = lines[i]
        i = i + 1
        if l ~= '' then
            local wait = l:match('^/[Ww][Aa][Ii][Tt]%s+([%d%.]+)')
                or (l:match('^/[Ww][Aa][Ii][Tt]%s*$') and '1')
            if wait then
                macro_schedule(function() run_macro_lines(lines, i) end,
                    tonumber(wait) or 1)
                return
            end
            plat.send_command('input ' .. l)
        end
    end
end

-- body: {"char":"<content id>","index":<0-399>,"cell":<0-19>}
routes['POST /api/macros/run'] = function(conn, req)
    if not macrofs then
        return send_json(conn, 500, { error = 'macros module unavailable' })
    end
    local body = macrofs.json_decode(req.body or '')
    if type(body) ~= 'table' then
        return send_json(conn, 400, { error = 'invalid json' })
    end
    local dir = macro_char_dir(body.char)
    local index = tonumber(body.index)
    local cell = tonumber(body.cell)
    if not dir then
        return send_json(conn, 400, { error = 'unknown character' })
    end
    if not index or index < 0 or index >= 400 or index % 1 ~= 0
        or not cell or cell < 0 or cell > 19 or cell % 1 ~= 0 then
        return send_json(conn, 400, { error = 'bad palette index/cell' })
    end
    local pal
    for _, p in ipairs(macrofs.read_palettes(dir)) do
        if p.index == index then pal = p break end
    end
    local m = pal and pal.macros and pal.macros[cell + 1]
    if not m then
        return send_json(conn, 404, { error = 'palette not found' })
    end
    -- lines travel as the text form ([AT:xxxxxxxx], \xNN); `input` needs
    -- the client's raw bytes back so FD sequences land as real phrases
    local lines = {}
    for _, l in ipairs(m.lines or {}) do
        if l and l ~= '' then
            lines[#lines + 1] = macrofs.text_to_bytes(l, 60) or l
        end
    end
    if #lines == 0 then
        return send_json(conn, 400, { error = 'macro is empty' })
    end
    run_macro_lines(lines, 1)
    send_json(conn, 200, { ok = true, logged_in = logged_in() })
end

-- Item icons + status icons share the extract-then-serve pipeline:
-- cached .bmp under data/<subdir>/, decoded from the DAT on first
-- request. *_by_id() coroutine.yield()s mid-write, so we drive it.
local function serve_icon(conn, req, subdir, fn_name)
    local id = tonumber(req.query.id)
    if not id or id <= 0 then
        return send_json(conn, 400, { error = 'bad id' })
    end
    local dir = join(join(plat.addon_path, 'data'), subdir)
    local path = dir .. '\\' .. tostring(id) .. '.bmp'
    if not plat.file_exists(path) then
        -- dofile by path, not require — 'icon_extractor' also exists in
        -- other addons (equipviewer) and require may resolve theirs,
        -- which lacks the alpha fixup
        local ok_x, icon_extractor = pcall(
            dofile, plat.addon_path .. 'icon_extractor.lua')
        if ok_x and icon_extractor and icon_extractor[fn_name] then
            if not plat.dir_exists(dir) then
                pcall(plat.create_dir, dir)
            end
            local co = coroutine.create(function()
                icon_extractor[fn_name](id, path)
            end)
            local ok, err = true, nil
            repeat
                ok, err = coroutine.resume(co)
            until coroutine.status(co) == 'dead' or not ok
            if not ok then
                return send_json(conn, 500, { error = tostring(err) })
            end
        end
    end
    if not plat.file_exists(path) then
        return send_json(conn, 404, { error = 'no icon' })
    end
    local f = io.open(path, 'rb')
    if not f then return send_json(conn, 404, { error = 'no icon' }) end
    local bmp = f:read('*a')
    f:close()
    send_and_close(conn, 200, bmp, 'image/bmp')
end

routes['GET /api/icon'] = function(conn, req)
    serve_icon(conn, req, 'icons', 'item_by_id')
end


-- menu spell/JA icons — pre-extracted from ROM/280/15.DAT + 324/95.DAT
-- into data/menuicons/<idx>.bmp by scripts/extract-menuicons.py;
-- menu_icon_names.lua maps index → "group/name" (e.g. "white/cure").
routes['GET /api/menuicon'] = function(conn, req)
    -- ws=<tile> serves one 32x32 tile out of the misc/ws weapon sheet;
    -- id=<n> a whole menuicon chunk (≥330 = tile in a spabi sheet).
    -- Decoded lazily from ROM/280/15 + 324/95 by menu_extractor and
    -- cached under data/menuicons/ — no pre-extracted assets ship.
    local ws = req.query.ws
    local id = tonumber(req.query.id)
    if not ws and not id then
        return send_json(conn, 400, { error = 'bad id' })
    end
    local dir = join(join(plat.addon_path, 'data'), 'menuicons')
    local path = dir .. '\\' .. (ws and ('ws_' .. ws) or id) .. '.bmp'
    if not plat.file_exists(path) then
        local ok_x, menu_extractor = pcall(require, 'menu_extractor')
        if ok_x and menu_extractor then
            local ok, err = pcall(function()
                return ws and menu_extractor.ws(ws, path)
                    or menu_extractor.by_id(id, path)
            end)
            if not ok then
                return send_json(conn, 500, { error = tostring(err) })
            end
            if not err then
                return send_json(conn, 404, { error = 'no icon' })
            end
        end
    end
    if not plat.file_exists(path) then
        return send_json(conn, 404, { error = 'no icon' })
    end
    local f = io.open(path, 'rb')
    if not f then return send_json(conn, 404, { error = 'no icon' }) end
    local bmp = f:read('*a')
    f:close()
    send_and_close(conn, 200, bmp, 'image/bmp')
end

-- FFXI window-skin textures — PNGs extracted by scripts/extract-winskin.py
-- into themes/<dat>/<nn>_<name>.png (client menu DAT chrome pieces).
routes['GET /api/theme'] = function(conn, req)
    local f = req.query.f
    -- path must stay inside themes/ — reject traversal outright
    if not f or f:find('%.%.') or not f:match('^[%w_%-%/]+%.png$') then
        return send_json(conn, 400, { error = 'bad path' })
    end
    local path = join(plat.addon_path, 'themes') .. '\\' .. f:gsub('/', '\\')
    local fh = io.open(path, 'rb')
    if not fh then return send_json(conn, 404, { error = 'no theme file' }) end
    local png = fh:read('*a')
    fh:close()
    send_and_close(conn, 200, png, 'image/png')
end

-- Foreign-UI obstacle rects (ImagineXI's autolayout idea): other
-- addons' saved window positions + retail chat/menu zones, so the
-- settings page can place our windows where they don't overlap.
-- ?w=&h= is the caller's screen size (the addon can't see the display).
local obstacles_mod
routes['GET /api/layout'] = function(conn, req)
    if obstacles_mod == nil then
        local ok, m = pcall(dofile, join(plat.addon_path, 'obstacles.lua'))
        obstacles_mod = (ok and type(m) == 'table') and m or false
    end
    if not obstacles_mod then
        return send_json(conn, 500, { error = 'obstacles.lua failed to load' })
    end
    local obs = obstacles_mod.scan({
        windower_path = plat.windower_path,
        player_name = player_name(),
        screen_w = tonumber(req.query.w) or 1920,
        screen_h = tonumber(req.query.h) or 1080,
    })
    send_json(conn, 200, { obstacles = json_array(obs) })
end

-- status-effect icons (buffs/debuffs) — ROM/119/57.DAT via buff_by_id.
-- Ids ≥640 live in the second store (ROM/324/95: Trust faces, SP
-- abilities, mounts, emotes) — pre-extracted by name under
-- data/statusicons2/ with statusicons2_map.lua as the id→name map.
local statusicons2_map
routes['GET /api/statusicon'] = function(conn, req)
    local id = tonumber(req.query.id)
    if id and id >= 640 then
        if statusicons2_map == nil then
            local ok, t = pcall(dofile, plat.addon_path .. 'statusicons2_map.lua')
            statusicons2_map = (ok and type(t) == 'table') and t or {}
        end
        local name = statusicons2_map[id]
        if name then
            local p = join(join(plat.addon_path, 'data'), 'statusicons2')
                .. '\\' .. name .. '.bmp'
            if plat.file_exists(p) then
                local f = io.open(p, 'rb')
                if f then
                    local bmp = f:read('*a')
                    f:close()
                    return send_and_close(conn, 200, bmp, 'image/bmp')
                end
            end
        end
        return send_json(conn, 404, { error = 'no icon' })
    end
    serve_icon(conn, req, 'statusicons', 'buff_by_id')
end

-- full item meta + the client's blue-text description (stats/passives
-- live there — res.items has no damage/defense/stat fields). Lazy per-id
-- endpoint: descriptions are static and ~300B each, so they stay out of
-- the catalog that every state broadcast re-sends.
routes['GET /api/itemmeta'] = function(conn, req)
    local id = tonumber(req.query.id)
    local meta = id and item_meta(id)
    if not meta then
        return send_json(conn, 404, { error = 'unknown item' })
    end
    local d = res.item_descriptions and res.item_descriptions[id]
    if d and d.en then
        meta.description = d.en
    end
    send_json(conn, 200, meta)
end

routes['GET /api/events'] = function(conn)
    conn.sse = true
    local head = status_line(200) .. '\r\n'
        .. 'Content-Type: text/event-stream\r\n'
        .. 'Cache-Control: no-cache\r\n'
        .. CORS
        .. 'Connection: keep-alive\r\n\r\n'
    local ok = send_all(conn.sock, head)
    if not ok then
        conn.closed = true
        return
    end
    -- Send an immediate snapshot so the UI renders without waiting for a diff.
    send_all(conn.sock, 'event: state\ndata: ' .. current_state_json() .. '\n\n')
    if journal then
        send_all(conn.sock, 'event: journal\ndata: ' .. journal.snapshot_json() .. '\n\n')
    end
    if recasts then
        send_all(conn.sock, 'event: recasts\ndata: ' .. recasts.snapshot_json() .. '\n\n')
    end
    if map then
        send_all(conn.sock, 'event: map\ndata: ' .. map.snapshot_json() .. '\n\n')
    end
    if party then
        send_all(conn.sock, 'event: party\ndata: ' .. party.snapshot_json() .. '\n\n')
    end
    send_all(conn.sock, 'event: macrosel\ndata: ' .. json.encode(macro_sel) .. '\n\n')
end

-- Chat history: ?after=<seq> returns newer messages across all threads
-- (each keeps its own tail); ?after=0 is the initial/reconnect fetch.
routes['GET /api/journal'] = function(conn)
    if not journal then
        return send_json(conn, 200, { char = nil })
    end
    send_and_close(conn, 200, journal.snapshot_json(), 'application/json; charset=utf-8')
end

-- force a journal rebroadcast: the tracker pokes this on mount so a
-- diff-gated flush that fired while its SSE link was down gets re-sent
routes['POST /api/journal/refresh'] = function(conn)
    if journal then
        sse_broadcast('journal', journal.snapshot_json())
        return send_and_close(conn, 200, journal.snapshot_json(), 'application/json; charset=utf-8')
    end
    send_json(conn, 200, { char = nil })
end

-- Recast timers for the detached cooldowns window — snapshot for new
-- clients; live updates ride the `recasts` SSE event.
routes['GET /api/recasts'] = function(conn)
    local body = recasts and recasts.snapshot_json() or '{"list":[]}'
    send_and_close(conn, 200, body, 'application/json; charset=utf-8')
end

-- Map state for the /map page + /minimap window — snapshot for new
-- clients; live updates ride the `map` SSE event.
routes['GET /api/map'] = function(conn)
    local body = map and map.snapshot_json() or '{"on":0}'
    send_and_close(conn, 200, body, 'application/json; charset=utf-8')
end

-- Party vitals + target/cast for the /party + /target windows — snapshot
-- for new clients; live updates ride the `party` SSE event.
routes['GET /api/party'] = function(conn)
    local body = party and party.snapshot_json() or '{"on":0}'
    send_and_close(conn, 200, body, 'application/json; charset=utf-8')
end

-- cast-tracker diagnostics: action packets the handler has seen +
-- the current cast — for chasing "mob cast bar never shows"
routes['GET /api/party/dbg'] = function(conn)
    local body = party and party.dbg_json() or '{"ac":0}'
    send_and_close(conn, 200, body, 'application/json; charset=utf-8')
end

-- Skill/spell book for /abilities — recomputed per call (job changes
-- invalidate everything anyway); a logged-out/nil read reports {on:0}.
routes['GET /api/abilities'] = function(conn)
    if not abilities or not logged_in() then
        return send_and_close(conn, 200, '{"on":0}',
            'application/json; charset=utf-8')
    end
    local ok, list = pcall(abilities.read)
    if not ok or not list then
        return send_and_close(conn, 200, '{"on":0}',
            'application/json; charset=utf-8')
    end
    send_and_close(conn, 200, json.encode(list),
        'application/json; charset=utf-8')
end

-- Zone map image. User-dropped PNGs take precedence: data/maps/
-- <zone>_<map>.png (or <zone>.png for single-map zones) — the remapster
-- FFXIDB packs use this convention. Otherwise the client's own map DAT is
-- served as application/x-ffxi-map and the browser decodes the DXT/bitmap
-- payload. 404 = radar-only fallback.
routes['GET /api/map/img'] = function(conn, req)
    local z = tonumber(req and req.query and req.query.z or '') or 0
    local m = tonumber(req and req.query and req.query.m or '') or 0
    local dir = join(plat.addon_path, 'data', 'maps')
    local tries = {
        join(dir, string.format('%d_%d.png', z, m)),
        join(dir, string.format('%d.png', z)),
    }
    for _, path in ipairs(tries) do
        local f = io.open(path, 'rb')
        if f then
            local body = f:read('*a')
            f:close()
            return send_and_close(conn, 200, body, 'image/png')
        end
    end
    if mapimg then
        local ok_d, dat = pcall(mapimg.dat_bytes, z, m)
        if ok_d and dat then
            return send_and_close(conn, 200, dat, 'application/x-ffxi-map')
        end
    end
    send_and_close(conn, 404, 'no map image')
end

-- Ask the server for a widescan refresh — injects the same 0x0F4 request
-- the map menu's Widescan option sends (Flags=1).
routes['POST /api/map/scan'] = function(conn)
    local ok_p, packets = pcall(require, 'packets')
    if not ok_p or type(packets) ~= 'table' then
        return send_json(conn, 500, { error = 'packets lib unavailable' })
    end
    packets.inject(packets.new('outgoing', 0x0F4, { ['Flags'] = 1 }))
    send_json(conn, 200, { ok = true })
end

routes['GET /api/journal/names'] = function(conn)
    if not journal then
        return send_json(conn, 200, {})
    end
    send_and_close(conn, 200, journal.names_json(), 'application/json; charset=utf-8')
end

-- Mark/unmark an RoE objective: injects the same outgoing packets the
-- client sends from the RoE menu (0x10C set, 0x10D cancel). The server
-- answers with a fresh 0x111, which the journal tracker picks up, so no
-- local state needs to change here.
-- body: {"id":<objective id>,"action":"set|clear"}
routes['POST /api/journal/roe'] = function(conn, req)
    local body = req.body or ''
    local action = body:match('"action"%s*:%s*"([^"]+)"')
    local id = tonumber((body:match('"id"%s*:%s*(%d+)')))
    if not id or id > 0xFFF or (action ~= 'set' and action ~= 'clear') then
        return send_json(conn, 400, { error = 'needs {"id":<n>,"action":"set|clear"}' })
    end
    if not logged_in() then
        return send_json(conn, 400, { error = 'not logged in' })
    end
    local ok_p, packets = pcall(require, 'packets')
    if not ok_p or type(packets) ~= 'table' then
        return send_json(conn, 500, { error = 'packets lib unavailable' })
    end
    packets.inject(packets.new('outgoing', action == 'set' and 0x10C or 0x10D, {
        ['RoE Quest'] = id,
    }))
    send_json(conn, 200, { ok = true })
end

-- Toggle an entry's visibility in the detached tracker window. Entries
-- are tracked by default; untracked keys persist in the journal file and
-- reach the tracker through the normal journal SSE broadcast.
-- body: {"kind":"quest|mission|roe","key":"<group>","tracked":<bool>,
--        "id":<n>} — omit id to toggle the whole group
routes['POST /api/journal/track'] = function(conn, req)
    if not journal then
        return send_json(conn, 503, { error = 'journal unavailable' })
    end
    local body = req.body or ''
    local kind = body:match('"kind"%s*:%s*"([^"]+)"')
    local key = body:match('"key"%s*:%s*"([^"]+)"')
    local id = tonumber((body:match('"id"%s*:%s*(%d+)')))
    local tflag = body:match('"tracked"%s*:%s*(%a+)')
    if not kind or not key or not tflag then
        return send_json(conn, 400, { error = 'needs {"kind","key","tracked"} (id optional)' })
    end
    local ok, err = journal.set_tracked(kind, key, id, tflag == 'true')
    if not ok then
        return send_json(conn, 400, { error = err or 'rejected' })
    end
    send_json(conn, 200, { ok = true })
end

-- Addon settings (data/settings.xml via the config lib) — flat scalar
-- keys only; swapui stays command-managed. `port` takes effect on the
-- next server start.
local SETTABLE = {
    port = 'number', autostart = 'boolean',
    fab = 'boolean', tracker = 'boolean', macrobar = 'boolean',
    cooldowns = 'boolean', skillchain = 'boolean',
    minimap = 'boolean', party = 'boolean', target = 'boolean',
    poll_interval = 'number',
    chat_history = 'number', chat_tell_threads = 'number',
}
routes['GET /api/settings'] = function(conn)
    local out = {}
    for key in pairs(SETTABLE) do out[key] = settings[key] end
    send_json(conn, 200, out)
end
routes['POST /api/settings'] = function(conn, req)
    local body = req.body or ''
    local changed = {}
    for key, kind in pairs(SETTABLE) do
        if kind == 'boolean' then
            local v = body:match('"' .. key .. '"%s*:%s*(%a+)')
            if v == 'true' or v == 'false' then
                settings[key] = (v == 'true')
                changed[#changed + 1] = key
            end
        elseif kind == 'string' then
            local v = body:match('"' .. key .. '"%s*:%s*"([^"]*)"')
            if v then
                settings[key] = v
                changed[#changed + 1] = key
            end
        else
            local v = tonumber((body:match('"' .. key .. '"%s*:%s*(-?[%d%.]+)')))
            if v then
                settings[key] = v
                changed[#changed + 1] = key
            end
        end
    end
    config.save(settings)
    send_json(conn, 200, { ok = true, changed = json_array(changed) })
end

routes['GET /api/chat'] = function(conn, req)
    local after = tonumber(req.query.after) or 0
    local out = {}
    for _, t in pairs(chat_threads) do
        for _, m in ipairs(t) do
            if (m.seq or 0) > after then out[#out + 1] = m end
        end
    end
    table.sort(out, function(a, b) return (a.seq or 0) < (b.seq or 0) end)
    send_json(conn, 200, { seq = chat_seq, boot = chat_boot, messages = json_array(out) })
end

-- auto-translate phrase list for the composer's Tab autocomplete
local phrases_json
routes['GET /api/chat/phrases'] = function(conn)
    if not phrases_json then
        local names, seen = {}, {}
        local ok, at = pcall(function() return res.auto_translates end)
        for _, p in pairs(ok and type(at) == 'table' and at or {}) do
            if type(p) == 'table' and type(p.en) == 'string' and not seen[p.en] then
                seen[p.en] = true
                names[#names + 1] = p.en
            end
        end
        for _, name in pairs(at_names_table()) do
            if not seen[name] then
                seen[name] = true
                names[#names + 1] = name
            end
        end
        table.sort(names)
        phrases_json = json.encode({ phrases = json_array(names) })
    end
    send_and_close(conn, 200, phrases_json, 'application/json; charset=utf-8')
end

-- Send chat as if typed into the game's chat line.
-- body: {"channel":"party","text":"hi"} or
--       {"channel":"tell","to":"Name","text":"hi"}
-- marker-wrapped auto-translate phrases decode to wire FD bytes
routes['POST /api/chat'] = function(conn, req)
    local channel = json_string(req.body or '', 'channel')
    local text = json_string(req.body or '', 'text')
    if not text or text == '' then
        return send_json(conn, 400, { error = 'missing text' })
    end
    local wire, display = decode_outgoing_chat(text)
    if channel == 'tell' then
        local to = json_string(req.body or '', 'to')
        if not to or to == '' then
            return send_json(conn, 400, { error = 'tell requires to' })
        end
        plat.send_command('input /tell ' .. to .. ' ' .. wire)
        -- sent tells don't echo back as packets — record the local half
        -- of the DM so the thread shows both sides
        push_chat({ channel = 'tell', peer = to, sender = player_name(), self = true, text = display })
        return send_json(conn, 200, { ok = true })
    end
    local cmd = CHAT_SEND[channel]
    if not cmd then
        return send_json(conn, 400, { error = 'cannot send to ' .. tostring(channel) })
    end
    plat.send_command('input ' .. cmd .. ' ' .. wire)
    -- the outgoing half may never come back as a packet — append it like
    -- the tell path. pending_self guards against a real echo doubling it
    local pend = pending_self[channel] or {}
    pending_self[channel] = pend
    pend[display] = os.time()
    push_chat({ channel = channel, sender = player_name(), self = true, text = display })
    send_json(conn, 200, { ok = true })
end

-- Clear chat history: {thread} is a channel key, 'tell:<peer>', or '*'
-- for everything. Drops the bucket(s) (tell threads leave the order
-- list too) and deletes the matching per-thread file(s) under
-- data/chat/<char>/, then broadcasts a real-seqd control row so every
-- connected window clears the same thread — the seq bump keeps it out
-- of client dedupe.
routes['POST /api/chat/clear'] = function(conn, req)
    local body = json_decode(req.body or '')
    local key = type(body) == 'table' and body.thread or nil
    if type(key) ~= 'string' or key == '' then
        return send_json(conn, 400, { error = 'missing thread' })
    end
    if key == '*' then
        chat_threads = {}
        tell_thread_order = {}
    elseif chat_threads[key] ~= nil then
        chat_threads[key] = nil
        for i, k in ipairs(tell_thread_order) do
            if k == key then
                table.remove(tell_thread_order, i)
                break
            end
        end
    end
    remove_chat_logs(key)
    chat_seq = chat_seq + 1
    sse_broadcast('chat', json.encode({ cleared = key, seq = chat_seq, boot = chat_boot }))
    send_json(conn, 200, { ok = true })
end

-- Player-defined filter channels: a named set of source channels the UI
-- merges into one view. Pure metadata — messages keep their real
-- channel; membership is resolved client-side.
local CUSTOM_CHANNELS_VALID = {
    say = true, shout = true, yell = true, emote = true, party = true,
    linkshell = true, linkshell2 = true, linkshell3 = true, unity = true,
    tell = true, battle = true, system = true, echo = true,
    assistj = true, assiste = true,
    global = true, lfp = true, market = true, general = true,
    crafting = true, help = true, politics = true,
}

routes['GET /api/chat/channels'] = function(conn)
    local out = {}
    for _, c in ipairs(settings.chat_custom_channels or {}) do
        if type(c) == 'table' and type(c.name) == 'string' then
            out[#out + 1] = {
                name = c.name,
                channels = json_array(type(c.channels) == 'table' and c.channels or {}),
            }
        end
    end
    send_json(conn, 200, { channels = json_array(out) })
end

routes['PUT /api/chat/channels'] = function(conn, req)
    local body = json_decode(req.body or '')
    local list = type(body) == 'table' and (body.channels or body) or nil
    if type(list) ~= 'table' then
        return send_json(conn, 400, { error = 'expected {channels:[{name,channels[]}]}' })
    end
    local out, seen = {}, {}
    for _, c in ipairs(list) do
        if type(c) == 'table' and type(c.name) == 'string' and c.name ~= ''
            and not seen[c.name] and #out < 32 then
            local chans, cseen = {}, {}
            if type(c.channels) == 'table' then
                for _, ch in ipairs(c.channels) do
                    if type(ch) == 'string' and CUSTOM_CHANNELS_VALID[ch] and not cseen[ch] then
                        cseen[ch] = true
                        chans[#chans + 1] = ch
                    end
                end
            end
            if #chans > 0 then
                seen[c.name] = true
                out[#out + 1] = { name = c.name:sub(1, 24), channels = chans }
            end
        end
    end
    settings.chat_custom_channels = out
    config.save(settings)
    send_json(conn, 200, { ok = true, channels = json_array(out) })
end

-- a mounted chat view registers/deregisters here — the spacebar steal
-- only intercepts while at least one chat window is actually open
routes['POST /api/chatfocus'] = function(conn, req)
    local open = (req.body or ''):match('"open"%s*:%s*(%a+)')
    if open ~= 'true' and open ~= 'false' then
        return send_json(conn, 400, { error = 'missing open' })
    end
    chat_focus_windows = math.max(0, chat_focus_windows + (open == 'true' and 1 or -1))
    send_json(conn, 200, { ok = true, count = chat_focus_windows })
end

local function parse_request(conn)
    local buf = conn.buf
    local head_end = buf:find('\r\n\r\n', 1, true)
    if not head_end then
        -- Header cap: bail on garbage.
        if #buf > 16384 then
            send_and_close(conn, 400, 'headers too large')
        end
        return nil
    end
    local head = buf:sub(1, head_end - 1)
    local method, target = head:match('^(%S+)%s+(%S+)')
    if not method then
        send_and_close(conn, 400, 'bad request')
        return true
    end
    local headers = {}
    for line in head:gmatch('[^\r\n]+') do
        local k, v = line:match('^([%w%-]+):%s*(.+)$')
        if k then headers[k:lower()] = v end
    end
    local clen = tonumber(headers['content-length']) or 0
    local body_start = head_end + 4
    if #buf - (body_start - 1) < clen then
        return nil -- wait for the rest of the body
    end
    local body = buf:sub(body_start, body_start + clen - 1)

    local path, qs = target:match('^([^?]*)%??(.*)$')
    local query = {}
    for pair in (qs or ''):gmatch('[^&]+') do
        local k, v = pair:match('^([^=]+)=?(.*)$')
        if k then
            v = v:gsub('+', ' '):gsub('%%(%x%x)', function(h) return string.char(tonumber(h, 16)) end)
            query[k] = v
        end
    end

    return {
        method = method,
        path = path,
        query = query,
        headers = headers,
        body = body,
    }
end

local function handle_request(conn, req)
    if req.method == 'OPTIONS' then
        return send_and_close(conn, 204, '')
    end
    if conn.sse then return end -- already streaming

    local handler = routes[req.method .. ' ' .. req.path]
    if handler then
        local ok, err = pcall(handler, conn, req)
        if not ok then
            log_err('handler error: ' .. tostring(err))
            if not conn.closed then
                send_json(conn, 500, { error = 'internal error' })
            end
        end
        return
    end

    if req.method == 'GET' then
        return serve_static(conn, req.path)
    end
    send_and_close(conn, 405, 'method not allowed')
end

local function service_sockets()
    if not server then return end

    -- Accept pending connections.
    while true do
        local client = server:accept()
        if not client then break end
        client:settimeout(0)
        client:setoption('tcp-nodelay', true)
        conns[#conns + 1] = { sock = client, buf = '' }
    end

    -- Pump each connection.
    for _, conn in ipairs(conns) do
        if not conn.closed and not conn.sse then
            local data, err, partial = conn.sock:receive(4096)
            local chunk = data or partial
            if chunk and #chunk > 0 then
                conn.buf = conn.buf .. chunk
            end
            if err == 'closed' then
                conn.closed = true
                pcall(function() conn.sock:close() end)
            else
                local req = parse_request(conn)
                if req then
                    handle_request(conn, req)
                    conn.buf = ''
                end
            end
        end
    end

    -- Prune dead connections.
    for i = #conns, 1, -1 do
        if conns[i].closed then
            table.remove(conns, i)
        end
    end
end

----------------------------------------------------------------------
-- Server lifecycle + polling
----------------------------------------------------------------------

local function start_server()
    if server then return true end
    local base_port = tonumber(settings.port) or 17890
    for offset = 0, 9 do
        local s, err = socket.bind('127.0.0.1', base_port + offset)
        if s then
            s:settimeout(0)
            server = s
            bound_port = base_port + offset
            if bound_port ~= base_port then
                log('port ' .. base_port .. ' busy, using ' .. bound_port .. ' instead')
            end
            log('listening on http://127.0.0.1:' .. bound_port ..
                ' - run //xicompanion open to launch the UI')
            return true
        end
    end
    log_err('could not bind a port near ' .. base_port)
    return false
end

local function stop_server()
    if server then
        pcall(function() server:close() end)
        server = nil
    end
    bound_port = nil
    for _, conn in ipairs(conns) do
        pcall(function() conn.sock:close() end)
    end
    conns = {}
    log('server stopped')
end

local function poll_state()
    local now = os.clock()
    if now - last_poll < (tonumber(settings.poll_interval) or 1.5) then
        return
    end
    last_poll = now
    local ok, state = pcall(collect_state)
    if not ok then
        return
    end
    pending_state = state
    -- GearSwap reloads the user file on job change; rescan the set list.
    if swapui and state.player then
        local jid = state.player.main_job_id
        if last_job_id ~= nil and jid ~= last_job_id then
            pcall(swapui.rescan)
            -- recast ids are reused across jobs — stale observed maxes
            -- would skew the cooldown bars
            if recasts then pcall(recasts.reset) end
        end
        last_job_id = jid
    end
    local encoded = json.encode(state)
    if encoded ~= last_state_json then
        last_state_json = encoded
        broadcast_state()
    end
end

-- Heartbeat keeps EventSource connections alive through proxies and
-- doubles as the client's liveness signal: it's a named `ping` event
-- because EventSource swallows comment lines, so a bare ': ...' beat
-- would keep the socket warm but tell the page nothing.
local function heartbeat()
    local now = os.time()
    if now - heartbeat_at < 25 then return end
    heartbeat_at = now
    for _, conn in ipairs(conns) do
        if conn.sse and not conn.closed then
            local ok = send_all(conn.sock, 'event: ping\ndata: {}\n\n')
            if not ok then
                conn.closed = true
                pcall(function() conn.sock:close() end)
            end
        end
    end
end

local function pump()
    if not server then return end
    local ok, err = pcall(service_sockets)
    if not ok then
        log_err('socket error: ' .. tostring(err))
    end
    local ok2, err2 = pcall(poll_state)
    if not ok2 then
        log_err('poll error: ' .. tostring(err2))
    end
    if journal then
        local ok3, err3 = pcall(journal.flush)
        if not ok3 then
            log_err('journal flush: ' .. tostring(err3))
        end
    end
    if os.time() >= chat_log_save_at and next(chat_log_dirty) then
        local dirty = chat_log_dirty
        chat_log_dirty = {}
        chat_log_save_at = os.time() + 3
        for key in pairs(dirty) do
            pcall(write_chat_log, key)
        end
    end
    if recasts then
        local ok4, err4 = pcall(recasts.poll)
        if not ok4 then
            log_err('recasts poll: ' .. tostring(err4))
        end
    end
    if map then
        local ok5, err5 = pcall(map.poll)
        if not ok5 then
            log_err('map poll: ' .. tostring(err5))
        end
    end
    if party then
        local ok6, err6 = pcall(party.poll)
        if not ok6 then
            log_err('party poll: ' .. tostring(err6))
        end
    end
    if macrofs then
        macro_sel_n = macro_sel_n + 1
        if macro_sel_n % 30 == 0 then -- ~2Hz: the file is 28 bytes
            local ok7, err7 = pcall(poll_macro_sel)
            if not ok7 then
                log_err('macrosel poll: ' .. tostring(err7))
            end
        end
    end
    -- linkpearl names: equipped pearls change on equip/zone — poll
    -- ~every 2s of pump ticks and broadcast so the chat sidebar can
    -- label ls1/ls2/ls3 with the real linkshell names
    ls_poll_n = ls_poll_n + 1
    if logged_in() and ls_poll_n % 60 == 0 then
        local okp, p = pcall(plat.ffxi.get_player)
        if okp and type(p) == 'table' then
            local l1, l2, l3 = p.linkshell, p.linkshell2, p.linkshell3
            if l1 ~= ls_names[1] or l2 ~= ls_names[2] or l3 ~= ls_names[3] then
                ls_names = { l1, l2, l3 }
                sse_broadcast('chat', json.encode({
                    linkshells = { ls_names[1], ls_names[2], ls_names[3] },
                    boot = chat_boot,
                }))
            end
        end
    end
    heartbeat()
end

-- prerender is a DirectX hook: when the overlay fully occludes the game
-- (or it's minimized) presents can stop, which would starve the socket
-- pump entirely. time change (~0.6s ticks) and incoming chunks are driven
-- by the game loop, so they keep the server alive regardless of rendering.
plat.on('prerender', pump)
plat.on('time change', pump)
plat.on('incoming chunk', pump)

-- opt-in hotkey → chat focus: when chat_space_focus is set and a chat
-- window is open, eat the configured combo before the client sees it
-- and push 'chatfocus' — the UI raises our window + composer.
-- default shift+space — plain space still opens the native chat line.
-- hotkey key-steal removed: the addon must never block key
-- input — only a focused input field may claim keys. The
-- chatfocus SSE plumbing stays but nothing broadcasts it.

-- spawn the overlay shell. fab=true launches the collapsed floating
-- button (bundled exe only — no Electron fallback, it's too heavy to
-- auto-spawn). Returns true if something was launched.
local function launch_overlay(fab, extra)
    local spawned = false
    for route in (extra or ''):gmatch('%-%-spawn[=%s]+(%S+)') do
        spawn_queue[#spawn_queue + 1] = route
        spawned = true
    end
    if not spawned then
        spawn_queue[#spawn_queue + 1] = '!show'
    end
    -- overlay alive ⇒ it drains the queue within ~2s — no launch
    -- needed (every exe start flashed a taskbar entry)
    if os.time() - last_spawn_drain < 6 then
        return true
    end
    local exe = plat.addon_path .. 'overlay\\xicompanion-overlay.exe'
    if plat.file_exists(exe) then
        local params = fab and '--fab' or ''
        -- plat.spawn is console-free (ShellExecuteW); os.execute's
        -- cmd /c fallback flashes a console that steals game focus
        if not plat.spawn(exe, params) then
            os.execute('start "" "' .. exe .. '" ' .. params)
        end
        return true
    end
    if fab then return false end
    -- dev build: Electron via the repo sibling (needs node + npm i);
    -- launch.mjs scrubs ELECTRON_RUN_AS_NODE from the inherited env
    local script = plat.addon_path ..
        '..\\..\\gearswapui\\overlay\\launch.mjs'
    if plat.file_exists(script) then
        if not plat.spawn('node.exe', '"' .. script .. '"', true) then
            os.execute('start "" node "' .. script .. '"')
        end
        return true
    end
    log_err('no overlay found (expected ' .. exe .. ')')
    return false
end

plat.on('addon command', function(cmd, ...)
    cmd = (cmd or ''):lower()
    local args = { ... }

    if cmd == '' or cmd == 'help' then
        log('commands: open | overlay | fab | tracker | macrobar | cooldowns | minimap | party | target | skillchain | start | stop | status | port <n> | refresh | swap | equip <set> | memscan [idx]')
    elseif cmd == 'open' then
        if server or start_server() then
            plat.open_url('http://127.0.0.1:' .. bound_port .. '/')
        end
    elseif cmd == 'overlay' then
        if not (server or start_server()) then return end
        if launch_overlay(false) then
            log('overlay launched')
        end
    elseif cmd == 'fab' then
        local sub = (args[1] or ''):lower()
        if sub == 'on' or sub == 'off' then
            settings.fab = (sub == 'on')
            config.save(settings)
            log('auto-fab ' .. (settings.fab and 'enabled' or 'disabled'))
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true) then
            log('fab launched')
        end
    elseif cmd == 'tracker' then
        local sub = (args[1] or ''):lower()
        if sub == 'on' or sub == 'off' then
            settings.tracker = (sub == 'on')
            config.save(settings)
            log('auto-tracker ' .. (settings.tracker and 'enabled' or 'disabled'))
            if settings.tracker and server and logged_in() then
                launch_overlay(true, '--spawn /tracker')
            end
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true, '--spawn /tracker') then
            log('tracker launched')
        else
            log_err('no overlay found (build with npm run build:overlay)')
        end
    elseif cmd == 'macrobar' then
        local sub = (args[1] or ''):lower()
        if sub == 'on' or sub == 'off' then
            settings.macrobar = (sub == 'on')
            config.save(settings)
            log('auto-macrobar ' .. (settings.macrobar and 'enabled' or 'disabled'))
            if settings.macrobar and server and logged_in() then
                launch_overlay(true, '--spawn /macrobar')
            end
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true, '--spawn /macrobar') then
            log('macro bar launched')
        else
            log_err('no overlay found (build with npm run build:overlay)')
        end
    elseif cmd == 'cooldowns' then
        local sub = (args[1] or ''):lower()
        if sub == 'on' or sub == 'off' then
            settings.cooldowns = (sub == 'on')
            config.save(settings)
            log('auto-cooldowns ' .. (settings.cooldowns and 'enabled' or 'disabled'))
            if settings.cooldowns and server and logged_in() then
                launch_overlay(true, '--spawn /cooldowns')
            end
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true, '--spawn /cooldowns') then
            log('cooldowns launched')
        else
            log_err('no overlay found (build with npm run build:overlay)')
        end
    elseif cmd == 'minimap' then
        local sub = (args[1] or ''):lower()
        if sub == 'on' or sub == 'off' then
            settings.minimap = (sub == 'on')
            config.save(settings)
            log('auto-minimap ' .. (settings.minimap and 'enabled' or 'disabled'))
            if settings.minimap and server and logged_in() then
                launch_overlay(true, '--spawn /minimap')
            end
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true, '--spawn /minimap') then
            log('minimap launched')
        else
            log_err('no overlay found (build with npm run build:overlay)')
        end
    elseif cmd == 'party' then
        local sub = (args[1] or ''):lower()
        if sub == 'on' or sub == 'off' then
            settings.party = (sub == 'on')
            config.save(settings)
            log('auto-party ' .. (settings.party and 'enabled' or 'disabled'))
            if settings.party and server and logged_in() then
                launch_overlay(true, '--spawn /party')
            end
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true, '--spawn /party') then
            log('party window launched')
        else
            log_err('no overlay found (build with npm run build:overlay)')
        end
    elseif cmd == 'target' then
        local sub = (args[1] or ''):lower()
        if sub == 'on' or sub == 'off' then
            settings.target = (sub == 'on')
            config.save(settings)
            log('auto-target ' .. (settings.target and 'enabled' or 'disabled'))
            if settings.target and server and logged_in() then
                launch_overlay(true, '--spawn /target')
            end
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true, '--spawn /target') then
            log('target window launched')
        else
            log_err('no overlay found (build with npm run build:overlay)')
        end
    elseif cmd == 'meter' then
        local sub = (args[1] or ''):lower()
        if sub == 'reset' then
            if party then party.meter_reset() end
            log('combat meter reset')
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true, '--spawn /meter') then
            log('combat meter launched')
        else
            log_err('no overlay found (build with npm run build:overlay)')
        end
    elseif cmd == 'check' then
        settings.target_check = not settings.target_check
        config.save(settings)
        log('auto-/check on new mob targets ' ..
            (settings.target_check and 'enabled' or 'disabled'))
    elseif cmd == 'skillchain' or cmd == 'sc' then
        local sub = (args[1] or ''):lower()
        if sub == 'on' or sub == 'off' then
            settings.skillchain = (sub == 'on')
            config.save(settings)
            log('auto-skillchain ' .. (settings.skillchain and 'enabled' or 'disabled'))
            if settings.skillchain and server and logged_in() then
                launch_overlay(true, '--spawn /skillchain')
            end
        elseif not (server or start_server()) then
            return
        elseif launch_overlay(true, '--spawn /skillchain') then
            log('skillchain tracker launched')
        else
            log_err('no overlay found (build with npm run build:overlay)')
        end
    elseif cmd == 'start' then
        start_server()
    elseif cmd == 'stop' then
        stop_server()
    elseif cmd == 'status' then
        if server then
            log('listening on http://127.0.0.1:' .. bound_port ..
                ' | gearswap dir: ' .. gearswap_data_dir())
        else
            log('server stopped')
        end
    elseif cmd == 'port' then
        local p = tonumber(args[1])
        if not p or p < 1 or p > 65535 then
            log_err('usage: //xicompanion port <number>')
        else
            settings.port = p
            config.save(settings)
            if server then
                stop_server()
                start_server()
            end
            log('port set to ' .. p)
        end
    elseif cmd == 'refresh' then
        pending_state = nil
        last_state_json = nil
        poll_state()
        broadcast_state()
        if swapui then pcall(swapui.rescan) end
        log('state pushed to clients')
    elseif cmd == 'memscan' then
        -- value-diff hunt for the live palette index: seeds from
        -- mcr.sys (or an explicit index), then flip a page/book in
        -- game and re-run `memscan <new index>` — each pass keeps
        -- only addresses still holding the new value.
        -- pass keeps only addresses still holding the new value.
        -- Candidate list is dumped to data/memscan.txt.
        if not plat.memory then
            log_err('memscan: _WindowerMemory.dll not loaded')
        else
            local val = tonumber(args[1])
            if not val and macrofs then
                local dirs = macrofs.find_char_dirs(plat.ffxi_path)
                if dirs[1] then val = macrofs.read_sys_index(dirs[1].path) end
            end
            if not val then
                log_err('usage: //xicompanion memscan [index]')
            else
                if not memscan_hits then
                    memscan_hits = {}
                    local pat = string.char(
                        val % 256,
                        math.floor(val / 256) % 256,
                        math.floor(val / 65536) % 256,
                        math.floor(val / 16777216) % 256):gsub('.', function(c)
                            return string.format('%02x ', c:byte())
                        end):gsub('%s+$', '')
                    for _, mod in ipairs({ 'FFXiMain.dll', 'pol.exe' }) do
                        local base, size = plat.memory.get_base(mod),
                            plat.memory.get_size(mod)
                        if base ~= 0 and size ~= 0 then
                            local n = 0
                            while n < 4096 do
                                local a = plat.memory.find(
                                    base, size, pat, 0, n)
                                if a == 0 then break end
                                memscan_hits[#memscan_hits + 1] = a
                                n = n + 1
                            end
                        end
                    end
                else
                    local keep = {}
                    for _, a in ipairs(memscan_hits) do
                        if plat.memory.read_uint32(a) == val then
                            keep[#keep + 1] = a
                        end
                    end
                    memscan_hits = keep
                end
                plat.create_dir(plat.addon_path .. 'data')
                local f = io.open(
                    plat.addon_path .. 'data/memscan.txt', 'w')
                if f then
                    for _, a in ipairs(memscan_hits) do
                        f:write(('0x%08x\n'):format(a))
                    end
                    f:close()
                end
                log(('memscan: %d candidate(s) for index %d')
                    :format(#memscan_hits, val))
            end
        end
    elseif cmd == 'equip' then
        local path = table.concat(args, ' ')
        if path == '' then
            log_err('usage: //xicompanion equip <set path>  e.g. //xicompanion equip idle.Town')
        elseif swapui then
            swapui.equip(path)
        else
            plat.send_command('gs equip ' .. path)
        end
    elseif cmd == 'swap' then
        -- swapui is a headless scanner powering `//xicompanion equip` and the
        -- list/add/remove bookkeeping commands.
        local sub = (args[1] or ''):lower()
        if not swapui then
            log_err('set scanner unavailable (swapui.lua failed to load)')
        elseif sub == 'scan' then
            log('scanning gearswap files... ' .. swapui.rescan() .. ' set(s) found')
        elseif sub == 'list' then
            swapui.list()
        elseif sub == 'add' then
            local canon, err = swapui.add(table.concat(args, ' ', 2))
            if canon then
                log('added ' .. canon .. ' to the swap list')
            else
                log_err('swap add: ' .. tostring(err))
            end
        elseif sub == 'remove' or sub == 'del' or sub == 'rm' then
            local canon, err = swapui.remove(table.concat(args, ' ', 2))
            if canon then
                log('removed ' .. canon .. ' from the swap list')
            else
                log_err('swap remove: ' .. tostring(err))
            end
        else
            log('usage: //xicompanion swap [scan|list|add <set>|remove <set>]')
        end
    else
        log('unknown command: ' .. cmd .. ' (try //xicompanion help)')
    end
end)

-- Track the zoning blackout for overlay_hidden: 0x00B = zone-out begins,
-- 0x00A = zone-in complete (the same packets pointwatch hides its box on).
plat.on('incoming chunk', function(id, data, modified, injected, blocked)
    if injected or blocked then return end
    if id == 0x00B then
        zoning = true
        -- zone-out: last zone's widescan list, entity positions, and
        -- in-flight cast are stale now — clear before new data lands
        if map then pcall(map.reset) end
        if party then pcall(party.reset) end
    elseif id == 0x00A then
        zoning = false
    end
end)

local function reset_state()
    pending_state = nil
    last_state_json = nil
    last_job_id = nil
    -- new session = new chat context: a fresh boot marker makes
    -- connected clients drop their stale seqs and resync
    chat_threads = {}
    tell_thread_order = {}
    chat_seq = 0
    chat_boot = math.random(0x7fffffff)
    if journal then pcall(journal.reset) end
    if recasts then pcall(recasts.reset) end
    if map then pcall(map.reset) end
    if party then pcall(party.reset) end
    if swapui then pcall(swapui.rescan) end
end

local function kill_overlay()
    -- plat.kill_image TerminateProcess()es directly — taskkill.exe is
    -- a console app and its window flashes even under SW_HIDE
    if not plat.kill_image('xicompanion-overlay.exe') then
        os.execute('taskkill /F /IM xicompanion-overlay.exe >nul 2>nul')
    end
    -- transitional: pre-rename binary
    if not plat.kill_image('xic-overlay.exe') then
        os.execute('taskkill /F /IM xic-overlay.exe >nul 2>nul')
    end
end

local function session_start()
    if settings.autostart and not server then
        start_server()
    end
    reset_state()
    pcall(load_chat_log) -- restore the persisted log for this session
end

-- the fab only exists while a character is in the world — spawn it on
-- login (or on load while already logged in), kill it on logout
local function spawn_fab()
    -- on reload the running instance ignores --fab and just stays visible
    if not settings.fab then
        -- //xicompanion fab off persists per character — say so instead of
        -- silently skipping, a stale override reads as "fab didn't spawn"
        log('auto-fab disabled for this character (//xicompanion fab on to re-enable)')
    elseif server then
        launch_overlay(true)
    end
    -- the tracker lives on the same always-up layer as the fab — spawn
    -- it alongside (the exe's --spawn goes through the single-instance
    -- handoff, so a running overlay just opens the window)
    if settings.tracker then
        launch_overlay(true, '--spawn /tracker')
    end
    if settings.macrobar then
        launch_overlay(true, '--spawn /macrobar')
    end
    if settings.cooldowns then
        launch_overlay(true, '--spawn /cooldowns')
    end
    if settings.minimap then
        launch_overlay(true, '--spawn /minimap')
    end
    if settings.party then
        launch_overlay(true, '--spawn /party')
    end
    if settings.target then
        launch_overlay(true, '--spawn /target')
    end
    if settings.skillchain then
        launch_overlay(true, '--spawn /skillchain')
    end
end

plat.on('load', function()
    session_start()
    -- //lua load mid-session lands after login — spawn directly; at the
    -- title screen 'login' picks it up instead
    if logged_in() then
        spawn_fab()
    end
end)

plat.on('login', function()
    session_start()
    spawn_fab()
end)

plat.on('logout', function()
    kill_overlay()
    reset_state()
end)

plat.on('unload', function()
    stop_server()
    if swapui then pcall(swapui.destroy) end
    kill_overlay()
end)

if settings.autostart then
    start_server()
end
