--[[
    FFXI macro storage reader/writer.

    The client stores macros per-character under
        <ffxi>/USER/<content id>/mcr*.dat, mcr.ttl, mcr_2.ttl

    Format (verified against live retail files + community docs):

      header : u32 version (=1) + u32 unknown + 16-byte MD5 over every byte
               from offset 24 onward + 4 zero bytes  => 28 bytes
      record : 6 x 61-byte null-padded command lines
             + 8-byte null-padded name + padding
               19 records carry 6 pad bytes, the last carries 2 (file ends)
               => 28 + 19*380 + 376 = 7624 bytes
      ttl    : 24-byte header (ver+field+md5, no zero gap) + 20 x 16-byte titles
               mcr.ttl = books 1-20, mcr_2.ttl = books 21-40

      file index i (mcr.dat = 0, mcrN.dat = N):
        book    = i / 10 + 1
        palette = i % 10 + 1

    Command lines are byte strings (Shift_JIS on JP clients). Auto-translate
    phrases embed as 0xFD <type> <lang> <id lo> <id hi> 0xFD. Lines are exposed
    to the HTTP API as text with those phrases escaped to "[AT:xxxxxxxx]" and
    other non-printable bytes to "\xNN", so they round-trip losslessly.
]]

local plat = require('plat')
local M = {}

----------------------------------------------------------------------
-- Bit ops: LuaJIT's bit library in-game, Lua 5.3 natives under fengari.
-- The 5.3 fallback is compiled lazily so the syntax never reaches LuaJIT.
----------------------------------------------------------------------

local band, bor, bxor, bnot, lshift, rshift
do
    local ok, bit = pcall(require, 'bit')
    if ok and type(bit) == 'table' then
        band, bor, bxor, bnot, lshift, rshift =
            bit.band, bit.bor, bit.bxor, bit.bnot, bit.lshift, bit.rshift
    else
        band   = load('return function(a, b) return a & b end')()
        bor    = load('return function(a, b) return a | b end')()
        bxor   = load('return function(a, b) return a ~ b end')()
        bnot   = load('return function(a) return ~a end')()
        lshift = load('return function(a, n) return (a << n) & 0xffffffff end')()
        rshift = load('return function(a, n) return (a >> n) & 0xffffffff end')()
    end
end

----------------------------------------------------------------------
-- MD5 (needed to rebuild file headers after writes)
----------------------------------------------------------------------

local MD5_S = {
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
}
local MD5_K = {
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
}

local function rol32(x, n)
    return bor(band(lshift(x, n), 0xffffffff), rshift(x, 32 - n))
end

local function md5(msg)
    local ml = #msg * 8
    local padded = { msg, '\128' }
    local plen = #msg + 1
    while plen % 64 ~= 56 do
        padded[#padded + 1] = '\0'
        plen = plen + 1
    end
    -- 8-byte little-endian bit length
    for _ = 1, 8 do
        padded[#padded + 1] = string.char(band(ml, 0xff))
        ml = math.floor(ml / 256)
    end
    local data = table.concat(padded)

    local a0, b0, c0, d0 = 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476
    for chunk = 1, #data, 64 do
        local w = {}
        for i = 0, 15 do
            local o = chunk + i * 4
            local b1, b2, b3, b4 = data:byte(o, o + 3)
            w[i] = band(bor(bor(b1, lshift(b2, 8)), bor(lshift(b3, 16), lshift(b4, 24))), 0xffffffff)
        end
        local A, B, C, D = a0, b0, c0, d0
        for i = 0, 63 do
            local F, g
            if i < 16 then
                F = band(bor(band(B, C), band(bnot(B), D)), 0xffffffff)
                g = i
            elseif i < 32 then
                F = band(bor(band(D, B), band(bnot(D), C)), 0xffffffff)
                g = (5 * i + 1) % 16
            elseif i < 48 then
                F = band(bxor(bxor(B, C), D), 0xffffffff)
                g = (3 * i + 5) % 16
            else
                F = band(bxor(C, bor(B, bnot(D))), 0xffffffff)
                g = (7 * i) % 16
            end
            local tmp = D
            D = C
            C = B
            local sum = band(A + F + MD5_K[i + 1] + w[g], 0xffffffff)
            B = band(B + rol32(sum, MD5_S[i + 1]), 0xffffffff)
            A = tmp
        end
        a0 = band(a0 + A, 0xffffffff)
        b0 = band(b0 + B, 0xffffffff)
        c0 = band(c0 + C, 0xffffffff)
        d0 = band(d0 + D, 0xffffffff)
    end

    local out = {}
    for _, v in ipairs({ a0, b0, c0, d0 }) do
        out[#out + 1] = string.char(
            band(v, 0xff),
            band(rshift(v, 8), 0xff),
            band(rshift(v, 16), 0xff),
            band(rshift(v, 24), 0xff))
    end
    return table.concat(out)
end
M.md5 = md5 -- exposed for tests

----------------------------------------------------------------------
-- Line / name byte<->text codec
----------------------------------------------------------------------

-- Escape a raw byte string to editable text:
--   0xFD <4 bytes> 0xFD  -> "[AT:xxxxxxxx]"   (auto-translate phrase)
--   byte <0x20 or >0x7E -> "\xNN"
local function bytes_to_text(raw)
    local out = {}
    local i = 1
    while i <= #raw do
        local b = raw:byte(i)
        if b == 0xfd and i + 5 <= #raw and raw:byte(i + 5) == 0xfd then
            out[#out + 1] = ('[AT:%02x%02x%02x%02x]'):format(
                raw:byte(i + 1), raw:byte(i + 2), raw:byte(i + 3), raw:byte(i + 4))
            i = i + 6
        elseif b >= 0x20 and b <= 0x7e then
            out[#out + 1] = raw:sub(i, i)
            i = i + 1
        else
            out[#out + 1] = ('\\x%02x'):format(b)
            i = i + 1
        end
    end
    return table.concat(out)
end
M.bytes_to_text = bytes_to_text

-- Decode editable text back to bytes. Returns byte string, or nil + error
-- when truncation would split an escape sequence.
local function text_to_bytes(text, max_len)
    local out = {}
    local n = 0
    local i = 1
    while i <= #text do
        local at = text:match('^%[AT:(%x%x%x%x%x%x%x%x)%]', i)
        if at then
            if n + 6 > max_len then
                return nil, 'line too long (auto-translate phrase needs 6 bytes)'
            end
            out[#out + 1] = string.char(0xfd,
                tonumber(at:sub(1, 2), 16), tonumber(at:sub(3, 4), 16),
                tonumber(at:sub(5, 6), 16), tonumber(at:sub(7, 8), 16), 0xfd)
            n = n + 6
            i = i + 13 -- "[AT:" + 8 hex + "]" is 13 chars
        else
            local hex = text:match('^\\x(%x%x)', i)
            if hex then
                if n + 1 > max_len then return nil, 'line too long' end
                out[#out + 1] = string.char(tonumber(hex, 16))
                n = n + 1
                i = i + 4
            else
                if n + 1 > max_len then return nil, 'line too long' end
                out[#out + 1] = text:sub(i, i)
                n = n + 1
                i = i + 1
            end
        end
    end
    return table.concat(out)
end
M.text_to_bytes = text_to_bytes

-- Byte length of an encoded line (for client-side counters).
function M.text_byte_len(text)
    local b = text_to_bytes(text, 1e9)
    return b and #b or -1
end

----------------------------------------------------------------------
-- Record / file layout
----------------------------------------------------------------------

local LINE_LEN  = 61
local NAME_LEN  = 8
local NUM_LINES = 6
local NUM_MACROS = 20
local REC_PAD   = 6
local REC_PAD_LAST = 2
local HEADER_LEN = 28     -- ver(4) + field(4) + md5(16) + zero(4)
local MD5_OFF    = 24     -- md5 covers this offset onward
local REC_STRIDE = NUM_LINES * LINE_LEN + NAME_LEN + REC_PAD -- 380
local PALETTE_LEN = 7624
local TITLE_LEN  = 16
local TITLES_PER_FILE = 20
local TTL_HEADER = 24     -- ver(4) + field(4) + md5(16)

local function read_file(path)
    local f = io.open(path, 'rb')
    if not f then return nil end
    local d = f:read('*a')
    f:close()
    return d
end

local function write_file(path, data)
    local f = io.open(path, 'wb')
    if not f then return nil, 'cannot open ' .. path end
    f:write(data)
    f:close()
    return true
end

-- Parse a mcrN.dat palette file into {name, lines[6]} x 20.
function M.parse_palette(data)
    if type(data) ~= 'string' or #data < HEADER_LEN + NUM_LINES * LINE_LEN + NAME_LEN then
        return nil, 'file too small'
    end
    local macros = {}
    for i = 0, NUM_MACROS - 1 do
        local base = HEADER_LEN + i * REC_STRIDE
        local lines = {}
        for j = 0, NUM_LINES - 1 do
            local field = data:sub(base + j * LINE_LEN + 1, base + j * LINE_LEN + LINE_LEN)
            lines[j + 1] = bytes_to_text(field:match('^([^%z]*)') or '')
        end
        local name = data:sub(base + NUM_LINES * LINE_LEN + 1,
            base + NUM_LINES * LINE_LEN + NAME_LEN)
        macros[i + 1] = {
            name = bytes_to_text(name:match('^([^%z]*)') or ''),
            lines = lines,
        }
    end
    return macros
end

-- Build a full mcrN.dat image from {name, lines[6]} x 20.
-- prefix8 = first 8 bytes of the previous file (version + client field);
-- defaults to version 1 + zeros.
function M.build_palette(macros, prefix8)
    local parts = {}
    for i = 1, NUM_MACROS do
        local m = macros[i] or {}
        local mlines = m.lines or {}
        for j = 1, NUM_LINES do
            local b, err = text_to_bytes(mlines[j] or '', LINE_LEN - 1)
            if not b then return nil, ('macro %d line %d: %s'):format(i, j, err) end
            parts[#parts + 1] = b .. string.rep('\0', LINE_LEN - #b)
        end
        local nb, err = text_to_bytes(m.name or '', NAME_LEN)
        if not nb then return nil, ('macro %d name: %s'):format(i, err) end
        parts[#parts + 1] = nb .. string.rep('\0', NAME_LEN - #nb)
        parts[#parts + 1] = string.rep('\0', i < NUM_MACROS and REC_PAD or REC_PAD_LAST)
    end
    local body = '\0\0\0\0' .. table.concat(parts) -- zero gap at offset 24
    return (prefix8 or '\1\0\0\0\0\0\0\0') .. md5(body) .. body
end

-- Parse a mcr*.ttl file into 20 title strings.
function M.parse_titles(data)
    local titles = {}
    if type(data) ~= 'string' or #data < TTL_HEADER then
        for i = 1, TITLES_PER_FILE do titles[i] = '' end
        return titles
    end
    for i = 0, TITLES_PER_FILE - 1 do
        local field = data:sub(TTL_HEADER + i * TITLE_LEN + 1,
            TTL_HEADER + i * TITLE_LEN + TITLE_LEN)
        titles[i + 1] = bytes_to_text(field:match('^([^%z]*)') or '')
    end
    return titles
end

-- Rebuild a ttl file from 20 title strings.
function M.build_titles(titles, prefix8)
    local parts = {}
    for i = 1, TITLES_PER_FILE do
        local b, err = text_to_bytes(titles[i] or '', TITLE_LEN)
        if not b then return nil, ('title %d: %s'):format(i, err) end
        parts[i] = b .. string.rep('\0', TITLE_LEN - #b)
    end
    local body = table.concat(parts)
    return (prefix8 or '\1\0\0\0\0\0\0\0') .. md5(body) .. body
end

----------------------------------------------------------------------
-- USER directory discovery + high-level read/write
----------------------------------------------------------------------

local function join(a, b)
    if a:sub(-1) ~= '\\' and a:sub(-1) ~= '/' then
        a = a .. '\\'
    end
    return a .. b
end
M.join = join

function M.user_root(ffxi_path)
    return join(ffxi_path, 'USER')
end

-- Character folders are content-id hex names; a folder counts when it holds
-- macro files.
function M.find_char_dirs(ffxi_path)
    if type(ffxi_path) ~= 'string' or ffxi_path == '' then
        return {}
    end
    local root = M.user_root(ffxi_path)
    local out = {}
    for _, name in ipairs(plat.get_dir(root) or {}) do
        if name ~= '.' and name ~= '..' then
            local p = join(root, name)
            if plat.dir_exists(p)
                and (plat.file_exists(join(p, 'mcr.ttl'))
                    or plat.file_exists(join(p, 'mcr.dat'))) then
                out[#out + 1] = { id = name, path = p }
            end
        end
    end
    return out
end

function M.palette_file(index)
    return index == 0 and 'mcr.dat' or ('mcr%d.dat'):format(index)
end

-- mcr.sys: 28B header + u32 palette file index — the client rewrites it
-- on every in-game book/page switch (and at logout), which makes it the
-- only observable of the active palette: no packet or API reports it.
-- Returns the 0-based palette index (book = i/10+1, page = i%10+1), or
-- nil when the file is absent/malformed.
function M.read_sys_index(dir)
    local data = read_file(join(dir, 'mcr.sys'))
    -- 28B file: the u32 LE palette index sits at offset 24 (bytes 25-28)
    if not data or #data < 28 or data:byte(1) ~= 1 then return nil end
    return data:byte(25)
        + data:byte(26) * 256
        + data:byte(27) * 65536
        + data:byte(28) * 16777216
end

-- In-memory mirror of the sys index via _WindowerMemory.dll
-- (plat.memory). The live palette index sits in an FFXiMain structure;
-- the exact location still needs a verified signature, so this returns
-- nil until one is pinned — callers fall back to read_sys_index.
function M.mem_index(dir)
    return nil
end

function M.read_titles(dir)
    local titles = {}
    for f = 1, 2 do
        local data = read_file(join(dir, f == 1 and 'mcr.ttl' or 'mcr_2.ttl'))
        local t = M.parse_titles(data)
        for i = 1, TITLES_PER_FILE do
            titles[(f - 1) * TITLES_PER_FILE + i] = t[i]
        end
    end
    return titles
end

-- Read every palette file present in a char dir.
function M.read_palettes(dir)
    local out = {}
    for _, fname in ipairs(plat.get_dir(dir) or {}) do
        local index = fname == 'mcr.dat' and 0 or tonumber((fname:match('^mcr(%d+)%.dat$')))
        if index then
            local macros = M.parse_palette(read_file(join(dir, fname)))
            out[#out + 1] = {
                index = index,
                file = fname,
                book = math.floor(index / 10) + 1,
                palette = index % 10 + 1,
                macros = macros or {},
            }
        end
    end
    table.sort(out, function(a, b) return a.index < b.index end)
    return out
end

-- The unknown u32 field at offset 4 is constant across files the client
-- writes together; reuse a sibling's value for brand-new palette files.
local function header_prefix(dir, preferred_file)
    local data = read_file(join(dir, preferred_file))
        or read_file(join(dir, 'mcr.ttl'))
        or read_file(join(dir, 'mcr.dat'))
    if data and #data >= 8 then
        return data:sub(1, 8)
    end
    return nil
end

-- Build a palette image without writing it — the apply dance validates up
-- front but lands the bytes later, between client book switches.
function M.palette_image(dir, index, macros)
    local fname = M.palette_file(index)
    local path = join(dir, fname)
    local prev = read_file(path)
    local prefix = prev and #prev >= 8 and prev:sub(1, 8) or header_prefix(dir, fname)
    local image, err = M.build_palette(macros, prefix)
    if not image then return nil, err end
    return image, path
end

-- Back up the existing file, then write a prebuilt image.
function M.commit_image(path, image)
    local prev = read_file(path)
    if prev then
        write_file(path .. '.xicompanion-bak', prev)
    end
    return write_file(path, image)
end

-- Write a palette. Returns true, or nil + error. A .xicompanion-bak copy of the
-- previous file is left beside it.
function M.write_palette(dir, index, macros)
    local image, path = M.palette_image(dir, index, macros)
    if not image then return nil, path end
    return M.commit_image(path, image)
end

-- Write one book title (book is 1-based, 1-40).
function M.write_title(dir, book, title)
    local fname = book <= TITLES_PER_FILE and 'mcr.ttl' or 'mcr_2.ttl'
    local slot = (book - 1) % TITLES_PER_FILE + 1
    local path = join(dir, fname)
    local prev = read_file(path)
    local titles = M.parse_titles(prev)
    titles[slot] = title
    if prev then
        write_file(path .. '.xicompanion-bak', prev)
    end
    local prefix = prev and #prev >= 8 and prev:sub(1, 8) or header_prefix(dir, fname)
    local image, err = M.build_titles(titles, prefix)
    if not image then return nil, err end
    return write_file(path, image)
end

----------------------------------------------------------------------
-- Minimal correct JSON decoder (the Windower json lib mangles escapes
-- inside strings; macro lines can legitimately contain quotes/backslashes)
----------------------------------------------------------------------

local function json_decode(s)
    local pos = 1
    local function fail(msg) error(msg or 'bad json') end
    local function skip_ws()
        local _, e = s:find('^%s*', pos)
        pos = (e or pos - 1) + 1
    end
    local parse_value
    local function parse_string()
        -- pos at opening quote
        local out = {}
        pos = pos + 1
        while pos <= #s do
            local c = s:sub(pos, pos)
            if c == '"' then
                pos = pos + 1
                return table.concat(out)
            elseif c == '\\' then
                local n = s:sub(pos + 1, pos + 1)
                if n == 'n' then out[#out + 1] = '\n'
                elseif n == 't' then out[#out + 1] = '\t'
                elseif n == 'r' then out[#out + 1] = '\r'
                elseif n == 'b' then out[#out + 1] = '\b'
                elseif n == 'f' then out[#out + 1] = '\f'
                elseif n == 'u' then
                    local cp = tonumber(s:sub(pos + 2, pos + 5), 16) or 63
                    out[#out + 1] = cp < 256 and string.char(cp) or '?'
                    pos = pos + 4
                else
                    out[#out + 1] = n
                end
                pos = pos + 2
            else
                out[#out + 1] = c
                pos = pos + 1
            end
        end
        fail('unterminated string')
    end
    local function parse_array()
        pos = pos + 1
        local arr = {}
        skip_ws()
        if s:sub(pos, pos) == ']' then pos = pos + 1 return arr end
        while true do
            arr[#arr + 1] = parse_value()
            skip_ws()
            local c = s:sub(pos, pos)
            if c == ']' then pos = pos + 1 return arr end
            if c ~= ',' then fail('expected , or ]') end
            pos = pos + 1
        end
    end
    local function parse_object()
        pos = pos + 1
        local obj = {}
        skip_ws()
        if s:sub(pos, pos) == '}' then pos = pos + 1 return obj end
        while true do
            skip_ws()
            if s:sub(pos, pos) ~= '"' then fail('expected object key') end
            local key = parse_string()
            skip_ws()
            if s:sub(pos, pos) ~= ':' then fail('expected :') end
            pos = pos + 1
            obj[key] = parse_value()
            skip_ws()
            local c = s:sub(pos, pos)
            if c == '}' then pos = pos + 1 return obj end
            if c ~= ',' then fail('expected , or }') end
            pos = pos + 1
        end
    end
    parse_value = function()
        skip_ws()
        local c = s:sub(pos, pos)
        if c == '"' then return parse_string()
        elseif c == '[' then return parse_array()
        elseif c == '{' then return parse_object()
        elseif c == 't' and s:sub(pos, pos + 3) == 'true' then pos = pos + 4 return true
        elseif c == 'f' and s:sub(pos, pos + 4) == 'false' then pos = pos + 5 return false
        elseif c == 'n' and s:sub(pos, pos + 3) == 'null' then pos = pos + 4 return nil
        else
            local num = s:match('^%-?%d+%.?%d*[eE]?[%+%-]?%d*', pos)
            if num and num ~= '' and tonumber(num) then
                pos = pos + #num
                return tonumber(num)
            end
            fail('unexpected token')
        end
    end
    local ok, val = pcall(parse_value)
    if ok then return val end
    return nil
end
M.json_decode = json_decode

return M
