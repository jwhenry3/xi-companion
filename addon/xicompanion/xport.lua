--[[
    xport.lua  -  the overlay's JS<->Lua backend: a file mailbox under
    data/ipc/<inst>/. The overlay writes in/q-<seq>.json requests, the
    addon consumes + deletes them and batches outbound messages into
    out/m-<seq>.jsonl (one JSON object per line, atomic tmp+rename).
    The socket server is unaffected — it remains the browser surface.

    Always on: with no overlay watching, out/ files are pruned past a
    small cap instead of growing forever.

    Message protocol (JSON objects):

      JS -> Lua   {t='req', id, method, path, headers?, body?}
                  {t='sub'}              request snapshot + live events
      Lua -> JS   {t='res', id, status, ctype, body, enc?='hex'}
                  {t='sse', e=<event>, d=<json payload>}
                  {t='ping'}             mailbox keepalive

    Deps injected by xicompanion.lua so this module stays dumb:
      dispatch(msg)         -  route a 'req'/'sub' message
      snapshot()            -  ordered {e=,d=} snapshot events
      json                  -  the byte-walk encoder
      json_decode           -  the byte-walk decoder
      inst()                -  per-instance key (pid or p<bound_port>)
]]

local M = {}

local dep = {}
local mb_inst = nil         -- instance key the mailbox dirs are bound to
local mb_seen = 0           -- os.time() of last inbound contact

-- outbound message queue  -  each entry one encoded JSON object (not
-- yet wire-framed). Capped so a dead host can't grow it forever.
local outq = {}
local OUTQ_MAX = 500

local function enqueue(tbl)
    if #outq >= OUTQ_MAX then
        table.remove(outq, 1) -- shed the oldest event, keep the tail live
    end
    outq[#outq + 1] = dep.json(tbl)
end

----------------------------------------------------------------------
-- Responses / events
----------------------------------------------------------------------

-- binary bodies (icons, map DATs) don't survive JSON  -  flag them hex
local function respond(conn, code, body, ctype)
    local msg = {
        t = 'res', id = conn.id, status = code,
        ctype = ctype or 'text/plain; charset=utf-8',
        body = body,
    }
    if type(body) == 'string' and body:find('[^\32-\126\n\r\t]') then
        msg.enc = 'hex'
        msg.body = (body:gsub('.', function(c)
            return string.format('%02x', c:byte())
        end))
    end
    enqueue(msg)
end

local function push_event(event, payload)
    enqueue({ t = 'sse', e = event, d = payload })
end

local function push_snapshot()
    for _, m in ipairs(dep.snapshot()) do
        push_event(m.e, m.d)
    end
end

----------------------------------------------------------------------
-- inbound dispatch
----------------------------------------------------------------------

local function on_message(tbl)
    if type(tbl) ~= 'table' then return end
    if tbl.t == 'sub' then
        push_snapshot()
    elseif tbl.t == 'req' then
        dep.dispatch(tbl)
    end
    -- 'ping'/'conn' carry nothing the Lua side needs
end

----------------------------------------------------------------------
-- mailbox pump  -  data/ipc/<inst>/{in,out}
----------------------------------------------------------------------

local mb_in, mb_out
local mb_seq = 0
local mb_ping = 0
local mb_scan_at = 0

-- a FindFirstFile per pump tick (~60fps) is wasted syscall on the game
-- frame — scan the inbound dir a few times a second instead
local MB_SCAN_INTERVAL = 0.25
-- out/ files a dead host leaves behind before oldest-first pruning.
-- Pings land every 10s, so 60 covers ~10 minutes of a wedged overlay.
local MB_OUT_CAP = 60

-- the instance key can settle late (bound_port isn't known until the
-- server binds)  -  re-resolve until it stops changing
local function ensure_mailbox()
    local inst = dep.inst()
    if inst == mb_inst then return end
    mb_inst = inst
    local base = dep.plat.addon_path .. 'data\\ipc'
    pcall(dep.plat.create_dir, base)
    base = base .. '\\' .. inst
    pcall(dep.plat.create_dir, base)
    mb_in = base .. '\\in'
    mb_out = base .. '\\out'
    pcall(dep.plat.create_dir, mb_in)
    pcall(dep.plat.create_dir, mb_out)
end

local function prune_out(names)
    local n = #names
    if n <= MB_OUT_CAP then return end
    table.sort(names)
    for i = 1, n - MB_OUT_CAP do
        os.remove(mb_out .. '\\' .. names[i])
    end
end

local function pump_mailbox()
    ensure_mailbox()

    -- inbound: consume every queued request file, oldest first
    local now = os.clock()
    if now - mb_scan_at >= MB_SCAN_INTERVAL then
        mb_scan_at = now
        local names = dep.plat.get_dir(mb_in)
        if type(names) == 'table' then
            table.sort(names)
            for _, name in ipairs(names) do
                if name:match('^q%-[%w%-]+%.json$') then
                    local path = mb_in .. '\\' .. name
                    local f = io.open(path, 'rb')
                    if f then
                        local body = f:read('*a')
                        f:close()
                        os.remove(path)
                        mb_seen = os.time()
                        local ok, msg = pcall(dep.json_decode, body)
                        if ok and msg then
                            local okd, errd = pcall(on_message, msg)
                            if not okd then
                                dep.log_err('xport msg: ' .. tostring(errd))
                            end
                        end
                    end
                end
            end
        end
    end

    -- keepalive so the host can tell a live mailbox from a dead one
    if os.time() - mb_ping >= 10 then
        mb_ping = os.time()
        enqueue({ t = 'ping' })
    end

    -- outbound: one tmp+rename file per pump, messages as json lines
    if #outq == 0 then return end
    mb_seq = mb_seq + 1
    local tmp = ('%s\\m-%06d.tmp'):format(mb_out, mb_seq)
    local f = io.open(tmp, 'wb')
    if not f then return end
    for _, s in ipairs(outq) do
        f:write(s, '\n')
    end
    f:close()
    outq = {}
    -- Windows rename fails when the target exists: a stale file from a
    -- dead session's matching seq number gets replaced instead
    local dst = ('%s\\m-%06d.jsonl'):format(mb_out, mb_seq)
    os.remove(dst)
    os.rename(tmp, dst)

    -- nobody drains out/ when the overlay is gone — keep the tail
    local names = dep.plat.get_dir(mb_out)
    if type(names) == 'table' then
        local batches = {}
        for _, name in ipairs(names) do
            if name:match('^m%-%d+%.jsonl$') then
                batches[#batches + 1] = name
            end
        end
        prune_out(batches)
    end
end

----------------------------------------------------------------------
-- lifecycle
----------------------------------------------------------------------

function M.pump()
    pump_mailbox()
end

function M.init(d)
    dep = d
end

M.respond = respond
M.push_event = push_event
M.push_snapshot = push_snapshot
M.active = function() return true end
M.connected = function() return os.time() - mb_seen < 30 end

return M
