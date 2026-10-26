-- party.lua: party/alliance vitals + buffs, current target, and a
-- casting tracker — feeds the /party and /target detached windows.
--
-- Members come from plat.ffxi.get_party() (p0..p5, a10..a15, a20..a25):
-- {hp,hpp,mp,mpp,tp,zone,name,mob}. Party-wide buffs ride incoming
-- 0x076 — five 48-byte blocks, one per member except the local player,
-- whose own list comes from get_player().buffs. The per-buff encoding
-- packs the low byte at +16+i and the high 2 bits inside a shared u8
-- (Byrth's formula, same as XivParty/PartyBuffs).
--
-- Target comes from get_mob_by_target('t'). Casts ride incoming 0x028
-- action packets — category 8 = casting start, 7 = weaponskill start;
-- the first target's first action param carries the spell/ability id
-- and the top-level "recast" field carries the cast time in 1/60s.
-- Any later action from the same actor ends the cast (finish/interrupt
-- alike), plus an expiry fallback in case nothing arrives.
--
-- polled from pump() every call; internally throttled to ~4Hz.
local plat = require('plat')
-- bitlib under both hosts (global on LuaJIT, module elsewhere); pure-Lua
-- floor-division fallback keeps headless test envs working too
local bit = _G.bit
local _bok, _bmod = pcall(require, 'bit')
bit = bit or (_bok and _bmod or nil)
local rshift = bit and bit.rshift
    or function(x, n) return math.floor(x / (2 ^ n)) end
-- fractional wall clock for the cast eta — os.time() is integer seconds,
-- which lands the eta ~1s early and zeroes the bar fill
local _sock_ok, _sock = pcall(require, 'socket')
local unix_now = (_sock_ok and _sock and _sock.gettime) or os.time
local M = {}
local ctx

local poll_n = 0
local last_payload = nil
local member_buffs = {}   -- player id -> {i32} buff ids seen via 0x076
-- job info: get_party() carries none — it rides 0x0DD (party member
-- update) / 0x0DF (char update) keyed by player id; a name-keyed copy
-- covers members whose mob record is out of zone (no id to key on)
local member_jobs = {}      -- player id -> {j,jl,sj,sjl}
local member_jobs_name = {} -- display name -> same
local cast = nil          -- {actor, an, n, dur, t0, t1} cast in progress
-- measured windups: when a later action from the same actor ends a
-- cast, the real elapsed time is observable. NMs/mob moves run on
-- their own clock — res.spells' cast_time (or the BLU spell a move
-- borrows its id from) routinely overshoots. Learn per actor|move and
-- per move ('*|name' for cat-7) so repeat windups estimate right.
local dur_log = {}        -- recent {an,n,e,a,c} estimate-vs-actual rows
local dur_learned = {}    -- "an|n" / "*|n" -> observed seconds
local dur_dirty = false   -- learned rows pending persist
local windups_path = nil  -- data/windups.lua once setup() hands us a dir

local function persist_windups()
    if not windups_path then return end
    if ctx.data_dir and not plat.dir_exists(ctx.data_dir) then
        pcall(plat.create_dir, ctx.data_dir)
    end
    local f = io.open(windups_path, 'wb')
    if not f then return end
    local out = { 'return {' }
    for k, v in pairs(dur_learned) do
        out[#out + 1] = string.format('[%q]=%s,', k, tostring(v))
    end
    out[#out + 1] = '}'
    f:write(table.concat(out))
    f:close()
end

function M.setup(deps)
    ctx = deps
    -- learned windups persist across `lua reload` — losing them each
    -- reload would reset every NM to its wrong stock estimate
    if deps.data_dir and deps.join then
        windups_path = deps.join(deps.data_dir, 'windups.lua')
    end
    if windups_path and plat.file_exists(windups_path) then
        local ok, t = pcall(dofile, windups_path)
        if ok and type(t) == 'table' then
            for k, v in pairs(t) do
                if type(v) == 'number' then dur_learned[k] = v end
            end
        end
    end
end
-- diagnostic ring: what the 0x028 handler actually saw — mob casts are
-- too fast to catch live in /api/party, so the last few action packets
-- are kept for /api/party/dbg
local action_seen = 0
local action_log = {}
local dbg_t = nil           -- last target struct fields, for /api/party/dbg
local dbg_me = nil          -- player id for the same dump
local dbg_mn = nil          -- player name, for own-flag checks
-- wire id <-> entity index, learned from 0x00E/0x00D update packets:
-- 0x028 actor ids on this server live in a space none of the
-- get_mob_by_* reads expose, but updates carry both halves
local wire = {}
local wire_r = {}
-- this server's 0x028 actor field packs the entity id shifted left a
-- byte with flags — actor>>8 == wire_id & 0xFFFFFF (seen live:
-- a=0x0669051f -> entity 0x01066905). Index the map on the low 24 bits
-- so packed actors bridge back to entity indices.
local wire24 = {}
local wire_ix = function(id) return wire[id] or wire24[rshift(id, 8)] end
local wire_seen = 0         -- 0x00D/0x00E packets observed
local wire_sample = {}      -- last few {wid, ix} pairs for dbg
local dbg_mi = nil          -- raw fields of target's mob-array entry
local me_ix = nil             -- cached player entity index
-- the player's own entity never emits a 0x00D for itself, so its wire
-- id is learned off the outgoing packet instead: a cast request right
-- before a cat-8/7 from an unmapped actor is almost certainly ours
local own_until = 0
local out_seen = 0            -- 0x01A count for dbg

local MEMBER_KEYS = {
    { 'p0', 'p1', 'p2', 'p3', 'p4', 'p5' },
    { 'a10', 'a11', 'a12', 'a13', 'a14', 'a15' },
    { 'a20', 'a21', 'a22', 'a23', 'a24', 'a25' },
}

-- LSB-first bit reader over a byte string (absolute bit offsets —
-- matches packets.lib's `assemble_bit_packed` layout)
local function bits(data, off, n)
    local v = 0
    for i = 0, n - 1 do
        local pos = off + i
        local byte = data:byte(math.floor(pos / 8) + 1) or 0
        if math.floor(byte / (2 ^ (pos % 8))) % 2 == 1 then
            v = v + 2 ^ i
        end
    end
    return v
end

local function res_name(kind, id)
    local t = ctx.res and ctx.res[kind]
    local e = t and t[id]
    return e and (e.en or e.enl)
end

local function u32(data, p)
    return (data:byte(p) or 0) + (data:byte(p + 1) or 0) * 256
        + (data:byte(p + 2) or 0) * 65536
        + (data:byte(p + 3) or 0) * 16777216
end

-- job id -> short tag ('WAR'); res.jobs[0] is 'NON', callers filter id>0
local function job_ens(id)
    local j = id and ctx.res and ctx.res.jobs and ctx.res.jobs[id]
    return j and (j.ens or j.en)
end

-- Trusts join as NPC members (no job/level packets) — detect by name
-- against res.spells Trust party_names and show a role tag instead.
-- res doesn't carry Trust roles, so the common set is mapped by hand.
local trust_names
local TRUST_ROLE = {
    -- tank
    Valaineral='TNK',August='TNK',Curilla='TNK',Trion='TNK',
    ['Rughadjeen']='TNK',['Ark Angel HM']='TNK',Rahal='TNK',
    Morimar='TNK',['King of Hearts']='TNK',Amchuchu='TNK',
    ['Abquhbah']='TNK',['Naja Salaheem']='TNK',
    -- healer
    Kupipi='HLR',['Mihli Aliapoh']='HLR',Apururu='HLR',
    Cherukiki='HLR',['Karaha-Baruha']='HLR',['Ingrid II']='HLR',
    ['Arciela II']='HLR',['Star Sibyl']='HLR',['Yoran-Oran']='HLR',
    -- ranged
    ['Semih Lafihna']='RNG',Najelith='RNG',['Makki-Chebukki']='RNG',
    ['Elivira']='RNG',['Margret']='RNG',
    -- caster
    Shantotto='CST',['Shantotto II']='CST',['Domina Shantotto']='CST',
    ['Robel-Akbel']='CST',['Adelheid']='CST',Teodor='CST',
    Ovjang='CST',['D. Shantotto']='CST',
    -- support
    Joachim='SUP',Ulmia='SUP',['Koru-Moru']='SUP',Qultada='SUP',
    Brygid='SUP',['Ygnas']='SUP',Moogle='SUP',Sakura='SUP',
    ['Kupofried']='SUP',['Matsui-P']='SUP',
}
local function trust_role(name)
    if not name or name == '' then return nil end
    if not trust_names then
        trust_names = {}
        if ctx.res and ctx.res.spells then
            for _, s in pairs(ctx.res.spells) do
                if s.type == 'Trust' then
                    trust_names[(s.party_name or s.en):lower()] = s.en
                end
            end
        end
    end
    local en = trust_names[name:lower()]
    return en and (TRUST_ROLE[en] or 'DD')
end

-- cast→target matching falls back on the actor's name: resolve the
-- packet actor via get_mob_by_id, and if that's unavailable try the
-- entity index packed in the low bits of the id
local function actor_name(id)
    if not id then return nil end
    local ok, m = pcall(plat.ffxi.get_mob_by_id, id)
    if ok and type(m) == 'table' and m.name then return m.name end
    -- server-side actor ids map to an index through the wire map
    local ix = wire_ix(id) or (id % 0x1000)
    local ok2, m2 = pcall(plat.ffxi.get_mob_by_index, ix)
    if ok2 and type(m2) == 'table' then return m2.name end
end

local function buff_list(ids)
    local out = ctx.json_array({})
    for _, id in ipairs(ids or {}) do
        if id and id ~= 0 and id ~= 255 then
            out[#out + 1] = { i = id, n = res_name('buffs', id) }
        end
    end
    return out
end

local function own_buffs()
    local ok, p = pcall(plat.ffxi.get_player)
    if not ok or type(p) ~= 'table' then return nil end
    return p.buffs
end

local function member_id(m)
    return (type(m.mob) == 'table' and m.mob.id) or nil
end

local function member_row(key, m, my_zone, leaders)
    local mid = member_id(m)
    local ids = mid and member_buffs[mid] or nil
    if key == 'p0' then ids = ids or own_buffs() end
    -- raw current values ride m.hp/m.mp; maxes aren't in the party
    -- struct — exact for the local player via vitals, derived from the
    -- floored percentage for everyone else (±1% drift at most)
    local hpm, mpm
    if key == 'p0' then
        local okv, p = pcall(plat.ffxi.get_player)
        local v = okv and type(p) == 'table' and p.vitals
        if type(v) == 'table' then
            hpm, mpm = v.max_hp, v.max_mp
        end
    end
    if not hpm and m.hp and (m.hpp or 0) > 0 then
        hpm = math.floor(m.hp * 100 / m.hpp + 0.5)
    end
    if not mpm and m.mp and (m.mpp or 0) > 0 then
        mpm = math.floor(m.mp * 100 / m.mpp + 0.5)
    end
    -- job/level: the player's own reads are instant via get_player();
    -- everyone else waits on the 0x0DD/0x0DF feed
    local jr
    if key == 'p0' then
        local okj, p = pcall(plat.ffxi.get_player)
        if okj and type(p) == 'table' then
            jr = {
                j = p.main_job_id, jl = p.main_job_level,
                sj = p.sub_job_id, sjl = p.sub_job_level,
            }
        end
    else
        jr = (mid and member_jobs[mid]) or member_jobs_name[m.name]
    end
    return {
        n = m.name or '',
        hp = m.hpp or 0, mp = m.mpp or 0, tp = m.tp or 0,
        hc = m.hp, mc = m.mp, hx = hpm, mx = mpm,
        j = jr and jr.j and jr.j > 0 and job_ens(jr.j) or nil,
        jl = jr and jr.jl or nil,
        sj = jr and jr.sj and jr.sj > 0 and job_ens(jr.sj) or nil,
        sjl = jr and jr.sjl or nil,
        tr = key ~= 'p0' and trust_role(m.name) or nil,
        o = (m.zone and m.zone ~= my_zone) and 1 or nil,
        l = (mid and leaders[key]) and 1 or nil,
        b = buff_list(ids),
    }
end

-- 0x028 categories: 7 = weaponskill start, 8 = casting start; anything
-- else from the same actor ends its in-progress cast
local function action_name(cat, spell_id)
    if cat == 8 then
        return res_name('spells', spell_id)
            or res_name('monster_abilities', spell_id)
    elseif cat == 7 then
        return res_name('weapon_skills', spell_id)
            or res_name('monster_abilities', spell_id)
    end
end

-- casts keyed per-actor: a trust mid-cure must not clobber the engaged
-- NM's windup — a single slot did exactly that (mob bars went blank
-- whenever a party member started casting)
local casts = {}          -- actor key -> cast rec
local function actor_key(a)
    -- resolved zone index when mapped; else the packed entity core
    -- (a>>8 — flag byte varies by packet category, never key on it raw)
    return wire_ix(a) or ('x' .. rshift(a, 8))
end
local function rec_json(rec)
    local rem = rec.t1 - os.clock()
    if rem <= 0 then return nil end
    return {
        a = rec.actor, an = rec.an, n = rec.n, own = rec.own,
        -- unix eta (fractional) so every window animates off its own clock
        t = unix_now() + rem,
        d = rec.dur,
    }
end

local function cast_now()
    if not cast then return end
    local j = rec_json(cast)
    if not j then cast = nil end
    return j
end

-- ---------- skillchain / magic-burst tracking ----------
-- Chain state is per-TARGET (a WS chains with the previous WS on the
-- same mob, not globally). Prediction-based: res.weapon_skills gives
-- each WS up to 3 skillchain properties; SC[active][prop] = {lvl,
-- result} is the canonical pair chart (same table Ivaar's Skillchains
-- addon ships). A formed chain replaces the active element with its
-- result so lvl-2/3 continuations work; the numeric part of each SC
-- row is the chain's burst elements for the MB readout.
local SC = {
    Radiance      = { 'Fire', 'Wind', 'Lightning', 'Light', lvl = 4 },
    Umbra         = { 'Earth', 'Ice', 'Water', 'Dark', lvl = 4 },
    Light         = { 'Fire', 'Wind', 'Lightning', 'Light',
        Light = { 4, 'Light', 'Radiance' }, lvl = 3 },
    Darkness      = { 'Earth', 'Ice', 'Water', 'Dark',
        Darkness = { 4, 'Darkness', 'Umbra' }, lvl = 3 },
    Gravitation   = { 'Earth', 'Dark',
        Distortion = { 3, 'Darkness' },
        Fragmentation = { 2, 'Fragmentation' }, lvl = 2 },
    Fragmentation = { 'Wind', 'Lightning',
        Fusion = { 3, 'Light' }, Distortion = { 2, 'Distortion' }, lvl = 2 },
    Distortion    = { 'Ice', 'Water',
        Gravitation = { 3, 'Darkness' }, Fusion = { 2, 'Fusion' }, lvl = 2 },
    Fusion        = { 'Fire', 'Light',
        Fragmentation = { 3, 'Light' }, Gravitation = { 2, 'Gravitation' },
        lvl = 2 },
    Compression   = { 'Darkness',
        Transfixion = { 1, 'Transfixion' }, Detonation = { 1, 'Detonation' },
        lvl = 1 },
    Liquefaction  = { 'Fire',
        Impaction = { 2, 'Fusion' }, Scission = { 1, 'Scission' }, lvl = 1 },
    Induration    = { 'Ice',
        Reverberation = { 2, 'Fragmentation' },
        Compression = { 1, 'Compression' }, Impaction = { 1, 'Impaction' },
        lvl = 1 },
    Reverberation = { 'Water',
        Induration = { 1, 'Induration' }, Impaction = { 1, 'Impaction' },
        lvl = 1 },
    Transfixion   = { 'Light',
        Scission = { 2, 'Distortion' }, Reverberation = { 1, 'Reverberation' },
        Compression = { 1, 'Compression' }, lvl = 1 },
    Scission      = { 'Earth',
        Liquefaction = { 1, 'Liquefaction' },
        Reverberation = { 1, 'Reverberation' },
        Detonation = { 1, 'Detonation' }, lvl = 1 },
    Detonation    = { 'Wind',
        Compression = { 2, 'Gravitation' }, Scission = { 1, 'Scission' },
        lvl = 1 },
    Impaction     = { 'Lightning',
        Liquefaction = { 1, 'Liquefaction' }, Detonation = { 1, 'Detonation' },
        lvl = 1 },
}
-- timing windows (seconds) — tunable, retail figures are fuzzy: a
-- follow-up WS chains ~3-10s after the last WS in the chain; the
-- magic-burst window is the ~8s after a formed chain
local SC_OPEN, SC_CLOSE, MB_WINDOW = 3.0, 10.0, 8.0
local chains = {}   -- target key (wire ix / packed core) -> chain rec
local sc_hist = {}  -- last 8 WS events {an, ws, sc, tg, t}

local function ws_props_for(ws_id, an)
    -- cat-3 param id space depends on the actor: players send
    -- weapon_skills ids, trusts/mobs send monster_abilities ids (a trust
    -- WS like Uriel Blade would otherwise alias onto an unrelated
    -- player WS name — it mapped to Heavy Shot). Prefer the right
    -- table by actor; either way fall back across both.
    local trust = an and trust_role(an)
    local order = trust and { 'monster_abilities', 'weapon_skills' }
        or { 'weapon_skills', 'monster_abilities' }
    for _, tbl in ipairs(order) do
        local ws = ctx.res[tbl] and ctx.res[tbl][ws_id]
        if ws then
            local props = {}
            for _, f in ipairs({ 'skillchain_a', 'skillchain_b', 'skillchain_c' }) do
                local p = ws[f]
                if type(p) == 'string' and SC[p] then props[#props + 1] = p end
            end
            return ws, (#props > 0 and props or nil)
        end
    end
end

local function sc_form(elems, props)
    for _, first in ipairs(elems) do
        local combo = SC[first]
        for _, second in ipairs(props) do
            local r = combo and combo[second]
            if r then return r[1], r[2] end
        end
    end
end

local function sc_on_ws(actor, ws_id, tg, now)
    local an = actor_name(actor)
    local ws, props = ws_props_for(ws_id, an)
    if not ws then return end -- unresolved id / mob move
    local tkey = 't'
    if tg and tg ~= 0 then
        tkey = tostring(wire_ix(tg) or ('x' .. rshift(tg, 8)))
    end
    local ch = chains[tkey]
    local lvl, formed
    if ch and now >= ch.open and now <= ch.close and props then
        lvl, formed = sc_form(ch.elems, props)
    end
    local tgn = tg and tg ~= 0 and actor_name(tg) or nil
    -- resolved index + packed id core — lets the poll drop the chain
    -- the moment the mob dies or despawns instead of waiting out the
    -- window
    local tix = tg and tg ~= 0 and wire_ix(tg) or nil
    local tid = tg and tg ~= 0 and (tg % 0x1000000) or nil
    if formed then
        chains[tkey] = {
            elems = { formed }, lvl = lvl, n = formed,
            an = an, w = ws.en, tg = tgn, tix = tix, tid = tid, t0 = now,
            open = now + SC_OPEN, close = now + SC_CLOSE,
            burst = now + MB_WINDOW,
        }
    elseif props then
        -- nothing chained — this WS's own props take over as the new
        -- root, overriding whatever was on the target
        chains[tkey] = {
            elems = props, lvl = 0, n = ws.en,
            an = an, w = ws.en, tg = tgn, tix = tix, tid = tid, t0 = now,
            open = now + SC_OPEN, close = now + SC_CLOSE,
        }
    else
        -- a WS with no chainable props ruins the chain outright —
        -- clear it rather than leave a stale entry
        chains[tkey] = nil
    end
    sc_hist[#sc_hist + 1] = {
        an = an, ws = ws.en, sc = formed, tg = tgn,
        t = unix_now(),
    }
    if #sc_hist > 8 then table.remove(sc_hist, 1) end
end

local function sc_json(nowc)
    local list = {}
    for k, ch in pairs(chains) do
        -- liveness: a mapped target that despawns, dies (hpp 0), or
        -- gets its index recycled by a different mob voids the chain
        local dead = false
        if ch.tix then
            local okm, m = pcall(plat.ffxi.get_mob_by_index, ch.tix)
            if not okm or type(m) ~= 'table'
                or (ch.tid and m.id and (m.id % 0x1000000) ~= ch.tid)
                or (m.hpp ~= nil and m.hpp <= 0) then
                dead = true
            end
        end
        if dead or ch.close <= nowc then
            chains[k] = nil
        else
            list[#list + 1] = {
                e = ctx.json_array(ch.elems), lv = ch.lvl, n = ch.n,
                an = ch.an, w = ch.w, tg = ch.tg,
                t = unix_now() + (ch.t0 - nowc),
                o = unix_now() + (ch.open - nowc),
                c = unix_now() + (ch.close - nowc),
                b = ch.burst and (unix_now() + (ch.burst - nowc)) or nil,
            }
        end
    end
    -- weapon skills the current equipment allows — the view filters
    -- them into roots (no window) or chain continuations (open window)
    local ws
    local okab, ab = pcall(plat.ffxi.get_abilities)
    if okab and type(ab) == 'table' and type(ab.weapon_skills) == 'table' then
        ws = {}
        for _, id in ipairs(ab.weapon_skills) do
            local w, props = ws_props_for(id)
            if w and props then
                ws[#ws + 1] = { i = id, n = w.en, p = ctx.json_array(props) }
            end
        end
        table.sort(ws, function(x, y) return x.n < y.n end)
    end
    if #list == 0 and #sc_hist == 0 and not ws then return nil end
    return {
        c = ctx.json_array(list),
        h = ctx.json_array(sc_hist),
        ws = ws and ctx.json_array(ws) or nil,
    }
end

local function scan(now)
    local ok, info = pcall(plat.ffxi.get_info)
    local my_zone = (ok and type(info) == 'table' and info.zone) or 0

    local s = { on = 1, p = ctx.json_array({}), a1 = ctx.json_array({}), a2 = ctx.json_array({}) }
    local okp, party = pcall(plat.ffxi.get_party)
    if okp and type(party) == 'table' then
        local leaders = {}
        for gi, key in ipairs({ 'p0', 'a10', 'a20' }) do
            local lid = party[('party%d_leader'):format(gi)]
            if lid then leaders[key] = lid end
        end
        local groups = { s.p, s.a1, s.a2 }
        for gi, keys in ipairs(MEMBER_KEYS) do
            for _, key in ipairs(keys) do
                local m = party[key]
                if type(m) == 'table' and m.name then
                    local row = member_row(key, m, my_zone, leaders)
                    row.l = (row.l and leaders[key] == member_id(m)) and 1 or nil
                    groups[gi][#groups[gi] + 1] = row
                end
            end
        end
    end

    -- current target + whatever it's casting; the tracked cast also
    -- rides at top level so /api/party shows whether casts are seen at
    -- all (actor id vs the target struct is the failure mode to spot)
    -- prune expired casts so finished recs can't leak into the map
    local nowc = os.clock()
    for k, v in pairs(casts) do
        if v.t1 <= nowc then
            casts[k] = nil
            if cast == v then cast = nil end
        end
    end
    local c = cast_now()
    s.cast = c
    s.sc = sc_json(nowc)
    local okm, me = pcall(plat.ffxi.get_mob_by_target, 'me')
    if okm and type(me) == 'table' then
        s.me = me.id
        me_ix = me.index
        dbg_me = me.id
        dbg_mn = me.name
        -- self never emits a 0x00D — seed the packed-space map so own
        -- casts resolve actor_ix == me_ix like any other entity
        if me.index and me.id then wire24[me.id % 0x1000000] = me.index end
        -- id space mismatch kills c.a == me.id the same way it kills
        -- the target match — the low 12 bits (zone index) are the
        -- part that's guaranteed to agree
        if c and not c.own then
            local wix = wire_ix(c.a)
            c.own = (c.a == me.id
                or rshift(c.a, 8) == (me.id % 0x1000000)
                or (wix and wix == me.index)
                or (me.index and wire_r[me.index] == c.a)
                or (me.index and c.a % 0x1000 == me.index)) and 1 or nil
        end
    end
    local okt, t = pcall(plat.ffxi.get_mob_by_target, 't')
    if okt and type(t) == 'table' then
        -- live: get_mob_by_target('t').id sits in a different id space
        -- than the 0x028 actor field (t.i=0x010B.. vs cast.a=0x0BE0..)
        -- — resolve through the mob array via index; its .id is the
        -- wire-space id the packets actually carry
        local mi
        if t.index then
            local oki, m = pcall(plat.ffxi.get_mob_by_index, t.index)
            mi = oki and type(m) == 'table' and m or nil
        end
        dbg_t = { i = t.id, ix = t.index, n = t.name, mi = mi and mi.id }
        -- dump the mob-array entry's fields once so dbg shows which
        -- field (if any) holds the wire-space actor id
        if mi and not dbg_mi then
            dbg_mi = {}
            for k, v in pairs(mi) do
                dbg_mi[tostring(k)] = type(v) ~= 'table'
                    and tostring(v) or '…'
            end
        end
        -- target's cast: map lookup on the same entity key actors are
        -- stored under — wire index when mapped, else the packed 24-bit
        -- core — then a name sweep for actors nothing resolves
        local tk = (t.index and casts[t.index])
            or casts['x' .. (t.id % 0x1000000)]
        local tc = tk
        if not tc and t.name then
            for _, v in pairs(casts) do
                if v.an and v.an == t.name then tc = v break end
            end
        end
        -- claim status: 0 unclaimed, 1 self, 2 party, 3 someone else's.
        -- claim_id is full-server-id space; packed 24-bit cores compare
        local cl = 0
        local claim_id = (mi and mi.claim_id) or t.claim_id
        if claim_id and claim_id ~= 0 then
            local cid = claim_id % 0x1000000
            if me and me.id and cid == me.id % 0x1000000 then
                cl = 1
            else
                for _, m in pairs(new_members) do
                    if m.id == cid then cl = 2 break end
                end
                if cl == 0 then cl = 3 end
            end
        end
        s.t = {
            i = t.id, n = t.name or '',
            hpp = t.hpp, tp = t.tp, cl = cl,
            cast = tc and rec_json(tc) or nil,
        }
    end
    return s
end

function M.poll()
    if not ctx then return end
    poll_n = poll_n + 1
    if poll_n % 15 ~= 0 then return end -- ~4Hz off the pump
    if not ctx.logged_in() then
        if last_payload then
            last_payload = nil
            ctx.sse_broadcast('party', '{"on":0}')
        end
        return
    end
    if dur_dirty then
        dur_dirty = false
        local okp, errp = pcall(persist_windups)
        if not okp then print('party windups persist: ' .. tostring(errp)) end
    end
    local s = scan(os.clock())
    local payload = ctx.json.encode(s)
    if payload ~= last_payload then
        last_payload = payload
        ctx.sse_broadcast('party', payload)
    end
end

function M.handle_incoming(id, data)
    if not ctx or type(data) ~= 'string' then return end

    -- party member buffs: five 48-byte blocks @4 (local player absent —
    -- her list comes from get_player().buffs)
    if id == 0x076 and #data >= 4 + 48 then
        for k = 0, 4 do
            local base = 4 + k * 48
            if base + 48 > #data then break end
            local pid = data:byte(base + 1)
                + data:byte(base + 2) * 256
                + data:byte(base + 3) * 65536
                + data:byte(base + 4) * 16777216
            if pid ~= 0 then
                local list = {}
                for i = 1, 32 do
                    local lo = data:byte(base + 16 + i) or 0
                    local hb = data:byte(base + 8 + math.floor((i - 1) / 4) + 1) or 0
                    local hi = math.floor(hb / (4 ^ ((i - 1) % 4))) % 4
                    list[i] = lo + 256 * hi
                end
                member_buffs[pid] = list
            end
        end
        return
    end

    -- job feed: 0x0DD party-member update carries job/levels + name;
    -- 0x0DF char update carries the same fields (id-keyed only)
    if id == 0x0DD and #data >= 41 then
        local e = {
            j = data:byte(35), jl = data:byte(36),
            sj = data:byte(37), sjl = data:byte(38),
        }
        local pid = u32(data, 5)
        if pid ~= 0 then member_jobs[pid] = e end
        local name = data:sub(41):match('^([^%z]*)')
        if name ~= '' then member_jobs_name[name] = e end
        return
    end
    if id == 0x0DF and #data >= 37 then
        local pid = u32(data, 5)
        if pid ~= 0 then
            member_jobs[pid] = {
                j = data:byte(33), jl = data:byte(34),
                sj = data:byte(35), sjl = data:byte(36),
            }
        end
        return
    end

    -- entity updates (0x00E npc/mob, 0x00D pc): u32 id @0x04 + u16
    -- index @0x08 — the bridge between wire-space actor ids and the
    -- index space get_mob_by_index/get_mob_by_target('t').index use
    if (id == 0x00E or id == 0x00D) and #data >= 10 then
        local wid = data:byte(5) + data:byte(6) * 256
            + data:byte(7) * 65536 + data:byte(8) * 16777216
        local ix = data:byte(9) + data:byte(10) * 256
        wire[wid] = ix
        wire_r[ix] = wid
        wire24[wid % 0x1000000] = ix
        wire_seen = wire_seen + 1
        wire_sample[#wire_sample + 1] = { w = wid, ix = ix }
        if #wire_sample > 8 then table.remove(wire_sample, 1) end
        return
    end

    -- action packet: category 8/7 starts a cast on the actor; a later
    -- action from the same actor (any category) ends it
    if id == 0x028 and #data >= 20 then
        local actor = data:byte(5) + data:byte(6) * 256
            + data:byte(7) * 65536 + data:byte(8) * 16777216
        local cat = bits(data, 82, 4)
        action_seen = action_seen + 1
        -- an = who the actor resolved to at packet time; lx = the wire id
        -- registered for the index the actor's low 12 bits claim (probes
        -- whether this server's 0x028 actor space still ends in the zone
        -- index); tg = first listed target's id (bit 150 per the 0x028
        -- layout) — a mob's cast usually aims at a player/party id
        action_log[#action_log + 1] = {
            c = cat, a = actor, w = wire_ix(actor),
            p = bits(data, 86, 16), s = bits(data, 213, 17),
            tg = bits(data, 150, 32),
            an = actor_name(actor),
            lx = wire_r[actor % 0x1000],
        }
        if #action_log > 8 then table.remove(action_log, 1) end
        if cat == 8 or cat == 7 then
            -- ownness: a packed actor that resolves to a mapped entity
            -- is whoever that entity is (packed ids were ALWAYS unmapped
            -- before wire24 existed, so every cast within 1.5s of a
            -- player action got suppressed as "own"); only a truly
            -- unmapped actor falls back on the post-action timing window
            local aix = wire_ix(actor)
            local is_own
            if aix then
                is_own = me_ix ~= nil and aix == me_ix
            else
                is_own = os.clock() < own_until
                if is_own and me_ix then
                    wire[actor] = me_ix
                    wire_r[me_ix] = actor
                    wire24[rshift(actor, 8)] = me_ix
                end
            end
            local spell_id = bits(data, 213, 17) -- first action's param
            if spell_id == 0 then spell_id = bits(data, 86, 16) end
            -- duration: a learned observation wins — NM/mob moves keep
            -- their own timing and res.spells' cast_time (or the BLU
            -- spell the move's id aliases) overshoots the real windup;
            -- then res.spells, then the packet's recast field (it read
            -- 30 ticks for Stone live — 0.5s, a flash bar), then 2s
            local ticks = bits(data, 118, 32)
            local an = actor_name(actor)
            local n = action_name(cat, spell_id) or '…'
            local sp = ctx.res.spells and ctx.res.spells[spell_id]
            local dur = (an and dur_learned[an .. '|' .. n])
                or dur_learned['*|' .. n]
                or (sp and sp.cast_time)
                or (ticks > 0 and ticks < 3600 and ticks / 60) or 2
            local t0 = os.clock()
            local rec = {
                actor = actor, cat = cat,
                own = is_own or nil,
                an = an, n = n, dur = dur, t0 = t0, t1 = t0 + dur,
            }
            casts[actor_key(actor)] = rec
            cast = rec -- latest cast rides top-level s.cast
        elseif cat == 3 then
            -- weaponskill finish — feeds the skillchain tracker AND
            -- still ends any cast this actor had in progress. The WS id
            -- is the header param (bit 86); bit 213 is the first TARGET
            -- action's param (damage) — reading it first mislabels WSs
            local ws_id = bits(data, 86, 16)
            if not ws_props_for(ws_id, actor_name(actor)) then
                ws_id = bits(data, 213, 17)
            end
            sc_on_ws(actor, ws_id, bits(data, 150, 32), os.clock())
        end
        if cat ~= 8 and cat ~= 7 then
            -- ender: the packed flag byte varies by packet category
            -- (start 0x1f vs finish 0x2e/0x4d live) so key on the
            -- entity, not the raw id; the sweep catches recs keyed
            -- before the wire map saw the actor
            local k = actor_key(actor)
            local prev = casts[k]
            if not prev then
                for kk, v in pairs(casts) do
                    if rshift(v.actor, 8) == rshift(actor, 8) then
                        prev = v; k = kk; break
                    end
                end
            end
            -- cast over: the observed windup is t0->now. Only learn
            -- real "finished" cats (3 ws / 4 spell / 11 mob move) —
            -- melee/JA endings are interrupts, not the move's timing
            if prev then
                local act = os.clock() - prev.t0
                dur_log[#dur_log + 1] = {
                    an = prev.an, n = prev.n,
                    e = math.floor(prev.dur * 100 + 0.5) / 100,
                    a = math.floor(act * 100 + 0.5) / 100,
                    c = cat,
                }
                if #dur_log > 12 then table.remove(dur_log, 1) end
                if (cat == 3 or cat == 4 or cat == 11)
                    and act > 0.1 and act < 30 then
                    local learned = math.floor(act * 10 + 0.5) / 10
                    if prev.an then
                        dur_learned[prev.an .. '|' .. prev.n] = learned
                        dur_dirty = true
                    end
                    if prev.cat == 7 then
                        dur_learned['*|' .. prev.n] = learned
                        dur_dirty = true
                    end
                end
                casts[k] = nil
                if cast == prev then cast = nil end
            end
        end
    end
end

-- outgoing 0x01A = the player issued an action (cast/ws): a cat-8/7
-- from an unmapped wire id right after is almost certainly our own
-- cast — self-learn it into the wire map so it flags `own`
function M.handle_outgoing(id, data)
    if id == 0x01A then
        out_seen = out_seen + 1
        own_until = os.clock() + 1.5
    end
end

function M.snapshot_json()
    return last_payload or '{"on":0}'
end

-- what the action-packet handler observed — for live debugging of cast
-- tracking (GET /api/party/dbg after a fight)
function M.dbg_json()
    local out = {
        ac = action_seen, log = ctx.json_array(action_log), cast = cast_now(),
        t = dbg_t, me = dbg_me, pn = dbg_mn,
        wc = wire_seen, ws = ctx.json_array(wire_sample), mif = dbg_mi,
        oc = out_seen, ou = math.max(0, own_until - os.clock()),
        dl = ctx.json_array(dur_log), lk = dur_learned,
    }
    local ok, enc = pcall(ctx.json.encode, out)
    return ok and enc or '{"ac":0}'
end

function M.reset()
    member_buffs = {}
    member_jobs = {}
    member_jobs_name = {}
    wire = {}
    wire_r = {}
    cast = nil
    casts = {}
    last_payload = nil
    wire24 = {}
    dur_log = {}
    chains = {}
    sc_hist = {}
    -- dur_learned survives: it's name-keyed, still valid across relog
end

return M
