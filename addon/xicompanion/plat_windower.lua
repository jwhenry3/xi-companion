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

-- native memory primitives — vendored _WindowerMemory.dll (pin in
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

-- os.execute goes through cmd /c — its console host window flashes and
-- steals the game's focus on every call. ShellExecuteW never touches a
-- console: SW_SHOWNA (8) for app launches, SW_HIDE (0) for console
-- tools like taskkill. Returns false when the sandbox has no ffi —
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

-- plat.spawn(file[, params[, hide]]) — console-free process launch.
-- Returns false when ffi is unavailable; callers fall back to
-- os.execute (brief console flash, same as before).
function P.spawn(file, params, hide)
    if not shell_exec then return false end
    return shell_exec(file, params, hide and 0 or 8)
end

-- plat.kill_image(name) — terminate processes by image name WITHOUT
-- spawning taskkill.exe (a console app whose conhost window flashes
-- even under SW_HIDE). Walks the Toolhelp snapshot and
-- TerminateProcess()es directly. Returns false when ffi is missing or
-- no match was found — callers fall back to os.execute taskkill.
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

return P
