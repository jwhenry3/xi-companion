// Shared journal activity logic — the journal view, the sidebar filter
// and the quest tracker all need the same answer to "is this entry/group
// actually in progress?" (the client leaves completed quests in the
// "current" bitfield and finished objectives in the RoE slot, so anything
// already completed does not count as active).
import type { JournalNames, JournalState } from '../core/types';

export type Status = 'done' | 'current' | 'open';

export type TrackKind = 'mission' | 'quest' | 'roe' | 'valor';

/** identity of a journal entry for tracker visibility — matches the
 *  'kind:key:id' strings the addon keeps in state.untracked */
export const trackKey = (kind: TrackKind, key: string, id: number) =>
  `${kind}:${key}:${id}`;

/** group-level identity — 'kind:key'; hiding it covers every current
 *  and future item in the group */
export const groupKey = (kind: TrackKind, key: string) => `${kind}:${key}`;

// canonical group ordering — the JSON object order from the addon is
// arbitrary, so the views pin it down here.
export const MISSION_ORDER = [
  'sandoria', 'bastok', 'windurst', 'zilart', 'cop', 'toau', 'wotg',
  'assault', 'campaign', 'acp', 'mkd', 'asa', 'soa', 'rov', 'tvr',
];
export const QUEST_ORDER = [
  'sandoria', 'bastok', 'windurst', 'jeuno', 'other', 'outlands',
  'toau', 'crystal_war', 'abyssea', 'adoulin', 'coalition',
];

const idCache = new WeakMap<JournalNames, Map<string, number[]>>();

/** sorted record ids for a group, memoized per names payload */
export function sortedIds(
  names: JournalNames | null,
  kind: 'mission' | 'quest',
  key: string,
): number[] {
  const ck = kind + ':' + key;
  let per = names && idCache.get(names);
  if (names && !per) {
    per = new Map();
    idCache.set(names, per);
  }
  let ids = per?.get(ck);
  if (!ids) {
    const grp =
      kind === 'mission'
        ? names?.mission_lines?.[key]
        : names?.quest_areas?.[key];
    ids = Object.keys(grp?.ids ?? {})
      .map(Number)
      .sort((a, b) => a - b);
    per?.set(ck, ids);
  }
  return ids;
}

export function missionStatus(
  j: JournalState | null,
  names: JournalNames | null,
  key: string,
  id: number,
): Status {
  const line = j?.missions?.[key];
  if (!line) return 'open';
  // done wins — the client can leave the pointer on a finished mission
  if (line.done?.includes(id)) return 'done';
  if (line.current === id) return 'current';
  if (line.inferred_done && line.current != null) {
    // pointer-only storyline: every record sorted before the current
    // pointer counts as finished
    const ids = sortedIds(names, 'mission', key);
    const cur = ids.indexOf(line.current);
    const pos = ids.indexOf(id);
    if (cur >= 0 && pos >= 0 && pos < cur) return 'done';
  }
  return 'open';
}

export function questStatus(
  j: JournalState | null,
  key: string,
  id: number,
): Status {
  const area = j?.quests?.[key];
  if (!area) return 'open';
  return area.done?.includes(id)
    ? 'done'
    : area.current?.includes(id)
      ? 'current'
      : 'open';
}

/** does the group contain anything in progress? drives both the
 *  "active only" sidebar filter and the tracker's group list */
export function hasActivity(
  j: JournalState | null,
  names: JournalNames | null,
  kind: TrackKind,
  key: string,
): boolean {
  if (kind === 'valor') {
    // an active (or finished-but-still-registered) regime counts
    return j?.valor != null;
  }
  if (kind === 'roe') {
    const done = new Set(j?.roe?.done ?? []);
    return (j?.roe?.active ?? []).some((a) => !done.has(a.id));
  }
  if (kind === 'quest') {
    const area = j?.quests?.[key];
    if (!area) return false;
    const done = new Set(area.done ?? []);
    return (area.current ?? []).some((id) => !done.has(id));
  }
  const line = j?.missions?.[key];
  if (line?.current == null) return false;
  if (line.done?.includes(line.current)) return false;
  // a pointer that doesn't resolve to a record isn't a mission in
  // progress — it's a "no current mission" sentinel (0xFFFF-style) or a
  // finished storyline resting past the last record
  return sortedIds(names, 'mission', key).includes(line.current);
}
