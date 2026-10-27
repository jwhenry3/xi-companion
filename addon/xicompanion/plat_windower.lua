-- plat_windower.lua: Windower binding for the plat surface.
local P = {}

P.host          = 'windower'
P.addon_path    = windower.addon_path
P.windower_path = windower.windower_path
P.ffxi_path     = windower.ffxi_path

P.file_exists = windower.file_exists
P.dir_exists  = windower.dir_exists
P.create_dir  = windower.create_dir
P.get_dir     = windower.get_dir

-- {name -> stamp} for files matching a glob — the client rewrites
-- mcr.sys + the departing palette on every in-game book/page switch.
-- Content-Hashed rather than mtime'd: forfiles/io.popen spawns a
-- console window per call — visible flash + focus flicker at poll rate.
local function content_mtimes(dir, glob)
    local files = P.get_dir(dir)
    if type(files) ~= 'table' then return nil end
    local g = glob or '*'
    local prefix = g:match('^([^*]*)') or ''
    local suffix = g:match('%*([^*]*)$') or ''
    local out = {}
    for _, name in ipairs(files) do
        if name:sub(1, #prefix) == prefix
            and (suffix == '' or name:sub(-#suffix) == suffix) then
            local f = io.open(dir .. '\\' .. name, 'rb')
            if f then
                local body = f:read('*a') or ''
                f:close()
                -- cheap content stamp: length + a rolling byte mix —
                -- collision-safe enough for "did the client rewrite it"
                local h = #body
                for i = 1, #body, 37 do
                    h = (h * 31 + body:byte(i)) % 4294967291
                end
                out[name] = h
            end
        end
    end
    return out
end
P.file_mtimes = windower.file_mtimes or content_mtimes

-- game reads — the subset used across the addon: get_player,
-- get_items, get_bag_info, get_info, get_ability_recasts,
-- get_spell_recasts, get_mob_by_target, get_mob_by_index,
-- get_mob_array, get_map_data, drop_item.
P.ffxi = windower.ffxi

P.send_command = windower.send_command
P.open_url     = windower.open_url
P.add_to_chat  = windower.add_to_chat

P.on = windower.register_event

-- keyboard hook — fn(dik, down, flags, blocked); return true to
-- block the key before the client sees it
P.on_key = function(fn) return P.on('keyboard', fn) end

return P
