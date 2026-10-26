export interface PlayerInfo {
  name: string;
  main_job: string;
  main_job_id: number;
  main_job_level: number;
  sub_job: string;
  sub_job_id: number;
  sub_job_level: number;
}

export interface BagItem {
  slot: number;
  id: number;
  count: number;
  status: number;
  equipped: boolean;
  /** /unequip slot name (main, l.ear, …) — set only when equipped */
  equip_slot?: string;
  extdata?: string;
  augments?: Array<string | Record<string, unknown>>;
}

export interface Bag {
  id: number;
  key: string;
  name: string;
  enabled: boolean;
  max: number;
  count: number;
  items: BagItem[];
}

export interface ItemMeta {
  id: number;
  name: string;
  name_log?: string;
  category?: string;
  level?: number;
  ilvl?: number;
  slots?: string[];
  slot_mask?: number;
  jobs?: string[];
  all_jobs?: boolean;
  jobs_mask?: number;
  flags?: number;
  rare?: boolean;
  ex?: boolean;
  stack?: number;
  type?: string | number;
  description?: string;
}

export interface InventoryState {
  timestamp: number;
  player?: PlayerInfo;
  bags: Bag[];
  catalog: Record<string, ItemMeta>;
}

export interface GearswapFileEntry {
  path: string; // relative to the gearswap data dir
  name: string;
  dir: string; // '' = data root, otherwise the player folder
}

export interface GearswapFileList {
  dir: string;
  found: boolean;
  files: GearswapFileEntry[];
}

export interface GearswapFileContent {
  path: string;
  content: string;
}

// ---------- FFXI macro files (USER/<content id>/mcr*.dat) ----------

export interface MacroEntry {
  /** button label, max 8 bytes */
  name: string;
  /** up to 6 command lines, max 60 bytes each; "[AT:xxxxxxxx]" marks an
   *  auto-translate phrase, "\xNN" a raw byte */
  lines: string[];
}

export interface MacroPalette {
  /** file index: mcr.dat = 0, mcrN.dat = N */
  index: number;
  file: string;
  book: number; // 1-40
  palette: number; // 1-10 within the book
  macros: MacroEntry[];
}

export interface MacroCharacter {
  /** content id — the USER/<id> folder name */
  id: string;
  /** book titles 1-40 (from mcr.ttl + mcr_2.ttl) */
  titles: string[];
  /** palettes that exist on disk; missing index = empty palette */
  palettes: MacroPalette[];
}

export interface MacroState {
  /** client is logged in — writes may be overwritten by the client on logout */
  logged_in: boolean;
  characters: MacroCharacter[];
}

// ---------- chat ----------

export interface ChatMessage {
  /** monotonic server-side sequence */
  seq: number;
  /** per-addon-load marker — changes on reload so clients resync */
  boot?: number;
  /** channel key: say|shout|yell|emote|party|linkshell|linkshell2|unity|
   *  battle|system|echo|assistj|assiste|tell */
  channel: string;
  /** sender name (for inbound tells this is the peer) */
  sender?: string;
  /** tell only: the other party — sender inbound, target outbound */
  peer?: string;
  text: string;
  /** unix seconds */
  ts?: number;
  /** sent via this UI (server-side local echo — tells only) */
  self?: boolean;
  /** flagged classification, e.g. 'learn' for spell/ability learning
   *  notices — renders highlighted and badges the channel row */
  kind?: string;
  /** capture mode the line arrived at — packet mode for 0x017 traffic,
   *  display-mode (color id) for incoming-text lines; surfaced on
   *  timestamp hover for classification debugging */
  mode?: number;
  /** replayed from the persisted on-disk log (data/chat_log.lua) —
   *  historical content: no unread badges */
  restored?: boolean;
  /** sender's zone — populated on yells (0x017 Zone field), where it
   *  answers "where is this person?" */
  zone?: string;
  /** control row, not a message: a thread was cleared — drop its
   *  messages client-side */
  cleared?: string;
}

export interface ChatHistory {
  seq: number;
  boot?: number;
  messages: ChatMessage[];
}

/** player-defined filter channel — a named set of source channels
 *  merged into one view; persisted addon-side via /api/chat/channels */
export interface ChatCustomChannel {
  name: string;
  channels: string[];
}

// ---------- journal (quests / missions / records of eminence) ----------

/** per-record metadata from journal_names.lua (extracted from client DATs) */
export interface JournalNameEntry {
  /** display name */
  n: string;
  /** repeatable flag ('+' prefixed in the client table) */
  r?: number;
  /** client/summary text */
  d?: string;
  /** RoE target count (objective goal) */
  t?: number;
  /** RoE subcategory id (key into roe_categories / a roe_tree child) */
  c?: number;
  /** sub-stage names for mission records (in order) */
  s?: string[];
}

export interface JournalNameGroup {
  name: string;
  /** log id -> record; ids are the packet bit positions / mission pointers */
  ids: Record<string, JournalNameEntry>;
}

export interface JournalNames {
  quest_areas: Record<string, JournalNameGroup>;
  mission_lines: Record<string, JournalNameGroup>;
  /** RoE objective id -> record */
  roe: Record<string, JournalNameEntry>;
  /** category id (top-level or subcategory) -> display name */
  roe_categories: Record<string, string>;
  /** the client's menu tree: top category id -> ordered subcategory ids */
  roe_tree?: Record<string, number[]>;
}

export interface JournalQuestArea {
  current: number[];
  done: number[];
}

export interface JournalMissionLine {
  /** current mission pointer (mapped id for cop/soa/rov), null = none */
  current: number | null;
  /** ids set via completed bitfields where the client exposes them */
  done: number[];
  /** true when the storyline has no completion packet — the UI treats
   *  every record id below `current` as completed */
  inferred_done?: boolean;
}

export interface JournalRoeObjective {
  id: number;
  progress: number;
  limited?: boolean;
}

export interface JournalState {
  char: string | null;
  nation?: number | null;
  updated: number;
  quests: Record<string, JournalQuestArea>;
  missions: Record<string, JournalMissionLine>;
  roe: {
    active: JournalRoeObjective[];
    done: number[];
  };
  /** 'kind:key:id' entries hidden from the detached tracker window —
   *  everything is tracked by default until the player disables it */
  untracked?: string[];
}

export interface RecastEntry {
  /** stable key — 'a<recast_id>' or 's<spell_id>' */
  k: string;
  /** 'a' = job ability, 's' = spell */
  t: 'a' | 's';
  /** display name */
  n: string;
  /** seconds remaining at the snapshot instant */
  r: number;
  /** full cooldown seconds (observed max; spell recast is the res floor) */
  m: number;
}

export interface RecastState {
  list: RecastEntry[];
}

// ---------- ability/spell book ----------

export interface AbilityEntry {
  id: number;
  /** display name */
  n: string;
  /** command prefix — '/jobability', '/weaponskill', '/pet', … */
  pfx: string;
  /** targets bitmask (res convention: 1 self, 32 enemy, 63 any player) */
  tg: number;
  mp?: number;
  tp?: number;
  /** range in yalms */
  rg?: number;
  dur?: number;
  /** JA recast_id — joins to RecastEntry.k = 'a<rid>' */
  rid?: number;
  /** acquisition type — Level | Merit | JP | … (ja_levels.lua) */
  ty?: string;
  /** main-job level at which it becomes available (subjob reqs ×2) */
  lvl?: number;
  /** job source: 'M' main job, 'S' subjob */
  j?: 'M' | 'S';
  /** canonical macro line from the wiki infobox, e.g. /ja "X" <me> */
  cmd?: string;
  /** menu icon id — served by /api/statusicon */
  ic?: number;
  /** name-keyed menu icon index — served by /api/menuicon (preferred) */
  mic?: number;
  /** element 0-7 — background tile color (weapon skills) */
  el?: number;
  /** 1 = learned */
  l?: number;
  /** kind: 'ja' job ability | 'ws' weapon skill */
  k: 'ja' | 'ws';
}

export interface SpellEntry {
  id: number;
  n: string;
  /** '/magic', '/ninjutsu', '/song', '/pet', … */
  pfx: string;
  tg: number;
  /** spell family — WhiteMagic, BlackMagic, Ninjutsu, Trust, … */
  ty?: string;
  sk?: number;
  el?: number;
  mp?: number;
  /** cast time / base recast, seconds */
  ct?: number;
  rc?: number;
  rg?: number;
  lvl?: number;
  j?: 'M' | 'S';
  /** menu icon id — served by /api/statusicon */
  ic?: number;
  /** item icon id — served by /api/icon (Trust role weapons) */
  iic?: number;
  /** name-keyed menu icon index — served by /api/menuicon (preferred) */
  mic?: number;
  /** Trust party-list name (differs from `n` on some alter egos) */
  pn?: string;
  l?: number;
  k: 'sp';
}

export interface AbilitiesPayload {
  /** absent/0 = logged out */
  on?: number;
  abilities?: AbilityEntry[];
  spells?: SpellEntry[];
}

// ---------- map / minimap ----------

export interface MapEntity {
  /** mob-array index — stable per entity, tiebreaks same-named rows */
  i?: number;
  /** display name (empty for some NPCs) */
  n?: string;
  /** position in map pixels (0..ms) */
  x: number;
  y: number;
  /** raw spawn_type (16 = monster, 1 = PC, 2 = NPC) */
  st: number;
  /** flags: 1 = in party, 2 = in alliance, 4 = is_npc, 8 = linkshell,
   *  16 = notorious monster (name-matched — the client never flags NMs) */
  f: number;
  /** hp percent (0..100) */
  hp: number;
  /** distance in yalms */
  d: number;
  /** height delta vs the player in yalms (+ above, - below); absent
   *  when the entity's height isn't known */
  el?: number;
}

export interface MapWsEntry {
  /** entity index (0-based within zone) */
  i: number;
  /** level (0/1 on NPCs) */
  l: number;
  /** widescan type byte */
  t: number;
  /** world-yalm deltas from the player at scan time (0x0F4) — kept raw;
   *  rendering uses the projected wx/wy */
  x: number;
  y: number;
  n?: string;
  /** 1 when the name is in the NM table (name-matched) */
  nm?: number;
  /** 1 when this is the target the client is tracking */
  tr?: number;
  /** absolute map px — projected from the world-yalm deltas at receipt,
   *  refreshed by 0x0F5 live track updates */
  wx?: number;
  wy?: number;
  /** height delta vs the player — only track updates (0x0F5) carry a
   *  live height, so most entries never set it */
  el?: number;
}

export interface MapState {
  /** 0 = not logged in / un-mapped area */
  on?: number;
  /** zone id + name */
  z?: number;
  zn?: string;
  /** sub-map id (zones with multiple maps, else 0) */
  m?: number;
  /** map pixel space the client projects into (512, 1024 for hi-res mods) */
  ms?: number;
  /** player: map px + facing (radians, 0 = east, increasing clockwise) */
  me?: { x: number; y: number; f: number };
  /** player's grid coord, e.g. 'F-10' — the client's own pos string */
  pos?: string;
  /** entities in render range */
  e?: MapEntity[];
  /** widescan entries (wx/wy absolute map px; x/y raw world deltas) */
  ws?: MapWsEntry[];
  /** 1 while a widescan result list is held */
  wsa?: number;
}

// ---------- party / target (party.lua) ----------

export interface PartyBuff {
  i: number;
  n?: string;
}

export interface PartyMember {
  n: string;
  /** hp/mp percentages, tp raw */
  hp: number;
  mp: number;
  tp: number;
  /** raw current hp/mp (exact for the player, packet-derived for others) */
  hc?: number;
  mc?: number;
  /** max hp/mp — exact for the player via vitals, derived from the
   *  floored percentage for others */
  hx?: number;
  mx?: number;
  /** 1 = out of zone */
  o?: number;
  /** 1 = party/alliance leader */
  l?: number;
  /** main job abbrev ('WAR') + level — self via get_player, others from
   *  the 0x0DD/0x0DF update feed */
  j?: string;
  jl?: number;
  /** sub job abbrev + level */
  sj?: string;
  sjl?: number;
  /** Trust role tag (TNK/HLR/RNG/CST/SUP/DD) — trusts have no job packets */
  tr?: string;
  b?: PartyBuff[];
}

export interface TargetCast {
  /** actor id */
  a: number;
  /** actor name (resolved via get_mob_by_id — match fallback) */
  an?: string;
  /** actor is the local player (id or zone-index match) */
  own?: 1;
  n: string;
  /** unix seconds when the cast lands */
  t: number;
  /** total cast duration (s) */
  d: number;
}

export interface TargetState {
  i: number;
  n: string;
  hpp?: number;
  tp?: number;
  /** claim status: 0 unclaimed, 1 self, 2 party, 3 someone else's */
  cl?: number;
  cast?: TargetCast;
}

/** one live skillchain (prediction, per target) — etas are unix secs */
export interface ScChain {
  /** active chainable elements — WS props at lv0, the formed SC after */
  e: string[];
  /** 0 = WS root (no chain formed yet), 1-4 = formed chain level */
  lv: number;
  /** display name — formed SC element or the root WS name */
  n: string;
  /** last actor + weapon skill that opened/extended the chain */
  an?: string;
  w?: string;
  /** chain target's display name */
  tg?: string;
  /** unix time the chain formed/started */
  t: number;
  /** chain window opens / closes */
  o: number;
  c: number;
  /** magic-burst window end (set once a chain actually forms) */
  b?: number;
}

export interface ScEvent {
  an?: string;
  ws: string;
  /** formed skillchain element, if this WS chained */
  sc?: string;
  /** target name */
  tg?: string;
  /** unix time of the action */
  t: number;
}

export interface PartyState {
  on?: number;
  /** party / alliance 1 / alliance 2 rows */
  p?: PartyMember[];
  a1?: PartyMember[];
  a2?: PartyMember[];
  t?: TargetState;
  /** the player's mob id — lets the UI skip its own casts */
  me?: number;
  /** any cast currently being tracked (actor may not be the target) */
  cast?: TargetCast;
  /** skillchain / magic-burst tracking — active chains + recent WSs */
  sc?: {
    c?: ScChain[];
    h?: ScEvent[];
    /** WSs the current equipment allows: id, name, chainable props */
    ws?: { i: number; n: string; p: string[] }[];
  };
}
