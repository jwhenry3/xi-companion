#!/usr/bin/env python3
"""Extract FFXI quest/mission/RoE names from the client DATs into
addon/xic/journal_names.lua.

Sources (all decoded from the local FFXI install):
  - d_msg files 55706-55742: quest and mission name records. Body is
    XOR 0xFF decoded; records are fixed-stride "Record" cells:
      cell 0 (int)  = log id (== packet bit position / mission pointer)
      cell 1 (str)  = name ('+' prefix = repeatable, '__' prefix = stage)
      cell 2 (str)  = description
  - ROM/307/16.DAT: English Records of Eminence quest table. 0x1400-byte
    slots, per-byte ror5 cipher, ror5-decrypted fields:
      u32 id (0xE001+; packet RoE quest id == id & 0xFFF),
      u32 release/repeatable/target/emi/exp/cap/uni,
      Record cells @+32: EN layout = 6 cells (0 name, 4 description).
  - ROM/307/24.DAT: RoE category table (same cipher; name cell @+568).

Requires ffxi_fs.py from the re-analysis workspace for the DAT vtable
resolution (set --re-dir or RE_ANALYSIS_DIR). The ROM/307 files are read
directly from the FFXI install dir that ffxi_fs exposes.

Usage:
    python scripts/extract-journal.py [--re-dir <path>] [--ffxi <path>]
        [--out addon/xic/journal_names.lua]
"""

import argparse
import os
import struct
import sys

# ---------------------------------------------------------------- d_msg files

# file id -> (key, display name). Keys are consumed by journal.lua.
QUEST_FILES = [
    (55706, 'sandoria',    "San d'Oria"),
    (55707, 'bastok',      'Bastok'),
    (55708, 'windurst',    'Windurst'),
    (55709, 'jeuno',       'Jeuno'),
    (55710, 'other',       'Other Areas'),
    (55711, 'outlands',    'Outlands'),
    (55712, 'toau',        'Treasures of Aht Urhgan'),
    (55722, 'crystal_war', 'Crystal War'),      # 0x88 / 0xC8 bitfields
    (55713, 'abyssea',     'Abyssea'),          # 0xE0 / 0xE8 bitfields
    (55739, 'adoulin',     'Seekers of Adoulin'),
    (55740, 'coalition',   'Coalition'),
]

MISSION_FILES = [
    (55715, 'sandoria', "San d'Oria"),
    (55716, 'bastok',   'Bastok'),
    (55717, 'windurst', 'Windurst'),
    (55718, 'zilart',   'Rise of the Zilart'),
    (55719, 'cop',      'Chains of Promathia'),
    (55720, 'assault',  'Assault'),
    (55721, 'toau',     'Treasures of Aht Urhgan'),
    (55723, 'wotg',     'Wings of the Goddess'),
    (55724, 'campaign', 'Campaign Ops'),
    (55735, 'acp',      'A Crystalline Prophecy'),
    (55736, 'mkd',      "A Moogle Kupo d'Etat"),
    (55737, 'asa',      'A Shantotto Ascension'),
    (55738, 'soa',      'Seekers of Adoulin'),
    (55741, 'rov',      "Rhapsodies of Vana'diel"),
    (55742, 'tvr',      'The Voracious Resurgence'),
]

STRIDE = 0x280


def load_ffxi_fs(re_dir):
    sys.path.insert(0, re_dir)
    import ffxi_fs  # noqa: E402
    return ffxi_fs


def decode_text(b):
    """FFXI EN strings are cp1252-ish; emit real unicode."""
    return b.decode('cp1252', 'replace')


def parse_record_cells(buf, base):
    """Parse a Record (cellCount + {offset,type} specs) at `base`.
    Returns list of ('int',v)/('str',s) cells, or None on malformed data."""
    if base + 4 > len(buf):
        return None
    n = struct.unpack_from('<i', buf, base)[0]
    if n <= 0 or n > 16:
        return None
    cells = []
    for i in range(n):
        off, typ = struct.unpack_from('<ii', buf, base + 4 + i * 8)
        if off < 0 or base + off >= len(buf):
            return None
        if typ == 0:  # string cell: 28-byte header then NUL-terminated text
            s = base + off + 28
            e = buf.find(b'\x00', s, min(s + 2048, len(buf)))
            if e < 0:
                return None
            cells.append(('str', decode_text(buf[s:e])))
        elif typ == 1:
            cells.append(('int', struct.unpack_from('<i', buf, base + off)[0]))
        else:
            return None
    return cells


def dmsg_records(ffxi_fs, fid):
    """Yield (id, name, desc) for each record in a 0x280-stride d_msg file."""
    raw = ffxi_fs.load_dat(fid)
    if not raw or raw[:4] != b'd_ms':
        raise RuntimeError('file %d is not a d_msg DAT' % fid)
    cnt = struct.unpack_from('<I', raw, 0x28)[0]
    dbsz = struct.unpack_from('<I', raw, 0x24)[0]
    body = bytes(b ^ 0xFF for b in raw[0x40:0x40 + dbsz])
    stride = dbsz // cnt if cnt else 0
    if stride * cnt != dbsz or stride < STRIDE:
        raise RuntimeError('file %d has unexpected layout (cnt=%d dbsz=%x)'
                           % (fid, cnt, dbsz))
    for r in range(cnt):
        cells = parse_record_cells(body, r * stride)
        if not cells or len(cells) < 2 or cells[0][0] != 'int':
            continue
        qid = cells[0][1]
        name = cells[1][1] if cells[1][0] == 'str' else ''
        desc = cells[2][1] if len(cells) > 2 and cells[2][0] == 'str' else ''
        yield qid, name, desc


def clean_name(name):
    """Return (display_name, flags) stripping the '+' repeatable and
    '__' stage-name prefixes the client uses."""
    rep = name.startswith('+')
    stage = name.startswith('__')
    n = name.lstrip('+_ ').strip()
    return n, rep, stage


def usable_name(name):
    """English tables are ASCII; untranslated JP placeholders decode to
    cp1252 garbage (ƒNƒGƒXƒg = クエスト). Drop those records entirely."""
    return bool(name) and name != '.' and all(ord(c) < 0x7F for c in name)


# ---------------------------------------------------------------- RoE slots

def ror5(b):
    return ((b >> 5) | (b << 3)) & 0xFF


def roe_quests(path):
    """Yield (index, name, target, repeatable, desc) from ROM/307/16.DAT."""
    raw = open(path, 'rb').read()
    for i in range(1, len(raw) // 0x1400):
        dec = bytes(ror5(b) for b in raw[i * 0x1400:(i + 1) * 0x1400])
        qid, rel, rep, tc, emi, exp, cap, uni = \
            struct.unpack_from('<8I', dec, 0)
        idx = qid & 0xFFF
        cells = parse_record_cells(dec, 32)
        if not cells:
            continue
        name = cells[0][1] if cells[0][0] == 'str' else ''
        desc = cells[4][1] if len(cells) > 4 and cells[4][0] == 'str' else ''
        yield idx, name, tc, rep, desc


def roe_categories(path):
    raw = open(path, 'rb').read()
    out = {}
    for i in range(1, len(raw) // 0x1400):
        dec = bytes(ror5(b) for b in raw[i * 0x1400:(i + 1) * 0x1400])
        cid = struct.unpack_from('<I', dec, 0)[0]
        cells = parse_record_cells(dec, 568)
        if cells and cells[0][0] == 'str' and cells[0][1] not in ('', '.'):
            out[cid & 0xFFF] = cells[0][1]
    return out


def roe_tree(path):
    """Decode the client's own RoE menu tree from ROM/307/24.DAT.

    Every record carries an id in a shared node space (61952+); named
    nodes are the menu categories. Node field b is the first child id:
    for a top category the children are the contiguous run of
    subcategory node ids starting at b (bounded by the next sibling's
    b), and for a leaf subcategory the children are objective records —
    objective node id = 57344 + log id — so a leaf owns the log-id band
    [b - 57344, next_leaf.b - 57344).
    Returns (tree, leaves) where tree is [{id, name, children:[leaf ids]}]
    and leaves is {subcat_id: first_log_id} sorted by first_log_id.
    """
    raw = open(path, 'rb').read()
    nodes = {}
    for i in range(1, len(raw) // 0x1400):
        dec = bytes(ror5(b) for b in raw[i * 0x1400:(i + 1) * 0x1400])
        cid, _a, b, _c, _d, _e, _f, _g = struct.unpack_from('<8I', dec, 0)
        if not cid:
            continue
        cells = parse_record_cells(dec, 568)
        name = (cells[0][1] if cells and cells[0][0] == 'str'
                and cells[0][1] not in ('', '.') else None)
        nodes[cid] = {'name': name, 'b': b}

    lo = min(nodes)
    roots = sorted((k for k, v in nodes.items() if v['b'] >= lo),
                   key=lambda k: nodes[k]['b'])
    leaf_ids = sorted((k for k, v in nodes.items()
                       if 0 < v['b'] < lo and v['name']),
                      key=lambda k: nodes[k]['b'])
    leaves = {k & 0xFFF: nodes[k]['b'] - 57344 for k in leaf_ids}

    tree = []
    for i, rid in enumerate(roots):
        start = nodes[rid]['b']
        end = nodes[roots[i + 1]]['b'] if i + 1 < len(roots) else 1 << 30
        kids = [k & 0xFFF for k in leaf_ids if start <= k < end]
        if nodes[rid]['name']:
            tree.append({'id': rid & 0xFFF, 'name': nodes[rid]['name'],
                         'children': kids})
    return tree, leaves


def roe_objective_categories(leaves, roe_ids):
    """Map objective log id -> subcategory id: each leaf owns the band
    from its first log id up to (not including) the next leaf's."""
    owner = {}
    for oid in roe_ids:
        # last leaf whose band start is <= oid
        lo = -1
        for cid, start in leaves.items():
            if start <= oid and start > lo:
                lo, owner[oid] = start, cid
    return owner


# ---------------------------------------------------------------- emit

def lua_str(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') \
                  .replace('\n', '\\n').replace('\r', '') + '"'


def emit_names_table(f, per_id):
    f.write('    {\n')
    for qid in sorted(per_id):
        name, rep, desc = per_id[qid]
        flags = ''
        meta = []
        if rep:
            meta.append('rep=1')
        if desc:
            meta.append('d=' + lua_str(desc))
        if meta:
            f.write('      [%d]={n=%s,%s},\n' % (qid, lua_str(name), ','.join(meta)))
        else:
            f.write('      [%d]=%s,\n' % (qid, lua_str(name)))
    f.write('    },\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--re-dir', default=os.environ.get(
        'RE_ANALYSIS_DIR', r'C:\Users\jwhen\nw\re-analysis'))
    ap.add_argument('--ffxi', default=None,
                    help='FFXI install dir (defaults to ffxi_fs.BASE)')
    ap.add_argument('--out', default=os.path.join(
        os.path.dirname(__file__), '..', 'addon', 'xic',
        'journal_names.lua'))
    args = ap.parse_args()

    ffxi_fs = load_ffxi_fs(args.re_dir)
    ffxi_dir = args.ffxi or ffxi_fs.BASE

    quests = {}
    for fid, key, title in QUEST_FILES:
        per_id = {}
        for qid, name, desc in dmsg_records(ffxi_fs, fid):
            if not usable_name(name):
                continue
            n, rep, _ = clean_name(name)
            if qid not in per_id:  # first record wins
                per_id[qid] = (n, rep, desc.strip() or None)
        quests[key] = (title, per_id)

    missions = {}
    for fid, key, title in MISSION_FILES:
        per_id = {}
        for qid, name, desc in dmsg_records(ffxi_fs, fid):
            if not usable_name(name):
                continue
            n, rep, stage = clean_name(name)
            ent = per_id.setdefault(qid, {'name': None, 'stages': [],
                                          'desc': None, 'rep': rep})
            if stage:
                if n:
                    ent['stages'].append(n)
                    if not ent['desc'] and desc.strip():
                        ent['desc'] = desc.strip()
            else:
                if ent['name'] is None:
                    ent['name'] = n
                if not ent['desc'] and desc.strip():
                    ent['desc'] = desc.strip()
        # fill missing names from stages
        for qid, ent in per_id.items():
            if ent['name'] is None:
                ent['name'] = ent['stages'][0] if ent['stages'] else '?'
        missions[key] = (title, per_id)

    roe = {}
    qpath = os.path.join(ffxi_dir, 'ROM', '307', '16.DAT')
    for idx, name, tc, rep, desc in roe_quests(qpath):
        if usable_name(name):
            roe[idx] = (name, tc, rep, desc.strip() or None)
    cat_path = os.path.join(ffxi_dir, 'ROM', '307', '24.DAT')
    cats = roe_categories(cat_path)
    tree, leaves = roe_tree(cat_path)
    roe_cat = roe_objective_categories(leaves, roe.keys())

    total_q = sum(len(v[1]) for v in quests.values())
    total_m = sum(len(v[1]) for v in missions.values())
    print('quests: %d entries across %d areas' % (total_q, len(quests)))
    print('missions: %d entries across %d storylines' % (total_m, len(missions)))
    print('roe: %d objectives, %d categories, %d categorized' %
          (len(roe), len(cats), len(roe_cat)))

    with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write('-- Generated by scripts/extract-journal.py from client DATs.\n')
        f.write('-- Do not edit; re-run the extractor to update.\n')
        f.write('return {\n')

        f.write('  quest_areas = {\n')
        for key, (title, per_id) in quests.items():
            f.write('    %s = { name = %s, ids = {\n' % (key, lua_str(title)))
            for qid in sorted(per_id):
                n, rep, desc = per_id[qid]
                meta = ''
                if rep:
                    meta += ',r=1'
                if desc:
                    meta += ',d=' + lua_str(desc)
                f.write('      [%d] = {n=%s%s},\n' % (qid, lua_str(n), meta))
            f.write('    }},\n')
        f.write('  },\n')

        f.write('  mission_lines = {\n')
        for key, (title, per_id) in missions.items():
            f.write('    %s = { name = %s, ids = {\n' % (key, lua_str(title)))
            for qid in sorted(per_id):
                ent = per_id[qid]
                meta = ''
                if ent['rep']:
                    meta += ',r=1'
                if ent['desc']:
                    meta += ',d=' + lua_str(ent['desc'])
                if ent['stages']:
                    stages = ','.join(lua_str(s) for s in ent['stages'])
                    meta += ',s={%s}' % stages
                f.write('      [%d] = {n=%s%s},\n' % (qid, lua_str(ent['name']), meta))
            f.write('    }},\n')
        f.write('  },\n')

        f.write('  roe = {\n')
        for idx in sorted(roe):
            name, tc, rep, desc = roe[idx]
            meta = ''
            if tc and tc != 1:
                meta += ',t=%d' % tc
            if rep:
                meta += ',r=1'
            if idx in roe_cat:
                meta += ',c=%d' % roe_cat[idx]
            if desc:
                meta += ',d=' + lua_str(desc)
            f.write('    [%d] = {n=%s%s},\n' % (idx, lua_str(name), meta))
        f.write('  },\n')

        f.write('  roe_categories = {\n')
        for cid in sorted(cats):
            f.write('    [%d] = %s,\n' % (cid, lua_str(cats[cid])))
        f.write('  },\n')

        f.write('  roe_tree = {\n')
        for root in tree:
            kids = ','.join(str(k) for k in root['children'])
            f.write('    [%d] = {%s},\n' % (root['id'], kids))
        f.write('  },\n')

        f.write('}\n')

    print('wrote %s (%d bytes)' % (args.out, os.path.getsize(args.out)))


if __name__ == '__main__':
    main()
