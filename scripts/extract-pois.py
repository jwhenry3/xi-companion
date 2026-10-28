#!/usr/bin/env python3
"""extract-pois.py — build addon/xicompanion/mappois.lua (static map POIs).

Sources
-------
1. scripts/pois/*.xml — the client's uberwarp files (homepoint.xml,
   survivalguide.xml, ...). Client-authoritative destination coords.
   XML attr order: posx = X, posy = north-south, posz = height —
   i.e. already in get_map_data(x, ns, height) call order.
2. scripts/npc_list.sql — LandSandBoat/AirSkyBoat npc capture dump for
   everything else (telepoints, field manuals, maws, ...). pos_x = X,
   pos_z = north-south, pos_y = height -> call order (pos_x, pos_z, pos_y).
   npcid encodes the zone: zone = (npcid >> 12) & 0x1FF.
   If the file is missing it is downloaded from the AirSkyBoat repo.

Rows with a 0,0,0 position are uncaptured placeholders and dropped.
Entries closer than ~3 yalms to an existing same-kind marker collapse.

Output: { [zone] = { {k=, n=, x=, y=ns, z=h}, ... } } — coords are world
yalms; map.lua projects them through get_map_data() at runtime.

Run from the repo root:  python scripts/extract-pois.py
"""

import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POIS_DIR = os.path.join(ROOT, 'scripts', 'pois')
NPC_SQL = os.path.join(ROOT, 'scripts', 'npc_list.sql')
OUT = os.path.join(ROOT, 'addon', 'xicompanion', 'mappois.lua')

NPC_LIST_URL = ('https://raw.githubusercontent.com/AirSkyBoat/AirSkyBoat/'
                'staging/sql/npc_list.sql')

# uberwarp xml filename -> (kind, label)
XML_KINDS = {
    'homepoint.xml': ('hp', 'Home Point'),
    'survivalguide.xml': ('book', 'Survival Guide'),
}

# lowercased npc `name` substring -> (kind, display label). First match wins.
NPC_RULES = [
    ('homepoint#', 'hp', 'Home Point'),
    ('shattered_telepoint', 'tele', 'Shattered Telepoint'),
    ('telepoint', 'tele', 'Telepoint'),
    ('dimensional_portal', 'tele', 'Dimensional Portal'),
    ('field_manual', 'book', 'Field Manual'),
    ('field_parchment', 'book', 'Field Parchment'),
    ('survival_guide', 'book', 'Survival Guide'),
    ('cavernous_maw', 'maw', 'Cavernous Maw'),
    ('proto-waypoint', 'way', 'Proto-Waypoint'),
    ('waypoint', 'way', 'Waypoint'),
    ('bivouac#', 'way', 'Frontier Bivouac'),
    ('augural_conveyor', 'way', 'Augural Conveyor'),
    ('geomagnetic_fount', 'fount', 'Geomagnetic Fount'),
    ('veridical_conflux', 'flux', 'Veridical Conflux'),
    ('undulating_confluence', 'flux', 'Undulating Confluence'),
    ('conflux', 'flux', 'Conflux'),
    ('eschan_portal', 'portal', 'Eschan Portal'),
    ('swirling_vortex', 'portal', 'Swirling Vortex'),
    ('spatial_displacement', 'portal', 'Spatial Displacement'),
    ('ethereal_ingress', 'in', 'Ethereal Ingress'),
    ('planar_rift', 'rift', 'Planar Rift'),
    ('runic_portal', 'portal', 'Runic Portal'),
    ('outpost', 'outpost', 'Outpost'),
    ('transporter', 'portal', 'Transporter'),
]

# uberwarp names we do NOT want duplicated by npc rows (npc side loses when
# an xml marker of the same kind sits within DEDUP_DIST of it)
XML_FIRST = {'hp', 'book'}
DEDUP_DIST = 3.0

XML_ENTRY = re.compile(r'<entry\b[^>]*?/?>')
NPC_ROW = re.compile(
    r"VALUES\s*\((\d+),'((?:[^']|'')*)','((?:[^']|'')*)',"
    r"\d+,(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)")


def xml_attr(tag, name):
    m = re.search(r'\b%s="([^"]*)"' % name, tag)
    return m.group(1) if m else None


def read_xmls(out):
    total = 0
    for fn, (kind, label) in XML_KINDS.items():
        path = os.path.join(POIS_DIR, fn)
        if not os.path.isfile(path):
            print('skip %s (missing)' % fn, file=sys.stderr)
            continue
        n = 0
        for tag in XML_ENTRY.findall(open(path, encoding='utf-8').read()):
            zone = xml_attr(tag, 'zone')
            x = xml_attr(tag, 'posx')
            y = xml_attr(tag, 'posy')
            z = xml_attr(tag, 'posz')
            if not all((zone, x, y, z)):
                continue
            zone, x, y, z = int(zone), float(x), float(y), float(z)
            if x == 0 and y == 0 and z == 0:
                continue
            out.setdefault(zone, []).append(
                {'k': kind, 'n': label, 'x': x, 'y': y, 'z': z,
                 'src': 'xml'})
            n += 1
        print('%s: %d entries' % (fn, n))
        total += n
    return total


def npc_sql_bytes():
    if os.path.isfile(NPC_SQL):
        return open(NPC_SQL, 'rb').read()
    print('downloading %s' % NPC_LIST_URL)
    return urllib.request.urlopen(NPC_LIST_URL).read()


def read_npcs(out):
    data = npc_sql_bytes().decode('utf-8', 'replace')
    total = 0
    for m in NPC_ROW.finditer(data):
        npcid = int(m.group(1))
        zone = (npcid >> 12) & 0x1FF
        name = m.group(2).lower().replace("''", "'")
        polutils = m.group(3)
        px, py, pz = float(m.group(4)), float(m.group(5)), float(m.group(6))
        if px == 0 and py == 0 and pz == 0:
            continue  # uncaptured
        rule = next((r for r in NPC_RULES if r[0] in name), None)
        if not rule:
            continue
        _pat, kind, _label = rule
        label = polutils if polutils and polutils != '???' else _label
        # npc pos_y is height, pos_z is north-south -> (x, ns, height)
        e = {'k': kind, 'n': label, 'x': px, 'y': pz, 'z': py, 'src': 'npc'}
        lst = out.setdefault(zone, [])
        dup = any(
            e['k'] == p['k'] and
            abs(p['x'] - e['x']) < DEDUP_DIST and
            abs(p['y'] - e['y']) < DEDUP_DIST
            for p in lst)
        if not dup:
            lst.append(e)
            total += 1
    print('npc_list: %d entries' % total)
    return total


def emit(out):
    lines = [
        '--[[ generated from scripts/pois/*.xml + npc_list.sql --]]',
        "-- { [zone] = { {k, n, x, y=ns, z=height} } world-yalm POIs; map.lua",
        "-- projects them through get_map_data() for the current map",
        'return {',
    ]
    count = 0
    for zone in sorted(out):
        rows = sorted(out[zone], key=lambda p: (p['k'], p['n']))
        lines.append('    [%d] = {' % zone)
        for p in rows:
            label = p['n'].replace("'", "\\'")
            lines.append(
                "        {k='%s',n='%s',x=%.3f,y=%.3f,z=%.3f},"
                % (p['k'], label, p['x'], p['y'], p['z']))
            count += 1
        lines.append('    },')
    lines.append('}')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    print('wrote %s: %d zones, %d POIs' % (OUT, len(out), count))


def main():
    out = {}
    read_xmls(out)
    read_npcs(out)
    emit(out)


if __name__ == '__main__':
    main()
