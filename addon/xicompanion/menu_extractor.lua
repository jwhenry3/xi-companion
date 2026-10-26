-- Menu icon extractor: decodes ROM/280/15.DAT + ROM/324/95.DAT at runtime
-- so the pre-extracted BMPs don't have to ship in the repo.
--
-- These files are chunked: [4B tag][u32 info][payload] where the chunk size
-- is (info>>7)*16 including the 16B header. Image chunks start with 0xA1 and
-- carry an IMGINFO1 header:
--   +0x01 group[8], +0x09 name[8], +0x15 w:i32 h:i32,
--   +0x39 ddsType[4] = '3TXD' (DXT3), +0x3D payload size u32, +0x45 pixels
-- DXT3 = 4x4 blocks: 8B of 4-bit alpha + 2x RGB565 colors + 2bpp index.
-- Alpha nibbles are doubled (FFXI convention: 0x8 ≈ opaque).
--
--   names()              → idx → "grp/name" (no pixel decode; abilities.lua
--                          resolves icon names against this)
--   by_id(idx, path)     → decode chunk idx to BMP at path (lazy)
--   ws(n, path)          → 32x32 tile n from the misc/ws 128px sheet
--   idx ≥330             → tiles from 2habi/spabi1x + spabi2x sheets
local plat = require('plat')
local menu_extractor = {}

local byte, char, concat = string.byte, string.char, table.concat
local floor = math.floor
local band, rshift = bit.band, bit.rshift
local function u16(s, i) return byte(s, i) + byte(s, i + 1) * 256 end
local function u32(s, i)
    return byte(s, i) + byte(s, i + 1) * 256
        + byte(s, i + 2) * 65536 + byte(s, i + 3) * 16777216
end
local function p32(v) -- little-endian u32
    v = floor(v)
    return char(band(v, 255), band(rshift(v, 8), 255),
        band(rshift(v, 16), 255), band(rshift(v, 24), 255))
end
local function p16(v) return char(band(v, 255), band(rshift(v, 8), 255)) end

local DATS = { 'ROM/280/15.DAT', 'ROM/324/95.DAT' }
-- sheet chunk name → first menuicon index its tiles occupy
local SHEETS = { spabi1x = 330, spabi2x = 346 }

local _chunks -- lazy [{dat,off,grp,name}]
local function scan()
    if _chunks then return _chunks end
    _chunks = {}
    for _, rel in ipairs(DATS) do
        local f = io.open(plat.ffxi_path .. '/' .. rel, 'rb')
        if f then
            local d = f:read('*a')
            f:close()
            local off, n = 0, #d
            while off + 16 <= n do
                local size = rshift(u32(d, off + 5), 7) * 16
                if size <= 16 then break end
                local p = off + 17 -- chunk payload offset (1-based) in d
                if byte(d, p) == 0xA1 then
                    local grp = d:sub(p + 1, p + 8):match('^(%S+)')
                    local nm = d:sub(p + 9, p + 16):match('^(%S+)')
                    if grp and nm then
                        _chunks[#_chunks + 1] =
                            { dat = rel, off = off, grp = grp, name = nm }
                    end
                end
                off = off + size
            end
        end
    end
    return _chunks
end

function menu_extractor.names()
    local out = {}
    for i, c in ipairs(scan()) do out[i - 1] = c.grp .. '/' .. c.name end
    return out
end

local function c16(v)
    return floor(rshift(band(v, 0xF800), 11) * 255 / 31),
           floor(rshift(band(v, 0x07E0), 5) * 255 / 63),
           floor(band(v, 0x1F) * 255 / 31)
end

-- DXT3 payload → BGRA pixel string, TOP-DOWN row order
local function dxt3(px, w, h)
    local rows = {}
    for y = 0, h - 1 do rows[y] = {} end
    local bw = floor(w / 4)
    for by = 0, floor(h / 4) - 1 do
        for bx = 0, bw - 1 do
            local b = (by * bw + bx) * 16
            local r0, g0, b0 = c16(u16(px, b + 9))
            local r1, g1, b1 = c16(u16(px, b + 11))
            local C = {
                { r0, g0, b0 }, { r1, g1, b1 },
                { floor((2 * r0 + r1) / 3), floor((2 * g0 + g1) / 3), floor((2 * b0 + b1) / 3) },
                { floor((r0 + 2 * r1) / 3), floor((g0 + 2 * g1) / 3), floor((b0 + 2 * b1) / 3) },
            }
            local ci = u32(px, b + 13)
            for i = 0, 15 do
                local ab = byte(px, b + 1 + floor(i / 2))
                local a4 = i % 2 == 0 and band(ab, 15) or rshift(ab, 4)
                local sel = band(rshift(ci, 2 * i), 3)
                local c = C[sel + 1]
                local a = a4 * 34
                local row = rows[by * 4 + floor(i / 4)]
                row[#row + 1] = char(c[3], c[2], c[1], a > 255 and 255 or a)
            end
        end
    end
    local out = {}
    for y = 0, h - 1 do out[#out + 1] = concat(rows[y]) end
    return concat(out)
end

-- BGRA top-down → 32bpp BMP (rows stored bottom-up)
local function bmp(px, w, h)
    local rh = w * 4
    local rows = {}
    for y = h - 1, 0, -1 do
        rows[#rows + 1] = px:sub(y * rh + 1, (y + 1) * rh)
    end
    local body = concat(rows)
    return 'BM'
        .. p32(122 + #body) .. p32(0) .. p32(122)
        .. p32(108) .. p32(w) .. p32(h) .. p16(1) .. p16(32)
        .. p32(3) .. p32(#body) .. p32(2835) .. p32(2835)
        .. p32(0) .. p32(0)
        .. p32(0xFF0000) .. p32(0xFF00) .. p32(0xFF) .. p32(0xFF000000)
        .. 'sRGB' .. ('\0'):rep(36) .. p32(0) .. p32(0) .. p32(0)
        .. body
end

-- read + decode one \xa1 chunk → BGRA top-down string, w, h
local function decode_chunk(c)
    local f = io.open(plat.ffxi_path .. '/' .. c.dat, 'rb')
    if not f then return nil end
    f:seek('set', c.off + 16)
    local hdr = f:read(72)
    local w, h = u32(hdr, 0x16), u32(hdr, 0x1A)
    local size = u32(hdr, 0x3E)
    f:seek('set', c.off + 16 + 0x45)
    local px = f:read(size)
    f:close()
    if hdr:sub(0x3A, 0x3D) ~= '3TXD' or not px or #px < size then
        return nil
    end
    return dxt3(px, w, h), w, h
end

local function ensure_dir(dir)
    if not plat.dir_exists(dir) then plat.create_dir(dir) end
end

local function sheet(name)
    for _, c in ipairs(scan()) do
        if c.name == name then return c end
    end
end

local function write_tile(path, rgba, w, t)
    local tiles = w / 32
    local tx, ty = t % tiles, floor(t / tiles)
    local rows = {}
    for y = 0, 31 do
        rows[#rows + 1] = rgba:sub(((ty * 32 + y) * w + tx * 32) * 4 + 1,
                                   ((ty * 32 + y) * w + tx * 32 + 32) * 4)
    end
    local f = io.open(path, 'wb')
    f:write(bmp(concat(rows), 32, 32))
    f:close()
end

-- decode menuicon idx → BMP at path. idx < #chunks = whole chunk;
-- idx ≥330 = tile inside a spabi sheet (see SHEETS)
function menu_extractor.by_id(idx, path)
    local cs = scan()
    local dir = path:match('(.*)[/\\]')
    ensure_dir(dir)
    local c = cs[idx + 1]
    if c then
        local px, w, h = decode_chunk(c)
        if not px then return false end
        local f = io.open(path, 'wb')
        f:write(bmp(px, w, h))
        f:close()
        return true
    end
    for name, base in pairs(SHEETS) do
        if idx >= base then
            local sc = sheet(name)
            local px, w, h
            if sc then px, w, h = decode_chunk(sc) end
            if px and idx < base + (w / 32) * (h / 32) then
                write_tile(path, px, w, idx - base)
                return true
            end
        end
    end
    return false
end

-- decode tile n of the misc/ws sheet → BMP at path
function menu_extractor.ws(n, path)
    local sc = sheet('ws')
    local px, w
    if sc then px, w = decode_chunk(sc) end
    if not px then return false end
    ensure_dir(path:match('(.*)[/\\]'))
    write_tile(path, px, w, tonumber(n) or 0)
    return true
end

return menu_extractor
