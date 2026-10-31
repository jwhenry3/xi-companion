import { Injectable, inject, signal, DestroyRef } from '@preact-mvc/core';
import { queryClient } from './query';
import {
  eventsSocketURL,
  openXportSocket,
  type XportSocket,
} from './xport-socket';
import type {
  InventoryState,
  GearswapFileList,
  GearswapFileContent,
  MacroState,
  MacroEntry,
  ChatMessage,
  ChatHistory,
  ChatCustomChannel,
  JournalState,
  JournalNames,
  ItemMeta,
  RecastState,
  MapState,
  PartyState,
  AbilitiesPayload,
} from './types';

// In production the addon serves this UI itself, so same-origin is correct.
// For `vite dev`, set VITE_GSUI_API or rely on the dev-server proxy for /api.
const API_BASE: string =
  (import.meta.env.VITE_GSUI_API as string | undefined) ?? '';

async function directReq<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

@Injectable({ providedIn: 'root' })
export class AddonApi {
  readonly state = signal<InventoryState | null>(null);
  readonly connected = signal(false);
  readonly files = signal<GearswapFileList | null>(null);
  readonly lastError = signal<string | null>(null);

  private es: EventSource | null = null;
  private ws: XportSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private removeListeners?: () => void;
  /** last SSE message of any kind — the addon pings every 25s */
  private lastEventAt = 0;
  private resyncAt = 0;

  // transport: every window owns its own channel — the xport ws under
  // the overlay (a real socket; the ~6-conn/origin cap doesn't apply,
  // and the Go side dedupes in-flight GETs), fetch+EventSource in a
  // browser tab
  private req: typeof directReq = directReq;
  /** same-origin window bus — 'macros' means another window wrote macro
   *  files (editor save/title); refetch so sibling views (the detached
   *  macro bars) update without waiting on the SSE/file-watch round
   *  trip. Same origin + shared profile = reaches every panel. */
  private bc: BroadcastChannel | null =
    typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel('xicompanion')
      : null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.disconnect());
    if (this.bc) {
      this.bc.onmessage = (e) => {
        if (e.data === 'macros') void this.refreshMacros();
      };
    }
    this.connect();
    void this.refreshFiles();
    this.pollTimer = setInterval(() => void this.tick(), 3000);
    // returning to a window is the cheapest possible resync trigger
    const onVis = () => {
      if (document.visibilityState === 'visible') void this.resync();
    };
    const onFocus = () => void this.resync();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    this.removeListeners = () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
    };
  }

  private disconnect() {
    this.es?.close();
    const stale = this.ws;
    this.ws = null;
    stale?.socket.close();
    this.bc?.close();
    if (this.pollTimer != null) clearInterval(this.pollTimer);
    this.removeListeners?.();
  }

  private connect() {
    void this.route();
  }

  // The xport probe answers only under the wails overlay's assetserver
  // — a ws per window there; everywhere else it's the plain
  // fetch + EventSource surface (browser tab / Lua http server).
  private async route() {
    try {
      const wsUrl = await eventsSocketURL(API_BASE);
      if (wsUrl) {
        this.connectWs(wsUrl);
        return;
      }
    } catch {}
    this.connectDirect();
  }

  // overlay xport mode: the assetserver buffers whole responses, so a
  // held EventSource can never deliver — the ws socket carries events
  private connectWs(wsUrl: string) {
    const sock = (this.ws = openXportSocket(wsUrl, {
      onEvent: (e, d) => {
        if (sock !== this.ws) return;
        this.lastEventAt = Date.now();
        this.dispatchSse(e, d);
      },
      onState: (ok) => {
        if (sock === this.ws) this.onConn(ok);
      },
      onDead: () => {
        if (sock !== this.ws) return;
        this.ws = null;
        // EventSource self-reconnects; a socket needs an explicit retry
        setTimeout(() => {
          if (this.ws == null) this.connect();
        }, 2000);
      },
    }));
    void this.refreshChat();
  }

  private connectDirect() {
    const es = new EventSource(`${API_BASE}/api/events`);
    this.es = es;
    const bump = () => (this.lastEventAt = Date.now());
    for (const e of [
      'ping', 'state', 'chat', 'journal', 'recasts', 'map', 'party',
      'macrosel', 'macros',
    ]) {
      es.addEventListener(e, (ev) => {
        bump();
        this.dispatchSse(e, (ev as MessageEvent).data);
      });
    }
    void this.refreshChat();
    es.onopen = () => this.onConn(true);
    es.onerror = () => this.onConn(false);
  }

  /** SSE event fan-in — the xport socket's `sse` frames and the
   *  EventSource fallback both land here */
  private dispatchSse(e: string, d: string) {
    try {
      switch (e) {
        case 'state':
          this.state.value = JSON.parse(d);
          this.connected.value = true;
          break;
        case 'chat': {
          const m = JSON.parse(d);
          // linkshell-name updates carry no seq — a metadata payload,
          // not a message row
          if (m.linkshells) {
            this.chatLs.value = m.linkshells;
            break;
          }
          this.ingestChat(m);
          break;
        }
        case 'journal':
          this.journal.value = JSON.parse(d);
          break;
        case 'recasts':
          this.recasts.value = {
            ...(JSON.parse(d) as RecastState),
            at: Date.now(),
          };
          break;
        case 'map':
          this.map.value = JSON.parse(d);
          break;
        case 'party':
          this.party.value = JSON.parse(d);
          break;
        case 'macrosel':
          this.macroSel.value = JSON.parse(d);
          break;
        case 'macros':
          // macro files changed addon-side (editor PUT, in-game
          // book/page switch, external edit) — refetch palettes
          void this.refreshMacros();
          break;
        case 'chatfocus':
          this.chatFocus.value = this.chatFocus.value + 1;
          break;
        // 'ping' — just the lastEventAt bump handled by the caller
      }
    } catch {
      // malformed payload; ignore
    }
  }

  /** stream open/closed — the worker's `conn` messages and the
   *  fallback's onopen/onerror both land here */
  private onConn(ok: boolean) {
    this.lastEventAt = Date.now();
    this.connected.value = ok;
    if (ok) {
      // fires on every (re)connect — resyncs after an addon reload even
      // when no chat arrived while we were away
      void this.refreshChat();
      void this.refreshChatChannels();
      void this.refreshJournal();
      void this.refreshRecasts();
      void this.refreshMap();
      void this.refreshParty();
    }
  }

  /** interval driver — watchdog + resync so a dead-looking-but-open
   *  stream can't leave the page permanently stale */
  private tick() {
    const now = Date.now();
    if (this.connected.value) {
      // the addon emits `ping` every 25s; >75s of silence means the
      // conn died without the browser noticing — rebuild it
      if (now - this.lastEventAt > 75_000) {
        this.es?.close();
        this.connect();
        return;
      }
      // journal resync every 20s — SSE pushes instantly when healthy;
      // this is the net for half-open conns that deliver nothing
      if (now - this.resyncAt > 20_000) {
        this.resyncAt = now;
        void this.refreshJournal();
      }
      return;
    }
    // fallback polling while the event stream is down
    void this.resync().then((ok) => (this.connected.value = ok));
  }

  /** pull the current state + journal snapshots — focus handler and
   *  the disconnected fallback both go through here */
  private async resync(): Promise<boolean> {
    try {
      const [st, j] = await Promise.all([
        this.req<InventoryState>('/api/state'),
        this.req<JournalState>('/api/journal'),
      ]);
      this.state.value = st;
      const cur = this.journal.value;
      if (!cur || (j.updated ?? 0) >= (cur.updated ?? 0)) {
        this.journal.value = j;
      }
      this.lastError.value = null;
      return true;
    } catch (e) {
      this.lastError.value = String(e);
      return false;
    }
  }

  async refreshFiles() {
    this.files.value = await queryClient.fetchQuery({
      queryKey: ['gearswap-files'],
      queryFn: () => this.req<GearswapFileList>('/api/gearswap/files'),
    });
  }

  readFile(path: string) {
    return queryClient.fetchQuery({
      queryKey: ['gearswap-file', path],
      queryFn: () =>
        this.req<GearswapFileContent>(
          `/api/gearswap/file?path=${encodeURIComponent(path)}`,
        ),
      // profile lua can change under us (game-side edits) — dedupe
      // concurrent reads but always pull fresh bytes
      staleTime: 0,
    });
  }

  async saveFile(path: string, content: string) {
    await this.req<{ ok: boolean }>(
      `/api/gearswap/file?path=${encodeURIComponent(path)}`,
      { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content },
    );
    await queryClient.invalidateQueries({
      queryKey: ['gearswap-file', path],
    });
    await queryClient.invalidateQueries({ queryKey: ['gearswap-files'] });
  }

  async reloadGearswap() {
    await this.req<{ ok: boolean }>('/api/gearswap/reload', { method: 'POST' });
  }

  /** run a windower command, e.g. `gs equip sets.idle` */
  async sendCommand(cmd: string) {
    await this.req<{ ok: boolean }>('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd }),
    });
  }

  /** item action needing packet injection — drop / move between bags /
   *  unequip (no /unequip client command exists) */
  async itemAction(payload: {
    action: 'drop' | 'move' | 'unequip';
    bag?: number;
    index?: number;
    count?: number;
    target?: number;
    /** unequip: windower slot name — 'main', 'l.ear', 'r.ring', … */
    slot?: string;
  }) {
    await this.req<{ ok: boolean }>('/api/item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** item icon (extracted bmp served by the addon); 404s until extracted */
  iconUrl(id: number): string {
    return `${API_BASE}/api/icon?id=${id}`;
  }

  /** status-effect icon (buff DAT extract, same bmp pipeline) */
  statusIconUrl(id: number): string {
    return `${API_BASE}/api/statusicon?id=${id}`;
  }

  /** menu spell/JA icon (ROM/280/15+324/95, pre-extracted DXT3 bmp) */
  menuIconUrl(id: number): string {
    return `${API_BASE}/api/menuicon?id=${id}`;
  }

  /** weapon-class tile from the misc/ws sprite sheet */
  wsIconUrl(tile: number): string {
    return `${API_BASE}/api/menuicon?ws=${tile}`;
  }

  /** raw per-id item meta fetch — use inside a queryFn. `itemMeta()` below
   *  nests fetchQuery on the same `['itemmeta', id]` key, and a queryFn that
   *  awaits its own in-flight query deadlocks (verified — never resolves). */
  fetchItemMeta(id: number): Promise<ItemMeta> {
    return this.req<ItemMeta>(`/api/itemmeta?id=${id}`);
  }

  /** full item meta incl. the client's description text (stats/passives
   *  live in the blue-text, which isn't in res.items). Static per id —
   *  fetched lazily so it stays out of the SSE state broadcast. */
  itemMeta(id: number): Promise<ItemMeta | undefined> {
    return queryClient
      .fetchQuery({
        queryKey: ['itemmeta', id],
        queryFn: () => this.req<ItemMeta>(`/api/itemmeta?id=${id}`),
        staleTime: Infinity,
        gcTime: Infinity,
      })
      .catch(() => undefined);
  }

  // ---------- chat ----------

  /** unified chat log (bounded client-side mirror of the addon's ring buffer) */
  readonly chat = signal<ChatMessage[]>([]);
  /** active thread key the chat view is looking at: channel name or tell:<peer> */
  readonly activeChat = signal('all');
  /** unread counts per thread key */
  readonly chatUnread = signal<Record<string, number>>({});
  /** unread flagged (kind) messages per thread — the sidebar ★ badge */
  readonly chatAlerts = signal<Record<string, number>>({});
  /** player-defined filter channels (custom:<name> thread keys) */
  readonly chatCustom = signal<ChatCustomChannel[]>([]);
  /** equipped linkpearl names [ls1, ls2, ls3] — labels the ls channels */
  readonly chatLs = signal<string[]>([]);

  private chatSeq = 0;
  private chatBoot = 0;

  /** thread a message belongs to — tells are DMs keyed by peer */
  chatThread(m: ChatMessage): string {
    return m.channel === 'tell' ? `tell:${m.peer ?? m.sender ?? ''}` : m.channel;
  }

  /** every thread a message feeds: its own channel/DM plus any custom
   *  channel listing that channel. ('all' is view-only, never badges) */
  chatThreadsFor(m: ChatMessage): string[] {
    const out = [this.chatThread(m)];
    for (const c of this.chatCustom.value) {
      if (c.channels.includes(m.channel)) out.push(`custom:${c.name}`);
    }
    return out;
  }

  private localSeq = 0;

  /** append a local-only line (composer '//echo' — windower console
   *  output never enters the game log). Negative seq keeps it clear of
   *  the server's seq ordering and the ingest dedupe. */
  injectLocal(channel: string, text: string) {
    const m: ChatMessage = {
      seq: --this.localSeq,
      boot: this.chatBoot,
      channel,
      text,
      self: true,
      ts: Math.floor(Date.now() / 1000),
    };
    const log = [...this.chat.value, m];
    if (log.length > 800) log.splice(0, log.length - 800);
    this.chat.value = log;
  }

  private ingestChat(m: ChatMessage) {
    // the addon restarts its seq on reload — a changed boot marker means
    // our seq/log are stale, so reset before the dedupe check drops
    // every new message
    if (m.boot && m.boot !== this.chatBoot) {
      this.chatBoot = m.boot;
      this.chatSeq = 0;
      this.chat.value = [];
      this.chatUnread.value = {};
      this.chatAlerts.value = {};
    }
    if (m.seq <= this.chatSeq) return; // SSE + catch-up fetch can race
    this.chatSeq = m.seq;
    if (m.cleared) {
      if (m.cleared === '*') {
        this.chat.value = [];
        this.chatUnread.value = {};
        this.chatAlerts.value = {};
      } else {
        this.dropChatThread(m.cleared);
      }
      return;
    }
    const log = [...this.chat.value, m];
    if (log.length > 800) log.splice(0, log.length - 800);
    this.chat.value = log;
    // persisted history replays quietly — badges belong to live traffic
    if (m.restored) return;
    for (const thread of this.chatThreadsFor(m)) {
      if (thread === this.activeChat.value) continue;
      if (!m.self) {
        this.chatUnread.value = {
          ...this.chatUnread.value,
          [thread]: (this.chatUnread.value[thread] ?? 0) + 1,
        };
      }
      // flagged messages badge even when `self` — your own blue-magic
      // learn notice is exactly what the alert is for
      if (m.kind) {
        this.chatAlerts.value = {
          ...this.chatAlerts.value,
          [thread]: (this.chatAlerts.value[thread] ?? 0) + 1,
        };
      }
    }
  }

  /** initial load + reconnect catch-up (SSE covers the live tail) */
  async refreshChat() {
    let h = await this.req<ChatHistory>(`/api/chat?after=${this.chatSeq}`);
    if (h.boot && h.boot !== this.chatBoot) {
      // addon reloaded — seqs restarted; reset and pull the fresh log
      this.chatBoot = h.boot;
      this.chatSeq = 0;
      this.chat.value = [];
      this.chatUnread.value = {};
      this.chatAlerts.value = {};
      h = await this.req<ChatHistory>('/api/chat?after=0');
    }
    for (const m of h.messages) this.ingestChat(m);
  }

  /** clear the unread + alert badges for a thread */
  markChatRead(thread: string) {
    const { [thread]: _u, ...restUnread } = this.chatUnread.value;
    this.chatUnread.value = restUnread;
    const { [thread]: _a, ...restAlerts } = this.chatAlerts.value;
    this.chatAlerts.value = restAlerts;
  }

  /** wipe a thread's messages + badges locally (driven by the
   *  `cleared` control row so every window stays in sync) */
  private dropChatThread(thread: string) {
    this.chat.value = this.chat.value.filter(
      (m) => this.chatThread(m) !== thread,
    );
    this.markChatRead(thread);
  }

  /** clear a channel/DM's history — addon-side and in every window */
  async clearChat(thread: string) {
    await this.req<{ ok: boolean }>('/api/chat/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread }),
    });
  }

  /** send a chat message as if typed into the game's chat line */
  async sendChat(channel: string, text: string, to?: string) {
    await this.req<{ ok: boolean }>('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text, to }),
    });
  }

  /** pull the player's custom filter channels (addon-persisted) */
  async refreshChatChannels() {
    const r = await this.req<{ channels?: ChatCustomChannel[] }>(
      '/api/chat/channels',
    );
    this.chatCustom.value = r.channels ?? [];
  }

  /** replace the whole custom-channel set (create/edit/delete all
   *  funnel through one write) */
  async saveChatChannels(list: ChatCustomChannel[]) {
    const r = await this.req<{ channels?: ChatCustomChannel[] }>(
      '/api/chat/channels',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: list }),
      },
    );
    this.chatCustom.value = r.channels ?? list;
  }

  /** mount count for the spacebar→chat-focus steal — the addon only
   *  intercepts the key while at least one chat view is mounted */
  async chatFocusWindow(open: boolean) {
    await this.req<{ ok: boolean }>('/api/chatfocus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open }),
    });
  }

  /** bumped by the addon's 'chatfocus' SSE event (spacebar steal) —
   *  chat views watch it to raise + focus the composer */
  readonly chatFocus = signal(0);

  // ---------- journal (quests / missions / RoE) ----------

  /** live journal state — seeded on SSE connect, updated by `journal` events */
  readonly journal = signal<JournalState | null>(null);

  /** static id->name/description tables extracted from the client DATs —
   *  fetched once, ~1MB over localhost */
  journalNames(): Promise<JournalNames> {
    return queryClient.fetchQuery({
      queryKey: ['journal-names'],
      queryFn: () => this.req<JournalNames>('/api/journal/names'),
      staleTime: Infinity,
    });
  }

  async refreshJournal() {
    const j = await queryClient.fetchQuery({
      queryKey: ['journal'],
      queryFn: () => this.req<JournalState>('/api/journal'),
      // resync callers need the wire, not a warm cache
      staleTime: 0,
    });
    // don't stomp newer SSE-delivered state with an older snapshot
    const cur = this.journal.value;
    if (!cur || (j.updated ?? 0) >= (cur.updated ?? 0)) {
      this.journal.value = j;
    }
  }

  /** ask the server to re-broadcast the journal snapshot over SSE —
   *  covers the reload race where the diff-gated flush fired while
   *  this window's link was down (server is the authority, no cache) */
  pokeJournal() {
    void this.req('/api/journal/refresh', { method: 'POST' }).catch(() => {});
  }

  /** set/cancel an RoE objective — injects the client's menu packets
   *  (0x10C/0x10D); the server replies with a fresh 0x111 which lands
   *  back in `journal` via SSE. Must be logged in. */
  async roeAction(id: number, action: 'set' | 'clear') {
    await this.req<{ ok: boolean }>('/api/journal/roe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
  }

  /** toggle an entry's or a whole group's visibility in the detached
   *  tracker window — omit id to toggle the group (future items in it
   *  stay hidden too). Persists per character; lands back via SSE */
  async setTracked(
    kind: 'quest' | 'mission' | 'roe',
    key: string,
    id: number | undefined,
    tracked: boolean,
  ) {
    await this.req<{ ok: boolean }>('/api/journal/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, key, id, tracked }),
    });
  }

  // ---------- recasts (cooldowns window) ----------

  /** ability/spell cooldowns — `at` stamps when the snapshot arrived so
   *  views can count `r` down locally between SSE updates */
  readonly recasts = signal<(RecastState & { at: number }) | null>(null);

  async refreshRecasts() {
    const r = await queryClient.fetchQuery({
      queryKey: ['recasts'],
      queryFn: () => this.req<RecastState>('/api/recasts'),
      staleTime: 0,
    });
    this.recasts.value = { ...r, at: Date.now() };
  }

  // ---------- map / minimap ----------

  /** player position + nearby entities + widescan — SSE `map` event is
   *  the live feed (~4Hz while moving); this is the snapshot path */
  readonly map = signal<MapState | null>(null);

  async refreshMap() {
    const r = await queryClient.fetchQuery({
      queryKey: ['map'],
      queryFn: () => this.req<MapState>('/api/map'),
      staleTime: 0,
    });
    this.map.value = r;
  }

  // ---------- abilities (skill/spell book) ----------

  /** obtainable+learned JA/WS/spells for the current job — keyed by job
   *  ids so the query cache refetches on job change */
  async fetchAbilities(
    mainJob: number,
    subJob: number,
  ): Promise<AbilitiesPayload> {
    return queryClient.fetchQuery({
      queryKey: ['abilities', mainJob, subJob],
      queryFn: () => this.req<AbilitiesPayload>('/api/abilities'),
      staleTime: 30_000,
    });
  }

  // ---------- party / target HUD ----------

  /** member vitals+buffs, target HP, cast bar — SSE `party` event is
   *  the live feed; this is the snapshot/reconnect pull */
  readonly party = signal<PartyState | null>(null);

  async refreshParty() {
    const r = await queryClient.fetchQuery({
      queryKey: ['party'],
      queryFn: () => this.req<PartyState>('/api/party'),
      staleTime: 0,
    });
    this.party.value = r;
  }

  async meterReset() {
    await this.req<{ ok: boolean }>('/api/meter/reset', { method: 'POST' });
  }

  /** ask the server for a widescan refresh (same packet the map menu's
   *  Widescan option sends); results stream back via the `map` event */
  async mapScan() {
    await this.req<{ ok: boolean }>('/api/map/scan', { method: 'POST' });
  }

  /** zone map image — data/maps/<z>_<m>.png on the addon side; 404s
   *  until the user drops a file there (remapster FFXIDB pack naming) */
  mapImgUrl(zone: number, mapId: number): string {
    return `${API_BASE}/api/map/img?z=${zone}&m=${mapId}`;
  }

  /** persisted addon settings (data/settings.xml) — flat scalar keys */
  settingsGet(): Promise<Record<string, number | boolean | string>> {
    return this.req<Record<string, number | boolean | string>>('/api/settings');
  }

  async settingsSave(patch: Record<string, number | boolean | string>) {
    await this.req<{ ok: boolean }>('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  /** auto-translate phrase names for the composer's Tab autocomplete —
   *  fetched once, the addon resolves name -> wire id on send */
  chatPhrases(): Promise<string[]> {
    return queryClient.fetchQuery({
      queryKey: ['chat-phrases'],
      queryFn: () =>
        this.req<{ phrases: string[] }>('/api/chat/phrases').then(
          (r) => r.phrases,
        ),
      staleTime: Infinity,
    });
  }

  // ---------- FFXI macro files ----------

  readonly macros = signal<MacroState | null>(null);

  /** in-game active palette per char dir — the client writes mcr.sys on
   *  every book/page switch; the addon polls it and pushes `macrosel`
   *  events so the macro bar can follow. {charId: {b, p}} */
  readonly macroSel = signal<Record<string, { b: number; p: number }>>(
    {},
  );

  async refreshMacros() {
    this.macros.value = await queryClient.fetchQuery({
      queryKey: ['macros'],
      queryFn: () => this.req<MacroState>('/api/macros'),
    });
  }

  async refreshMacroSel() {
    this.macroSel.value = await this.req('/api/macrosel');
  }

  /** write one palette page (20 macros) to mcr<index>.dat.
   *  apply=true asks the addon to force the client to re-read the book:
   *  it switches the client to another book, writes the file while the
   *  book is unloaded, then switches back and selects the page. */
  async savePalette(
    char: string,
    index: number,
    macros: MacroEntry[],
    apply = false,
  ) {
    const res = await this.req<{
      ok: boolean;
      file: string;
      applied?: boolean;
      logged_in: boolean;
    }>(`/api/macros/palette${apply ? '?apply=1' : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ char, index, macros }),
    });
    await queryClient.invalidateQueries({ queryKey: ['macros'] });
    void this.refreshMacros();
    this.bc?.postMessage('macros');
    return res;
  }

  /** replay one macro cell's lines through the client input line —
   *  what clicking a bar button in the detached macro window does */
  async runMacro(char: string, index: number, cell: number) {
    return this.req<{ ok: boolean; logged_in: boolean }>('/api/macros/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ char, index, cell }),
    });
  }

  /** rename a macro book title (book 1-40) */
  async saveMacroTitle(char: string, book: number, title: string) {
    const res = await this.req<{ ok: boolean; logged_in: boolean }>(
      '/api/macros/title',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ char, book, title }),
      },
    );
    await queryClient.invalidateQueries({ queryKey: ['macros'] });
    void this.refreshMacros();
    this.bc?.postMessage('macros');
    return res;
  }
}
