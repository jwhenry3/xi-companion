--[[
    swapui.lua -- headless GearSwap set scanner for the xic addon.

    Finds every `sets.*` path in the GearSwap user file for the current
    player/job, recursively following include()/require() calls, plus any
    paths added manually with `//xic swap add`. The compiled in-game UI
    (igui Sets tab) renders the result; `//xic swap list`,
    `//xic swap scan`, and `//xic equip` work headless.

    Loaded via dofile() from xic.lua.
]]

local M = {}

local S = {
    cfg = nil,          -- settings.swapui (persisted through config lib)
    save = nil,         -- fn() -> writes settings
    data_dir = nil,     -- fn() -> GearSwap data dir
    player = nil,       -- fn() -> windower.ffxi.get_player() or nil
    jobs = nil,         -- res.jobs
    log = nil,
    log_err = nil,

    sets = {},          -- flat list of {equip, label}
    scan_note = nil,
}

local function join(a, b)
    if a:sub(-1) ~= '\\' and a:sub(-1) ~= '/' then
        a = a .. '\\'
    end
    return a .. b
end

local function read_file(path)
    local f = io.open(path, 'rb')
    if not f then return nil end
    local c = f:read('*a')
    f:close()
    return c
end

----------------------------------------------------------------------
-- Set path scanning
----------------------------------------------------------------------

-- Parse an access chain directly after the word `sets` in src at index i.
-- Handles `.name` and `['name']` / `["name"]` segments.
-- Returns the segment list and the index just past the chain.
local function parse_chain(src, i)
    local segs = {}
    while true do
        local seg, e = src:match('^%.([%a_][%w_]*)()', i)
        if seg then
            segs[#segs + 1] = seg
            i = e
        else
            local seg2, e2 = src:match([=[^%[%s*['"]([^'"]+)['"]%s*%]()]=], i)
            if not seg2 then break end
            segs[#segs + 1] = seg2
            i = e2
        end
    end
    return segs, i
end

local function equip_path(segs)
    local out = 'sets'
    for _, s in ipairs(segs) do
        if s:match('^[%a_][%w_]*$') then
            out = out .. '.' .. s
        else
            out = out .. '[' .. ('%q'):format(s) .. ']'
        end
    end
    return out
end

-- Strip -- line comments and --[[ ]] block comments so commented-out
-- set definitions aren't listed.
local function strip_comments(src)
    local out = {}
    local in_block = false
    for line in (src .. '\n'):gmatch('([^\n]*)\n') do
        if in_block then
            local close = line:find(']]', 1, true)
            if close then
                line = line:sub(close + 2)
                in_block = false
            else
                line = ''
            end
        end
        local b = line:find('--[[', 1, true)
        if b then
            local close = line:find(']]', b + 4, true)
            if close then
                line = line:sub(1, b - 1) .. line:sub(close + 2)
            else
                line = line:sub(1, b - 1)
                in_block = true
            end
        end
        local c = line:find('--', 1, true)
        if c then line = line:sub(1, c - 1) end
        out[#out + 1] = line
    end
    return table.concat(out, '\n')
end

-- Find `sets.<chain> =` assignments in a source string.
local function scan_source(src, found, seen)
    local i = 1
    while true do
        local s, e = src:find('sets', i, true)
        if not s then break end
        local before = s > 1 and src:sub(s - 1, s - 1) or ''
        local after = src:sub(e + 1, e + 1)
        -- Token boundary: not preceded by a word char or '.', and must be
        -- followed by '.' or '[' to start a set path.
        if not before:match('[%w_%.]') and (after == '.' or after == '[') then
            local segs, ni = parse_chain(src, e + 1)
            -- Only assignments count (`= x`, not `== x` or expressions).
            if #segs > 0 and src:match('^%s*=(=?)', ni) == '' then
                local key = table.concat(segs, '\1')
                if not seen[key] then
                    seen[key] = true
                    found[#found + 1] = segs
                end
            end
            i = ni > e and ni or e + 1
        else
            i = e + 1
        end
    end
end

-- GearSwap pathsearch order for user files: data/<name>/, data/common/,
-- data/, then the APPDATA mirrors.
local function search_dirs(data_dir, player_name)
    local dirs = {}
    local function add(d)
        if d and windower.dir_exists(d) then
            dirs[#dirs + 1] = d
        end
    end
    if player_name and player_name ~= '' then
        add(join(data_dir, player_name))
    end
    add(join(data_dir, 'common'))
    add(data_dir)
    local appdata = os.getenv('APPDATA')
    if appdata and appdata ~= '' then
        local gs = appdata .. '\\Windower\\GearSwap'
        if player_name and player_name ~= '' then
            add(join(gs, player_name))
        end
        add(join(gs, 'common'))
        add(gs)
    end
    return dirs
end

-- GearSwap user-file name candidates, same order as load_user_files.
local function candidate_names(player)
    local job = S.jobs and S.jobs[player.main_job_id]
    local short = job and (job.ens or job.en)
    local long = job and job.en
    local name = player.name
    local names, dup = {}, {}
    local function add(f)
        if f and not dup[f] then
            dup[f] = true
            names[#names + 1] = f
        end
    end
    if short then
        add(name .. '_' .. short .. '.lua')
        add(name .. '-' .. short .. '.lua')
    end
    if long then
        add(name .. '_' .. long .. '.lua')
        add(name .. '-' .. long .. '.lua')
    end
    add(name .. '.lua')
    if short then add(short .. '.lua') end
    if long then add(long .. '.lua') end
    add('default.lua')
    return names
end

local function resolve_main(dirs, player)
    for _, d in ipairs(dirs) do
        for _, f in ipairs(candidate_names(player)) do
            local p = join(d, f)
            if windower.file_exists(p) then
                return p
            end
        end
    end
    return nil
end

-- GearSwap include()/require() lowercases the name and appends .lua.
local function resolve_include(dirs, ref)
    if type(ref) ~= 'string' or ref == '' then return nil end
    ref = ref:lower()
    if ref:sub(-4) ~= '.lua' then ref = ref .. '.lua' end
    for _, d in ipairs(dirs) do
        local p = join(d, ref)
        if windower.file_exists(p) then
            return p
        end
    end
    return nil
end

local function collect_sets()
    local player = S.player and S.player()
    if not player or not player.name then
        return nil, 'not logged in'
    end
    local dirs = search_dirs(S.data_dir(), player.name)
    local main = resolve_main(dirs, player)
    if not main then
        return nil, 'no gearswap file found for ' .. player.name
    end

    local found, seen, visited = {}, {}, {}
    local function scan(path, depth)
        if visited[path] or depth > 6 then return end
        visited[path] = true
        local src = read_file(path)
        if not src then return end
        src = strip_comments(src)
        scan_source(src, found, seen)
        for ref in src:gmatch([=[include[%s%(]*['"]([^'"]+)['"]]=]) do
            local p = resolve_include(dirs, ref)
            if p then scan(p, depth + 1) end
        end
        for ref in src:gmatch([=[require[%s%(]*['"]([^'"]+)['"]]=]) do
            local p = resolve_include(dirs, ref)
            if p then scan(p, depth + 1) end
        end
    end
    scan(main, 0)

    table.sort(found, function(a, b)
        return equip_path(a):lower() < equip_path(b):lower()
    end)
    return found, main
end

-- Normalize user input like 'idle.Town' or `sets.precast['X Y']` into the
-- canonical `sets.<path>` form GearSwap's equip command expects.
local function canon_path(str)
    if type(str) ~= 'string' then return nil end
    str = str:gsub('^%s+', ''):gsub('%s+$', '')
    if str == '' then return nil end
    if not str:match('^sets[%.%[]') then
        str = 'sets.' .. str
    end
    local segs = parse_chain(str, 5)
    if #segs == 0 then return nil end
    return equip_path(segs)
end

----------------------------------------------------------------------
-- Public API
----------------------------------------------------------------------

function M.setup(ctx)
    S.cfg = ctx.cfg or {}
    S.save = ctx.save or function() end
    S.data_dir = ctx.data_dir
    S.player = ctx.player
    S.jobs = ctx.jobs
    S.log = ctx.log or function() end
    S.log_err = ctx.log_err or S.log

    S.cfg.custom = S.cfg.custom or {}

    M.rescan()
end

function M.rescan()
    local found, info = collect_sets()

    S.sets = {}
    if found then
        for _, segs in ipairs(found) do
            local eq = equip_path(segs)
            S.sets[#S.sets + 1] = { equip = eq, label = eq:sub(6) }
        end
        S.scan_note = nil
    else
        S.scan_note = info
    end

    -- Merge manually-added paths.
    local seen = {}
    for _, e in ipairs(S.sets) do seen[e.equip:lower()] = true end
    for _, raw in ipairs(S.cfg.custom or {}) do
        local c = canon_path(raw)
        if c and not seen[c:lower()] then
            seen[c:lower()] = true
            S.sets[#S.sets + 1] = { equip = c, label = c:sub(6) .. ' *' }
        end
    end
    table.sort(S.sets, function(a, b) return a.equip:lower() < b.equip:lower() end)

    if #S.sets == 0 and not S.scan_note then
        S.scan_note = 'no sets found (//xic swap add <path>)'
    end

    return #S.sets
end

function M.sets_list()
    return S.sets
end

function M.list()
    if #S.sets == 0 then
        S.log('no sets found' .. (S.scan_note and (' - ' .. S.scan_note) or ''))
        return
    end
    S.log('equippable sets (' .. #S.sets .. '):')
    for _, e in ipairs(S.sets) do
        S.log('  ' .. e.label)
    end
end

function M.equip(str)
    local canon = canon_path(str)
    if not canon then
        S.log_err('usage: //xic equip <set path>  e.g. //xic equip idle.Town')
        return
    end
    windower.send_command('gs equip ' .. canon)
    S.log('gs equip ' .. canon)
end

function M.add(str)
    local canon = canon_path(str)
    if not canon then return nil, 'bad path' end
    S.cfg.custom = S.cfg.custom or {}
    for _, c in ipairs(S.cfg.custom) do
        if canon_path(c) == canon then return nil, 'already listed' end
    end
    S.cfg.custom[#S.cfg.custom + 1] = canon
    S.save()
    M.rescan()
    return canon
end

function M.remove(str)
    local canon = canon_path(str)
    if not canon then return nil, 'bad path' end
    for i, c in ipairs(S.cfg.custom or {}) do
        if canon_path(c) == canon then
            table.remove(S.cfg.custom, i)
            S.save()
            M.rescan()
            return canon
        end
    end
    return nil, 'not in the custom list'
end

function M.destroy()
end

return M
