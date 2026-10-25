-- plat.lua: platform adapter dispatcher — every call into the host
-- runtime funnels through this module so the addon body stays
-- platform-agnostic. Detects the host and delegates to the matching
-- binding (plat_windower / plat_ashita), which must provide the same
-- surface: env paths, fs helpers, ffxi.* game reads, actions, and
-- signature-normalized events via P.on.
--
-- Event names are Windower's; the Ashita binding maps
-- packet_in/packet_out/command/load/unload/d3d_present onto them with
-- the same call signature: fn(id, data, modified, injected, blocked)
-- for chunk events, fn(cmd, ...) for 'addon command', fn() for the
-- rest.
if windower ~= nil then
    return require('plat_windower')
end
return require('plat_ashita')
