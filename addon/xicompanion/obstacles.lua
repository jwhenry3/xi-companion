-- obstacles.lua: screen regions owned by other addons' UI and retail
-- chrome, so placement can route our windows around them (ImagineXI's
-- auto_layout approach). Scans each known addon's data/settings.xml
-- for saved positions; a loaded-check via scripts/init.txt keeps stale
-- configs from blocking space. Retail chat log + menu bar get scaled
-- default rects.
local M = {}

local function read(path)
    local f = io.open(path, 'rb')
    if not f then return nil end
    local s = f:read('*a')
    f:close()
    return s
end

local function xmlnum(s, tag)
    local v = s and s:match('<' .. tag .. '>(%-?%d+)</' .. tag .. '>')
    return v and tonumber(v) or nil
end

-- name -> footprint + where its saved pos lives
local KNOWN = {
    xivbar = { w = 472, h = 40 },
    equipviewer = { w = 140, h = 158 },
    giltracker = { w = 140, h = 28, def = { -285, -35 } },
    tparty = { w = 120, right = true, hfrac = 0.55 },
    targetinfo = { w = 240, h = 72 },
    infobar = { w = 420, h = 28 },
    debuffed = { w = 240, h = 180, right = true, top = 0.18 },
    distance = { w = 220, h = 48, top = 0.02, cx = 0.42 },
}

-- addons with a settings.xml but no 'lua load' in init.txt are
-- installed-not-loaded — don't let them wall off screen space
local function loaded_set(windower_path)
    local s = read(windower_path .. 'scripts/init.txt') or ''
    local set = {}
    for name in s:gmatch('lua%s+l[oa]*d?%s+(%w+)') do set[name:lower()] = true end
    return set
end

function M.scan(deps)
    local sw, sh = deps.screen_w or 1920, deps.screen_h or 1080
    local loaded = loaded_set(deps.windower_path)
    local obs = {}
    -- retail zones scaled from 1920x1080: chat log bottom-left + the
    -- bottom-center menu bar
    obs[#obs + 1] = { x = 0, y = math.floor(sh * 0.70),
                      w = math.floor(sw * 0.325), h = math.floor(sh * 0.30),
                      source = 'retail_chat' }
    obs[#obs + 1] = { x = math.floor((sw - 640) / 2), y = sh - 72,
                      w = 640, h = 72, source = 'retail_menu' }

    local adir = deps.windower_path .. 'addons/'
    for name, spec in pairs(KNOWN) do
        local cap = name:gsub('^%l', string.upper)
        local xml
        for _, cand in ipairs({ name, cap }) do
            xml = read(adir .. cand .. '/data/settings.xml')
            if xml then name = cand break end
        end
        if xml and (loaded[name:lower()] or loaded[cap:lower()]) then
            local x, y
            -- per-player block first, then global
            for _, sec in ipairs({ deps.player_name or '', 'global' }) do
                if sec ~= '' then
                    local blk = xml:match('<' .. sec .. '>(.-)</' .. sec .. '>')
                    local pos = blk and (blk:match('<pos>(.-)</pos>') or blk)
                    x = pos and xmlnum(pos, 'x')
                    y = pos and xmlnum(pos, 'y')
                    if x and y then break end
                end
            end
            x = x or (spec.def and spec.def[1])
            y = y or (spec.def and spec.def[2])
            if x or spec.right or spec.cx then
                local h = spec.hfrac and math.floor(sh * spec.hfrac)
                    or spec.h or 40
                if spec.right then
                    x = sw - spec.w - 8
                    y = math.floor(sh * (spec.top or 0.08))
                elseif spec.cx then
                    x = math.floor(sw * spec.cx)
                    y = math.floor(sh * (spec.top or 0.02))
                else
                    if x < 0 then x = sw + x - spec.w end
                    if y and y < 0 then y = sh + y - h end
                end
                obs[#obs + 1] = { x = x, y = y or 0, w = spec.w, h = h,
                                  source = name }
            end
        end
    end
    return obs
end

return M
