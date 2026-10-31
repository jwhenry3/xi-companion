-- plat.lua: platform adapter — every call into the host runtime
-- funnels through this module so the addon body stays free of
-- windower.* references. Windower-only; the surface covers env
-- paths, fs helpers, ffxi.* game reads, actions, and
-- signature-normalized events via P.on:
-- fn(id, data, modified, injected, blocked) for chunk events,
-- fn(cmd, ...) for 'addon command', fn() for the rest.
return require('plat_windower')
