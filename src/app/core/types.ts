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
  /** channel key: say|shout|yell|party|linkshell|linkshell2|unity|emote|assist|tell */
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
}

export interface ChatHistory {
  seq: number;
  boot?: number;
  messages: ChatMessage[];
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
  /** training regime pages by zone display name (bg-wiki extract) */
  regimes?: {
    fov?: Record<string, RegimePage[]>;
    gov?: Record<string, RegimePage[]>;
  };
}

export interface RegimePage {
  page: number;
  desc: string;
  needs: number[];
  low: number;
  high: number;
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

export interface JournalValor {
  kind: 'fov' | 'gov';
  zone: number;
  zone_name?: string;
  page: number;
  /** objective text, e.g. '5 Scarab Beetles + 1 Forest Funguar' */
  desc?: string;
  /** required count per objective */
  needs: number[];
  /** live kill progress per objective */
  killed: number[];
  low?: number;
  high?: number;
  done?: boolean;
  /** server-side regime id, when a menu echo revealed it */
  regime?: number;
  accepted?: number;
  /** last progress message that didn't match a known objective */
  last?: { killed: number; needed: number };
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
  /** active Fields/Grounds of Valor training regime, if any */
  valor?: JournalValor | null;
  /** tabs currency from the 0x113 currency packet */
  valor_points?: number;
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

// ---------- map / minimap ----------

export interface MapEntity {
  /** display name (empty for some NPCs) */
  n?: string;
  /** position in map pixels (0..ms) */
  x: number;
  y: number;
  /** raw spawn_type (16 = monster, 1 = PC, 2 = NPC) */
  st: number;
  /** flags: 1 = in party, 2 = in alliance, 4 = is_npc */
  f: number;
  /** hp percent (0..100) */
  hp: number;
  /** distance in yalms */
  d: number;
}

export interface MapWsEntry {
  /** entity index (0-based within zone) */
  i: number;
  /** level (0/1 on NPCs) */
  l: number;
  /** widescan type byte */
  t: number;
  /** map-pixel offset relative to the player's map position */
  x: number;
  y: number;
  n?: string;
  /** 1 when this is the target the client is tracking */
  tr?: number;
  /** absolute map px — filled by 0x0F5 live track updates */
  wx?: number;
  wy?: number;
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
  /** entities in render range */
  e?: MapEntity[];
  /** widescan entries (relative offsets; wx/wy when tracked) */
  ws?: MapWsEntry[];
  /** 1 while a widescan result list is held */
  wsa?: number;
}
