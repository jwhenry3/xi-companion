#!/usr/bin/env python3
"""Extract Fields of Valor / Grounds of Valor regime page data from
bg-wiki into addon/xicompanion/regime_names.lua.

The regime page->objectives mapping is client dialog DAT data that is not
trivially reachable, so this scrapes the canonical community tables:

  - https://www.bg-wiki.com/ffxi/Fields_of_Valor   section 2 (Field Manuals)
    Per-zone ===[[Zone]]=== headings with {{Fields of Valor Row}} templates:
    |Page=N |Objective=<count> [[Mob]]s ... |Target_Level=L~H |Exp=N
  - https://www.bg-wiki.com/ffxi/Grounds_of_Valor  full wikitext
    Per-zone === [[Zone]] === headings with plain wikitables:
    | <page> | <count> [[Mob]]s ... | L~H | [[Area]] | <reward>

Output keys tables by zone display name (matching res.zones[].name at
runtime); each page record is
  {page=N, desc='<objective text>', needs={n1,..}, low=L, high=H}

Usage:
    python scripts/extract-regimes.py [--out addon/xicompanion/regime_names.lua]
"""

import argparse
import json
import re
import sys
import urllib.request

API = 'https://www.bg-wiki.com/api.php'
UA = {'User-Agent': 'xicompanion-journal/1.0 (regime table generator)'}


def fetch_wikitext(title, section=None):
    url = ('%s?action=parse&page=%s&prop=wikitext&format=json'
           % (API, urllib.parse.quote(title)))
    if section is not None:
        url += '&section=%d' % section
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    return data['parse']['wikitext']['*']


_LINK = re.compile(r'\[\[([^\]|]+)(?:\|([^\]]*))?\]\]')


def clean(text):
    """wikitext -> plain text: [[a|b]] -> b, [[a]] -> a, drop :Category:"""
    def repl(m):
        target, label = m.group(1), m.group(2)
        if label:
            return label
        if target.startswith(':'):  # [[:Category:X|...]] already has label
            return ''
        return target
    text = _LINK.sub(repl, text)
    text = text.replace("''", '')
    return text.strip()


def parse_objective(text):
    """'5 [[Scarab Beetle]]s<br>1 [[Forest Funguar]]' ->
    ('5 Scarab Beetles + 1 Forest Funguar', [5, 1])."""
    desc_parts, needs = [], []
    for line in re.split(r'[\n\r]+|<br\s*/?>', text):
        line = clean(line)
        if not line:
            continue
        m = re.match(r'^\s*(\d+)\s+(.+)$', line)
        if m:
            needs.append(int(m.group(1)))
            name = m.group(2).strip()
            # drop a trailing stray 's' only from obvious link-less plurals?
            # keep the wiki's wording as-is — it's the display name.
            desc_parts.append('%s %s' % (m.group(1), name))
        else:
            desc_parts.append(line)
    return ' + '.join(desc_parts), needs


def parse_level(text):
    m = re.search(r'(\d+)\s*[~-]\s*(\d+)', text or '')
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r'(\d+)', text or '')
    v = int(m.group(1)) if m else 0
    return v, v


# ---------------------------------------------------------------- FoV

_FOV_ZONE = re.compile(r'===\s*\[\[([^\]]+)\]\]\s*===')
_FOV_ROW = re.compile(r'\{\{Fields of Valor Row\s*(.*?)\}\}', re.S)


def fov_fields(row_body):
    # template fields are '|Key=value' on their own lines; values can hold
    # '|' inside [[links]] and even literal newlines, so split on line-start
    # pipes instead of naive '|'-terminated regexes
    fields = {}
    for chunk in re.split(r'(?m)^\s*\|', row_body):
        m = re.match(r'\|*(\w+)\s*=\s*(.*)', chunk, re.S)
        if m:
            fields[m.group(1)] = m.group(2).strip()
    return fields


def parse_fov(wt):
    zones = {}
    # split on zone headings; heading names are the zone display names
    parts = _FOV_ZONE.split(wt)
    for i in range(1, len(parts) - 1, 2):
        zone, body = parts[i].strip(), parts[i + 1]
        pages = []
        for row in _FOV_ROW.finditer(body):
            fields = fov_fields(row.group(1))
            try:
                page = int(fields.get('Page', '0').strip())
            except ValueError:
                continue
            if page <= 0:
                continue
            desc, needs = parse_objective(fields.get('Objective', ''))
            low, high = parse_level(fields.get('Target_Level', ''))
            pages.append({
                'page': page, 'desc': desc, 'needs': needs,
                'low': low, 'high': high,
            })
        if pages:
            pages.sort(key=lambda p: p['page'])
            zones[zone] = pages
    return zones


# ---------------------------------------------------------------- GoV

_GOV_ZONE = re.compile(r'===\s*\[\[([^\]]+)\]\]\s*===')


def parse_gov(wt):
    zones = {}
    parts = _GOV_ZONE.split(wt)
    for i in range(1, len(parts) - 1, 2):
        zone, body = parts[i].strip(), parts[i + 1]
        # wikitable rows: '|-' separated; first cell = page number
        pages = []
        for chunk in re.split(r'\|-', body):
            cells = [c.strip() for c in re.split(r'^\|(?![}-])', chunk,
                                                 flags=re.M) if c.strip()]
            cells = [c for c in cells
                     if not c.startswith('!') and 'class=' not in c[:12]]
            if len(cells) < 3:
                continue
            try:
                page = int(clean(cells[0]))
            except ValueError:
                continue
            desc, needs = parse_objective(cells[1])
            low, high = parse_level(clean(cells[2]))
            pages.append({
                'page': page, 'desc': desc, 'needs': needs,
                'low': low, 'high': high,
            })
        if pages:
            pages.sort(key=lambda p: p['page'])
            zones[zone] = pages
    return zones


# ---------------------------------------------------------------- emit

def lua_str(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def emit(zones_by_kind):
    out = [
        '-- Field Manual (FoV) / Grounds Tome (GoV) regime page tables.',
        '-- Generated by scripts/extract-regimes.py from bg-wiki.',
        '-- Keyed by zone display name (res.zones[].name); each page:',
        '--   {page, desc, needs={n1..}, low, high}',
        'return {',
    ]
    for kind in ('fov', 'gov'):
        out.append('    %s = {' % kind)
        for zone in sorted(zones_by_kind[kind]):
            out.append('        [%s] = {' % lua_str(zone))
            for p in zones_by_kind[kind][zone]:
                needs = ','.join(str(n) for n in p['needs'])
                out.append(
                    '            {page=%d,desc=%s,needs={%s},low=%d,high=%d},'
                    % (p['page'], lua_str(p['desc']), needs,
                       p['low'], p['high']))
            out.append('        },')
        out.append('    },')
    out.append('}')
    return '\n'.join(out) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='addon/xicompanion/regime_names.lua')
    args = ap.parse_args()

    fov_wt = fetch_wikitext('Fields_of_Valor', section=2)
    gov_wt = fetch_wikitext('Grounds_of_Valor')
    zones = {
        'fov': parse_fov(fov_wt),
        'gov': parse_gov(gov_wt),
    }
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(emit(zones))
    for kind in zones:
        total = sum(len(v) for v in zones[kind].values())
        print('%s: %d zones, %d pages' % (kind, len(zones[kind]), total))


if __name__ == '__main__':
    import urllib.parse  # noqa: F401  (used inside fetch_wikitext)
    sys.exit(main())
