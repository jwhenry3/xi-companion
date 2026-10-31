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

-- native memory primitives  -  vendored _WindowerMemory.dll (pin in
-- libs/windowermemory.json). Optional: P.memory is nil when the dll
-- can't load, so every caller must tolerate its absence.
do
    local ok, mem = pcall(function()
        package.cpath = package.cpath .. ';' ..
            (P.addon_path:gsub('\\', '/') .. 'libs/?.dll')
        return require('_WindowerMemory')
    end)
    if ok then P.memory = mem end
end

-- {name -> stamp} for files matching a glob  -  the client rewrites
-- mcr.sys + the departing palette on every in-game book/page switch.
-- Content-Hashed rather than mtime'd: forfiles/io.popen spawns a
-- console window per call  -  visible flash + focus flicker at poll rate.
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
                -- cheap content stamp: length + a rolling byte mix  - 
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

-- game reads  -  the subset used across the addon: get_player,
-- get_items, get_bag_info, get_info, get_ability_recasts,
-- get_spell_recasts, get_mob_by_target, get_mob_by_index,
-- get_mob_array, get_map_data, drop_item.
P.ffxi = windower.ffxi

P.send_command = windower.send_command
P.open_url     = windower.open_url
P.add_to_chat  = windower.add_to_chat

P.on = windower.register_event

-- keyboard hook  -  fn(dik, down, flags, blocked); return true to
-- block the key before the client sees it
P.on_key = function(fn) return P.on('keyboard', fn) end

-- os.execute goes through cmd /c  -  its console host window flashes and
-- steals the game's focus on every call. ShellExecuteW never touches a
-- console: SW_SHOWNA (8) for app launches, SW_HIDE (0) for console
-- tools like taskkill. Returns false when the sandbox has no ffi  - 
-- callers keep their os.execute lines as the fallback.
local shell_exec
do
    local ok, ffi = pcall(require, 'ffi')
    if ok then
        ok = pcall(ffi.cdef, [[
            typedef const wchar_t* LPCWSTR;
            intptr_t ShellExecuteW(void* hwnd, LPCWSTR verb, LPCWSTR file,
                LPCWSTR params, LPCWSTR dir, int show);
        ]])
        if ok then
            local ok2, shell32 = pcall(ffi.load, 'shell32.dll')
            if ok2 then
                local function wstr(s)
                    local b = ffi.new('uint16_t[?]', #s + 1)
                    for i = 1, #s do b[i - 1] = s:byte(i) end
                    return b
                end
                shell_exec = function(file, params, show)
                    local okc, r = pcall(shell32.ShellExecuteW,
                        nil, nil, wstr(file),
                        params and wstr(params) or nil, nil, show)
                    return okc and tonumber(r) > 32
                end
            end
        end
    end
end

-- plat.spawn(file[, params[, hide]])  -  console-free process launch.
-- Returns false when ffi is unavailable; callers fall back to
-- os.execute (brief console flash, same as before).
function P.spawn(file, params, hide)
    if not shell_exec then return false end
    return shell_exec(file, params, hide and 0 or 8)
end

-- plat.kill_image(name)  -  terminate processes by image name WITHOUT
-- spawning taskkill.exe (a console app whose conhost window flashes
-- even under SW_HIDE). Walks the Toolhelp snapshot and
-- TerminateProcess()es directly. Returns false when ffi is missing or
-- no match was found  -  callers fall back to os.execute taskkill.
local kill_image
do
    local ok, ffi = pcall(require, 'ffi')
    if ok then
        local okc = pcall(ffi.cdef, [[
            typedef struct {
                unsigned long dwSize, cntUsage, th32ProcessID;
                uintptr_t th32DefaultHeapID, th32ModuleID;
                unsigned long cntThreads, th32ParentProcessID;
                long pcPriClassBase;
                unsigned long dwFlags;
                wchar_t szExeFile[260];
            } PROCESSENTRY32W;
            void* CreateToolhelp32Snapshot(unsigned long, unsigned long);
            int Process32FirstW(void*, PROCESSENTRY32W*);
            int Process32NextW(void*, PROCESSENTRY32W*);
            void* OpenProcess(unsigned long, int, unsigned long);
            int TerminateProcess(void*, unsigned int);
            int CloseHandle(void*);
        ]])
        local ok2, k32 = pcall(ffi.load, 'kernel32.dll')
        if okc and ok2 then
            kill_image = function(name)
                local snap = k32.CreateToolhelp32Snapshot(2, 0)
                if snap == nil or tonumber(ffi.cast('intptr_t', snap)) == -1 then
                    return false
                end
                local pe = ffi.new('PROCESSENTRY32W')
                pe.dwSize = ffi.sizeof(pe)
                local lower = name:lower()
                local killed = false
                if k32.Process32FirstW(snap, pe) ~= 0 then
                    repeat
                        local b = {}
                        for i = 0, 259 do
                            local c = tonumber(pe.szExeFile[i])
                            if c == 0 then break end
                            b[#b + 1] = string.char(c)
                        end
                        if table.concat(b):lower() == lower then
                            local h = k32.OpenProcess(0x0001, 0,
                                pe.th32ProcessID)
                            if h ~= nil and tonumber(ffi.cast('intptr_t', h)) ~= 0 then
                                k32.TerminateProcess(h, 1)
                                k32.CloseHandle(h)
                                killed = true
                            end
                        end
                    until k32.Process32NextW(snap, pe) == 0
                end
                k32.CloseHandle(snap)
                return killed
            end
        end
    end
end

function P.kill_image(name)
    if not kill_image then return false end
    return kill_image(name)
end

-- plat.pid()  -  this pol.exe process id. Identifies the instance for
-- pipe names + mailbox dirs when multiboxing (xport.lua).
local get_pid

-- plat.pipe_open(name)  -  named-pipe CLIENT for the overlay's
-- \\.\pipe\xicompanion.<pid> server. PIPE_NOWAIT: read() drains
-- whatever is buffered without blocking the frame, write() fails
-- fast when the pipe buffer is full so callers can queue + retry on
-- the next pump. Returns nil,err until the server exists.
local pipe_lib, pipe_lib_err
do
    -- 'ffi' is LuaJIT's builtin; a cffi-lua shim (libs/cffi.dll)
    -- exposes the same API for stock-Lua hosts like this one
    local ok, ffi = pcall(require, 'ffi')
    if not ok then
        ok, ffi = pcall(require, 'cffi')
    end
    if not ok then
        pipe_lib_err = 'require ffi: ' .. tostring(ffi)
    else
        local okc, errc = pcall(ffi.cdef, [[
            unsigned long GetCurrentProcessId(void);
            void* CreateFileW(const wchar_t*, unsigned long, unsigned long,
                void*, unsigned long, unsigned long, void*);
            int SetNamedPipeHandleState(void*, unsigned long*,
                unsigned long*, unsigned long*);
            int PeekNamedPipe(void*, void*, unsigned long,
                unsigned long*, unsigned long*, unsigned long*);
            int ReadFile(void*, void*, unsigned long,
                unsigned long*, void*);
            int WriteFile(void*, const void*, unsigned long,
                unsigned long*, void*);
            int CloseHandle(void*);
        ]])
        if not okc then
            pipe_lib_err = 'cdef: ' .. tostring(errc)
        else
            local ok2, k32 = pcall(ffi.load, 'kernel32.dll')
            if ok2 then
                pipe_lib = { ffi = ffi, k32 = k32 }
            else
                pipe_lib_err = 'load kernel32: ' .. tostring(k32)
            end
        end
    end
end

-- why pipe_open/pid are nil when they are  -  surfaced by xport
function P.pipe_err()
    return pipe_lib_err
end

if pipe_lib then
    local ffi, k32 = pipe_lib.ffi, pipe_lib.k32

    get_pid = function()
        return tonumber(k32.GetCurrentProcessId())
    end

    local function wstr(s)
        local b = ffi.new('uint16_t[?]', #s + 1)
        for i = 1, #s do b[i - 1] = s:byte(i) end
        return b
    end

    local rbuf = ffi.new('uint8_t[?]', 262144)
    local dw = ffi.new('unsigned long[1]')
    local dw2 = ffi.new('unsigned long[1]')
    -- PIPE_NOWAIT on the client handle  -  byte-mode stays the default
    local NOWAIT = ffi.new('unsigned long[1]', 1)

    function P.pipe_open(name)
        local h = k32.CreateFileW(wstr('\\\\.\\pipe\\' .. name),
            0xC0000000 --[[GENERIC_READ|WRITE]], 0, nil,
            3 --[[OPEN_EXISTING]], 0, nil)
        if h == nil or tonumber(ffi.cast('intptr_t', h)) == -1 then
            return nil, tonumber(ffi.errno())
        end
        if k32.SetNamedPipeHandleState(h, NOWAIT, nil, nil) == 0 then
            k32.CloseHandle(h)
            return nil, 'nowait'
        end
        local p = { h = h, dead = false }
        -- concatenated bytes since last call, or nil when empty/dead
        function p.read()
            if p.dead then return nil end
            local parts = nil
            while true do
                -- PeekNamedPipe(h, buf, size, read, avail, left)
                if k32.PeekNamedPipe(h, nil, 0, nil, nil, dw, nil) == 0 then
                    p.dead = true
                    return nil
                end
                local avail = tonumber(dw[0])
                if avail == 0 then break end
                if avail > 262144 then avail = 262144 end
                if k32.ReadFile(h, rbuf, avail, dw2, nil) == 0 then
                    p.dead = true
                    return nil
                end
                parts = parts or {}
                parts[#parts + 1] = ffi.string(rbuf, tonumber(dw2[0]))
                if tonumber(dw2[0]) < avail then break end
            end
            return parts and table.concat(parts) or nil
        end
        -- returns the new offset (>= off) or nil on a dead pipe; an
        -- unchanged offset means "no buffer room  -  retry next pump"
        function p.write(data, off)
            if p.dead then return nil end
            off = off or 1
            local n = #data - off + 1
            if n <= 0 then return off end
            local ptr = ffi.cast('const uint8_t*', data) + (off - 1)
            if k32.WriteFile(h, ptr, n, dw2, nil) == 0 then
                -- a failed Peek probes whether the other end is gone;
                -- a live-but-full pipe just retries next pump
                if k32.PeekNamedPipe(h, nil, 0, nil, nil, dw, nil) == 0 then
                    p.dead = true
                    return nil
                end
                return off
            end
            return off + tonumber(dw2[0])
        end
        function p.close()
            if p.h then
                pcall(k32.CloseHandle, p.h)
                p.h = nil
            end
            p.dead = true
        end
        return p
    end
end

function P.pid()
    return get_pid and get_pid() or 0
end

return P
