-- recasts.lua: ability + spell cooldowns for the detached /cooldowns
-- window. windower.ffxi.get_ability_recasts()/get_spell_recasts() expose
-- remaining seconds keyed by recast_id / spell_id; the client never tells
-- us the FULL recast for abilities, so `maxes` remembers the largest
-- remaining each key has shown (first sighting is the post-use full
-- cooldown unless the addon loads mid-recast — it converges on next use).
-- spells get res.spells[id].recast as a floor for the max.
--
-- polled from pump() every frame; remaining is rounded to 0.1s so the
-- payload diff (and therefore the `recasts` SSE broadcast) only changes
-- ~10x/sec while a cooldown is running — an idle player costs nothing.
local M = {}
local ctx

local maxes = {}
local last_payload = nil -- last json we broadcast/snapshotted

function M.setup(deps)
    ctx = deps
end

local function scan()
    -- json_array marks the table so an empty list encodes as [] — a bare
    -- {} would arrive as an object and break .map in the view
    local out = ctx.json_array and ctx.json_array({}) or {}
    local res = ctx.res or {}
    local ok, abil = pcall(windower.ffxi.get_ability_recasts)
    if ok and type(abil) == 'table' then
        for rid, secs in pairs(abil) do
            secs = tonumber(secs) or 0
            if secs > 0.05 then
                local meta = res.ability_recasts and res.ability_recasts[rid]
                local name = meta and meta.en
                if not name and meta and meta.action_id then
                    local ab = res.job_abilities and res.job_abilities[meta.action_id]
                    name = ab and ab.en
                end
                local k = 'a' .. tostring(rid)
                if secs > (maxes[k] or 0) then maxes[k] = secs end
                out[#out + 1] = {
                    k = k, t = 'a',
                    n = name or ('Recast ' .. tostring(rid)),
                    r = secs, m = maxes[k],
                }
            end
        end
    end
    local ok2, spl = pcall(windower.ffxi.get_spell_recasts)
    if ok2 and type(spl) == 'table' then
        for sid, secs in pairs(spl) do
            secs = tonumber(secs) or 0
            if secs > 0.05 then
                local meta = res.spells and res.spells[sid]
                local k = 's' .. tostring(sid)
                local hint = meta and tonumber(meta.recast) or 0
                if secs > (maxes[k] or 0) then maxes[k] = secs end
                if hint > (maxes[k] or 0) then maxes[k] = hint end
                out[#out + 1] = {
                    k = k, t = 's',
                    n = (meta and meta.en) or ('Spell ' .. tostring(sid)),
                    r = secs, m = maxes[k],
                }
            end
        end
    end
    table.sort(out, function(a, b)
        if a.n ~= b.n then return a.n < b.n end
        return a.k < b.k
    end)
    return out
end

-- scan + diff -> SSE broadcast. No time throttle: the round-to-0.1s
-- means the payload only changes when a tenth ticks by, so broadcasting
-- is naturally rate-limited by the diff.
function M.poll()
    if not ctx then return end
    if not ctx.logged_in() then
        if last_payload then
            last_payload = nil
            ctx.sse_broadcast('recasts', '{"list":[]}')
        end
        return
    end
    local list = scan()
    for _, e in ipairs(list) do e.r = math.floor(e.r * 10 + 0.5) / 10 end
    local payload = ctx.json.encode({ list = list })
    if payload ~= last_payload then
        last_payload = payload
        ctx.sse_broadcast('recasts', payload)
    end
end

function M.snapshot_json()
    return last_payload or '{"list":[]}'
end

-- logout/reload: drop the cooldown memory too (job change calls it as
-- well — recast ids are reused across jobs, so a stale max skews bars)
function M.reset()
    maxes = {}
    last_payload = nil
end

return M
