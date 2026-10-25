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

-- game reads — the subset used across the addon: get_player,
-- get_items, get_bag_info, get_info, get_ability_recasts,
-- get_spell_recasts, get_mob_by_target, get_mob_by_index,
-- get_mob_array, get_map_data, drop_item.
P.ffxi = windower.ffxi

P.send_command = windower.send_command
P.open_url     = windower.open_url
P.add_to_chat  = windower.add_to_chat

P.on = windower.register_event

return P
