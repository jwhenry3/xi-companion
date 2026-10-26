--[[
    abilities.lua: the /abilities skill+spell book — everything the
    current job can learn vs. has learned, plus the command lines to
    trigger each one (click-to-use with <t>/<st>/<me>, copyable for
    macros).

    Learned sets come from get_abilities()/get_spells(). Obtainable
    spells use res.spells' per-job `levels` map (subjob reqs double to
    main-job levels — sub level is main/2). res.job_abilities carries
    no requirements, so JAs join ja_levels.lua (generated from bg-wiki
    Category:Job_Ability infoboxes) by lowercased English name; the join
    degrades gracefully — an unmatched JA just shows without level info.
]]
local plat = require('plat')
local M = {}
local ctx

-- menu icons live in the sts_icon set (ROM/119/57.DAT, served by
-- /api/statusicon). res.*[].icon_id is the *macro palette* icon —
-- right for JAs (unique per ability) and WSs (element swords),
-- but the magic menu shows element-colored el* tiles (589+element)
-- and avatar faces instead. Trust icon_ids (1000+) index the
-- second store (ROM/324/95 fa_* faces, extracted to statusicons2).
local EL_ICON = 589 -- elfire..eldark at 589..596
local AVATAR_ICON = {
    ['carbuncle'] = 422, ['ifrit'] = 423, ['shiva'] = 424,
    ['garuda'] = 425, ['titan'] = 426, ['ramuh'] = 427,
    ['leviathan'] = 428, ['fenrir'] = 429, ['diabolos'] = 430,
    ['cait sith'] = 577, ['siren'] = 625,
}
local function element_icon(el, base)
    if type(el) == 'number' and el >= 0 and el <= 7 then
        return base + el
    end
end
-- trust menu shows role weapons — real item icons via /api/icon:
-- tank=shield(Aspis), melee=sword(Bronze), ranged=bow(Shortbow),
-- caster=wand(Willow), healer=club(Ash), support=flute;
-- specials keep the sts sphere. res clusters Trust icon_ids by role.
local TRUST_ITEM_ICON = {
    [1000]=12312,[1005]=12312,[1006]=12312,[1007]=12312,[1008]=12312,[1009]=16535, -- tanks: R.K. Army Shield
    [1010]=16535,[1011]=16535,[1012]=16535,[1013]=16535,[1014]=16535, -- melee: sword
    [1015]=16535,[1016]=16535,[1017]=16535,[1018]=16535,[1019]=16535,
    [1021]=16535,[1026]=16535,[1027]=16535,[1028]=16535,
    [1030]=16535,[1037]=16535,[1044]=16535,[1045]=16535,[1046]=16535,
    [1048]=16535,[1057]=16535,[1058]=16535,[1059]=16535,[1060]=16535,
    [1020]=17152,[1022]=17152,[1023]=17152,[1024]=17152,[1025]=17152, -- ranged: bow
    [1029]=17088,[1031]=17088,[1032]=17088,[1033]=17088,[1035]=17088, -- caster: staff
    [1034]=17088,
    [1036]=17050,[1038]=17050,[1039]=17050,[1040]=17050,[1041]=17050, -- healer: wand
    [1042]=17050,[1043]=17050,
    [1047]=17345,[1049]=17345,[1050]=17345,[1051]=17345,[1052]=17345, -- support: flute
    [1053]=17345,[1054]=17345,
}
local TRUST_STS_ICON = { [1055]=476, [1056]=476, [1061]=476, [1062]=476 } -- sphere (special)

-- Menu icon store (ROM/280/15 + 324/95): pre-extracted DXT3 BMPs under
-- data/menuicons/<i>.bmp, served by /api/menuicon. Chunks are name-keyed
-- "group/name" ("white/cure", "jobabi/jobab_5", "faith/fa_2_3") — spells
-- resolve by normalized English name against menu_icon_names.lua.
local menu_icon_idx -- name -> index into data/menuicons
do
    local ok, menu_extractor = pcall(require, 'menu_extractor')
    local names = ok and menu_extractor and menu_extractor.names()
    if type(names) == 'table' then
        menu_icon_idx = {}
        for i, n in pairs(names) do
            if type(n) == 'string' then menu_icon_idx[n] = i end
        end
    end
end
-- spell type -> icon group in the store
local MENU_GROUP = {
    WhiteMagic = 'white', BlackMagic = 'black', SummonerPact = 'summon',
    Trust = 'faith', Ninjutsu = 'ninja', BardSong = 'song',
    BlueMagic = 'misc', Geomancy = 'misc',
}
local function menu_icon_for(en, grp)
    if not menu_icon_idx then return nil end
    local norm = en:lower():gsub('[^a-z0-9]', ''):sub(1, 8)
    local base = norm:gsub('[ivx0-9]+$', '')
    for _, cand in ipairs({ grp and (grp .. '/' .. norm), grp and (grp .. '/' .. base), norm, base }) do
        if cand and menu_icon_idx[cand] then return menu_icon_idx[cand] end
    end
end

-- WS icon = weapon-class tile from the misc/ws 4x4 sheet (/api/menuicon?ws=N)
-- res skill id → tile (weapon classes ordered, ranged skills appended)
local WS_TILE = { [25] = 12, [26] = 13, [27] = 14, [28] = 14 }

-- lvl-96 SP abilities (icon_id 1064+) → 2habi/sp2_NN_* in the 324/95 store
-- (verified: Stymie icon_id 1068 → sp2_05_r). sp2 index = icon_id - 1063.
local sp2_icon = {}
if menu_icon_idx then
    for name, i in pairs(menu_icon_idx) do
        local n = name:match('^2habi/sp2_(%d+)')
        if n then sp2_icon[tonumber(n)] = i end
    end
end

local ja_levels = {}
do
    local ok, t = pcall(dofile, plat.addon_path .. 'ja_levels.lua')
    if ok and type(t) == 'table' then ja_levels = t end
end

function M.setup(deps)
    ctx = deps
end

local function job_name(id)
    local j = ctx.res.jobs and ctx.res.jobs[id]
    return j and (j.en or j.english or j.ens)
end

function M.read()
    local okp, p = pcall(plat.ffxi.get_player)
    if not okp or type(p) ~= 'table' or not p.main_job_id then
        return nil
    end
    local mj, sj = p.main_job_id, p.sub_job_id
    local mj_name, sj_name = job_name(mj), job_name(sj)

    -- learned sets — the get_* calls return either an array of ids or a
    -- full id->bool map (false = not learned); accept both, skip falsy
    -- values so an unlearned entry can't mark itself learned
    local function mark_learned(set, t)
        for k, v in pairs(t or {}) do
            if type(v) == 'number' then set[v] = true
            elseif v then set[k] = true end
        end
    end
    local learned_ja, learned_ws, learned_sp = {}, {}, {}
    local oka, ab = pcall(plat.ffxi.get_abilities)
    if oka and type(ab) == 'table' then
        mark_learned(learned_ja, ab.job_abilities)
        mark_learned(learned_ws, ab.weapon_skills)
    end
    local oks, sp = pcall(plat.ffxi.get_spells)
    if oks then mark_learned(learned_sp, sp) end

    local abilities = ctx.json_array and ctx.json_array({}) or {}
    for id, a in pairs(ctx.res.job_abilities or {}) do
        if type(a) == 'table' and a.en then
            local meta = ja_levels[a.en:lower()]
            -- job match: the JA's owning job vs main/sub. A sub-job JA
            -- needs the req level on the SUB → main level req is level*2
            local lvl, jsrc
            if meta and meta.job then
                if meta.job == mj_name then
                    lvl, jsrc = meta.level, 'M'
                elseif meta.job == sj_name then
                    lvl, jsrc = meta.level and meta.level * 2, 'S'
                end
            end
            if learned_ja[id] or jsrc then
                abilities[#abilities + 1] = {
                    id = id, n = a.en, pfx = a.prefix or '/jobability',
                    tg = a.targets or 0,
                    mp = a.mp_cost or 0, tp = a.tp_cost or 0,
                    rg = a.range or 0, dur = a.duration,
                    rid = a.recast_id,
                    ty = meta and meta.type or nil,
                    lvl = lvl, j = jsrc, cmd = meta and meta.cmd or nil,
                    ic = a.icon_id,
                    -- 2-hour icons live in the 2habi/spabi sheets, sliced
                    -- to data/menuicons/330+ (tile = icon_id - 66: CS 70→4).
                    -- Lvl-96 SPs (icon_id ≥1064) are name-keyed
                    -- 2habi/sp2_NN_j in 324/95 (Stymie 1068 → sp2_05_r).
                    -- Other JAs use jobabi/jobab_N where N = icon_id - 360
                    -- (verified: Convert 391→jobab_31, Composure 392→jobab_32)
                    mic = (a.icon_id and a.icon_id >= 66 and a.icon_id <= 85)
                        and (330 + a.icon_id - 66)
                        or (a.icon_id and a.icon_id >= 1064
                            and sp2_icon[a.icon_id - 1063])
                        or (a.icon_id and a.icon_id > 360
                            and menu_icon_idx and menu_icon_idx[
                                'jobabi/jobab_' .. tostring(a.icon_id - 360)]),
                    l = learned_ja[id] and 1 or nil, k = 'ja',
                }
            end
        end
    end
    -- learned weapon skills ride the same list; "obtainable" needs weapon
    -- skill levels, which res doesn't carry — learned only
    for id, w in pairs(ctx.res.weapon_skills or {}) do
        if learned_ws[id] and type(w) == 'table' and w.en then
            abilities[#abilities + 1] = {
                id = id, n = w.en, pfx = w.prefix or '/weaponskill',
                tg = w.targets or 0, rg = w.range or 0,
                ic = w.icon_id, el = w.element,
                mic = w.skill and (WS_TILE[w.skill] or w.skill - 1),
                k = 'ws', l = 1,
            }
        end
    end

    local spells = ctx.json_array and ctx.json_array({}) or {}
    for id, s in pairs(ctx.res.spells or {}) do
        if type(s) == 'table' and s.en then
            local lv = s.levels or {}
            local lvl, jsrc
            if mj and lv[mj] then
                lvl, jsrc = lv[mj], 'M'
            elseif sj and lv[sj] then
                lvl, jsrc = lv[sj] * 2, 'S'
            end
            if learned_sp[id] or jsrc then
                local ic, iic, mic
                mic = menu_icon_for(s.en, MENU_GROUP[s.type])
                if s.type == 'Trust' then
                    ic = s.icon_id -- ≥1000 → fa_* face via statusicons2
                    iic = TRUST_ITEM_ICON[s.icon_id] -- weapon fallback
                elseif not mic then
                    -- no name-keyed menu icon (e.g. summon pacts): fall
                    -- back to the sts avatar face / element tile
                    ic = AVATAR_ICON[s.en:lower()] or element_icon(s.element, EL_ICON)
                end
                spells[#spells + 1] = {
                    id = id, n = s.en, pfx = s.prefix or '/magic',
                    tg = s.targets or 0, ty = s.type, sk = s.skill,
                    el = s.element, mp = s.mp_cost or 0,
                    ct = s.cast_time, rc = s.recast, rg = s.range or 0,
                    lvl = lvl, j = jsrc, ic = ic, iic = iic, mic = mic,
                    pn = s.type == 'Trust' and s.party_name or nil,
                    l = learned_sp[id] and 1 or nil, k = 'sp',
                }
            end
        end
    end

    local by_level = function(a, b)
        local al, bl = a.lvl or 999, b.lvl or 999
        return al ~= bl and al < bl or al == bl and a.n < b.n
    end
    table.sort(spells, by_level)
    table.sort(abilities, by_level)

    return { on = 1, abilities = abilities, spells = spells }
end

return M
