// Quest/mission/RoE reference links resolved on demand from the
// community wikis' MediaWiki opensearch API (no key, CORS via origin=*).
// Lookups only happen while a journal detail pane is open, and each
// title is resolved once per session — these are free community services.

export interface WikiLink {
  title: string;
  url: string;
  source: string;
}

const SOURCES = [
  { api: 'https://ffxiclopedia.fandom.com/api.php', label: 'ffxiclopedia' },
  { api: 'https://www.bg-wiki.com/api.php', label: 'bg-wiki' },
];

const cache = new Map<string, WikiLink | null>();

/** fallback when opensearch can't resolve a page — still gives the
 *  player somewhere to land */
export function wikiSearchUrl(name: string): string {
  return (
    'https://ffxiclopedia.fandom.com/wiki/Special:Search?query=' +
    encodeURIComponent(name)
  );
}

/** resolve an entry name to a wiki page — ffxiclopedia first (richer
 *  walkthrough prose), bg-wiki as fallback. Null when neither has it. */
export async function wikiLink(name: string): Promise<WikiLink | null> {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  let out: WikiLink | null = null;
  for (const s of SOURCES) {
    try {
      const u =
        `${s.api}?action=opensearch&search=${encodeURIComponent(name)}` +
        '&limit=1&namespace=0&format=json&origin=*';
      const j = await (await fetch(u)).json();
      const title = j?.[1]?.[0] as string | undefined;
      const url = j?.[3]?.[0] as string | undefined;
      if (title && url) {
        out = { title, url, source: s.label };
        break;
      }
    } catch {
      // network/wiki down — try the next source
    }
  }
  cache.set(key, out);
  return out;
}
