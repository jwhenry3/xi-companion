--[[ mapimg.lua: resolves zone map image DATs from the client install.

Zone/map -> file-id table lives in mapdats.lua (generated from Windower
ResourceExtractor's MapDats.json). File ids resolve through FTABLE.DAT at
the FFXI install root: u16 @ id*2 -> ROM/<f/128>/<f%128>.DAT. The raw DAT
bytes are handed to the browser, which decodes the DXT/bitmap payload —
keeps image decode off the game frame entirely.
--]]

local M = {}

local mapdats
local ftable       -- cached FTABLE.DAT contents
local ftable_err   -- sticky failure so we only try/log once
local dat_paths = {}

function M.setup()
    local ok, mod = pcall(dofile, windower.addon_path .. 'mapdats.lua')
    if ok and type(mod) == 'table' then
        mapdats = mod
    end
end

local function ftable_bytes()
    if ftable then return ftable end
    if ftable_err then return nil end
    if type(windower.ffxi_path) ~= 'string' then
        ftable_err = 'no ffxi_path'
        return nil
    end
    local f = io.open(windower.ffxi_path .. '/FTABLE.DAT', 'rb')
    if not f then
        ftable_err = 'no FTABLE.DAT'
        return nil
    end
    ftable = f:read('*a')
    f:close()
    return ftable
end

local function dat_path(fid)
    if dat_paths[fid] ~= nil then
        return dat_paths[fid] or nil
    end
    local ft = ftable_bytes()
    if not ft then return nil end
    local i = fid * 2 + 1
    if i + 1 > #ft then
        dat_paths[fid] = false
        return nil
    end
    local f = ft:byte(i) + ft:byte(i + 1) * 256
    local p = ('%s/ROM/%d/%d.DAT'):format(windower.ffxi_path, math.floor(f / 128), f % 128)
    if not windower.file_exists(p) then
        dat_paths[fid] = false
        return nil
    end
    dat_paths[fid] = p
    return p
end

-- Zone + client map number -> DAT file id. `map` is the map number reported
-- by get_map_data(); single-map zones match it regardless of key base.
function M.dat_fid(zone, map)
    if not mapdats then return nil end
    local t = zone and mapdats[zone]
    if not t then return nil end
    if map and t[map] then return t[map] end
    local k, v = next(t)
    if next(t, k) == nil then return v end
    return nil
end

-- Raw map DAT bytes for the zone/map, or nil when unresolvable.
function M.dat_bytes(zone, map)
    local fid = M.dat_fid(zone, map)
    local p = fid and dat_path(fid)
    if not p then return nil end
    local f = io.open(p, 'rb')
    if not f then return nil end
    local b = f:read('*a')
    f:close()
    return b
end

return M
