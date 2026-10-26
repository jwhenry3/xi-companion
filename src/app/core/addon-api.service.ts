import { Injectable, inject, signal, DestroyRef } from '@preact-mvc/core';
import { queryClient } from './query';
import type {
  InventoryState,
  GearswapFileList,
  GearswapFileContent,
  MacroState,
  MacroEntry,
  ChatMessage,
  ChatHistory,
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
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private removeListeners?: () => void;
  /** last SSE message of any kind — the addon pings every 25s */
  private lastEventAt = 0;
  private resyncAt = 0;

  // transport: proxied through the bridge SharedWorker when it attaches
  // (one SSE + one request queue for ALL windows — Chromium's ~6
  // connection-per-origin cap made per-window streams starve fetches);
  // direct fetch/EventSource is the fallback
  private req: typeof directReq = directReq;
  private wport: MessagePort | null = null;
  /** worker script failed at runtime — don't retry every reconnect */
  private bridgeFailed = false;
  private reqSeq = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.disconnect());
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
    this.wport?.postMessage({ t: 'close' });
    this.wport?.close();
    if (this.pollTimer != null) clearInterval(this.pollTimer);
    this.removeListeners?.();
  }

  private connect() {
    if (this.attachBridge()) return;
    // direct path — one EventSource for this window only. Reached when
    // SharedWorker is unavailable (old WebView2 runtimes, tests).
    this.req = directReq;
    const es = new EventSource(`${API_BASE}/api/events`);
    this.es = es;
    const bump = () => (this.lastEventAt = Date.now());
    for (const e of [
      'ping', 'state', 'chat', 'journal', 'recasts', 'map', 'party',
      'macrosel',
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

  /** SharedWorker transport — attaches a port to the single bridge
   *  worker that owns the one SSE stream + request queue shared by
   *  every window (main, panels, tooltip, spawned tabs). New ports get
   *  the cached snapshot events replayed so a just-spawned window
   *  hydrates without extra fetches. */
  private attachBridge(): boolean {
    if (this.bridgeFailed || typeof SharedWorker !== 'function') return false;
    try {
      const w = new SharedWorker(
        new URL('./bridge.worker.ts', import.meta.url),
        { type: 'module' },
      );
      const port = w.port;
      let alive = false;
      const fail = () => {
        if (alive || this.wport !== port) return;
        // worker script errored or produced nothing — requests would
        // hang on a dead port, so tear down and use the direct path
        this.bridgeFailed = true;
        this.dropBridge(port);
        this.connect();
      };
      // a script-level failure surfaces here; a load that silently
      // produces no messages is caught by the timeout — the worker
      // always posts a `conn` as its first message on attach
      w.onerror = fail;
      setTimeout(fail, 3000);
      port.onmessage = (m) => {
        alive = true;
        this.onBridgeMessage(m.data);
      };
      port.start();
      this.wport = port;
      this.req = this.workerReq;
      return true;
    } catch {
      this.wport = null;
      return false;
    }
  }

  /** tear down a dead bridge port — pending calls reject rather than
   *  hang, and the transport returns to direct fetch */
  private dropBridge(port: MessagePort) {
    if (this.wport === port) this.wport = null;
    try {
      port.close();
    } catch {
      // already dead
    }
    for (const [, p] of this.pending) p.reject(new Error('bridge lost'));
    this.pending.clear();
    this.req = directReq;
  }

  private workerReq: typeof directReq = <T>(
    path: string,
    init?: RequestInit,
  ) =>
    new Promise<T>((resolve, reject) => {
      const port = this.wport;
      if (!port) return reject(new Error('bridge disconnected'));
      const id = ++this.reqSeq;
      this.pending.set(id, { resolve, reject });
      port.postMessage({
        t: 'req',
        id,
        method: init?.method ?? 'GET',
        path,
        headers: init?.headers as Record<string, string> | undefined,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
    });

  private onBridgeMessage(msg: any) {
    if (msg?.t === 'res') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.ok) {
          try {
            p.resolve(JSON.parse(msg.body));
          } catch {
            p.resolve(msg.body);
          }
        } else {
          p.reject(new Error(`${msg.status}: ${msg.body}`));
        }
      }
      return;
    }
    if (msg?.t === 'sse') {
      this.lastEventAt = Date.now();
      this.dispatchSse(msg.e, msg.d);
      return;
    }
    if (msg?.t === 'conn') this.onConn(msg.ok);
  }

  /** SSE event fan-in — the worker's `sse` messages and the fallback
   *  EventSource both land here */
  private dispatchSse(e: string, d: string) {
    try {
      switch (e) {
        case 'state':
          this.state.value = JSON.parse(d);
          this.connected.value = true;
          break;
        case 'chat':
          this.ingestChat(JSON.parse(d));
          break;
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
      // conn died without the browser noticing — rebuild it (the bridge
      // worker runs this watchdog itself; only the direct path needs it)
      if (!this.wport && now - this.lastEventAt > 75_000) {
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
  readonly activeChat = signal('party');
  /** unread counts per thread key */
  readonly chatUnread = signal<Record<string, number>>({});

  private chatSeq = 0;
  private chatBoot = 0;

  /** thread a message belongs to — tells are DMs keyed by peer */
  chatThread(m: ChatMessage): string {
    return m.channel === 'tell' ? `tell:${m.peer ?? m.sender ?? ''}` : m.channel;
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
    }
    if (m.seq <= this.chatSeq) return; // SSE + catch-up fetch can race
    this.chatSeq = m.seq;
    const log = [...this.chat.value, m];
    if (log.length > 800) log.splice(0, log.length - 800);
    this.chat.value = log;
    const thread = this.chatThread(m);
    if (!m.self && thread !== this.activeChat.value) {
      this.chatUnread.value = {
        ...this.chatUnread.value,
        [thread]: (this.chatUnread.value[thread] ?? 0) + 1,
      };
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
      h = await this.req<ChatHistory>('/api/chat?after=0');
    }
    for (const m of h.messages) this.ingestChat(m);
  }

  /** clear the unread badge for a thread */
  markChatRead(thread: string) {
    if (!this.chatUnread.value[thread]) return;
    const { [thread]: _, ...rest } = this.chatUnread.value;
    this.chatUnread.value = rest;
  }

  /** send a chat message as if typed into the game's chat line */
  async sendChat(channel: string, text: string, to?: string) {
    await this.req<{ ok: boolean }>('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text, to }),
    });
  }

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
  settingsGet(): Promise<Record<string, number | boolean>> {
    return this.req<Record<string, number | boolean>>('/api/settings');
  }

  async settingsSave(patch: Record<string, number | boolean>) {
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
    return res;
  }
}
