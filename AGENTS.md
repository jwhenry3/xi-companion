# XI Companion

Branded **XI Companion** (window/app title, `xicompanion-overlay.exe`,
`xicompanion-<ver>.zip` releases). The addon is `xicompanion` — directory,
`xicompanion.lua`, `//xicompanion` command (alias `//xicomp`). Pre-rename
`xic`/`gearswapui`/`gsui` artifacts still read for one-time migration:
`<xic sets>`/`<gearswapui sets>` profile markers (stripped on next save,
replaced by `<xicompanion sets>`) and `xic.sets.v2`/`gsui.sets.v2`/`v1`
localStorage keys (read as a fallback, written only to `xicompanion.sets.v2`).

## Architecture

Single target: a **browser UI** (`src/app/`, Preact + `@preact-mvc/core`) served
by the Windower addon over localhost, viewed either in a normal browser tab
(`//xicompanion open`), in the **Wails/WebView2 overlay** (distributed build,
`overlay/wails/` → `addon/xicompanion/overlay/xicompanion-overlay.exe`), or in the
**Electron overlay** (dev, `overlay/`, `npm run overlay`). `//xicompanion overlay`
prefers the bundled exe and falls back to the Electron dev launcher.

### Addon — `addon/xicompanion/`

- `plat.lua` — **platform adapter dispatch** (dual-target: the same
  `addon/xicompanion/` tree installs under Windower *and* Ashita — Ashita loads
  `addons/xicompanion/xicompanion.lua` as its entry). Picks `plat_windower` or
  `plat_ashita` on `windower ~= nil`. Every host-runtime call —
  `windower.ffxi.*` reads, `send_command`, `add_to_chat`, `open_url`,
  `file_exists`/`dir_exists`/`create_dir`/`get_dir`,
  `addon_path`/`windower_path`/`ffxi_path`, and `register_event` — is
  exposed as `plat.*` / `plat.on(...)`. The event contract is
  signature-normalized: chunk handlers get `fn(id, data, modified,
  injected, blocked)` (Ashita feeds `e.data_modified`), `addon command`
  gets `fn(cmd, ...)` (Ashita parses the raw `e.command`), and
  `login`/`logout` are synthesized from party-name edges under Ashita.
  Module files call `require('plat')` directly; nothing outside
  `plat_*.lua` should touch `windower.*`/`AshitaCore`.
- `plat_windower.lua` — Windower binding (thin alias over windower.*).
- `plat_ashita.lua` — Ashita v4 binding: memory-manager ffxi reads
  (entity/party/inventory/recast/player), ffi fs helpers, registry-based
  `ffxi_path`, `QueueCommand(-1,...)` commands, packet injection via
  `AddOutgoingPacket`, and `package.preload` shims for `resources`
  (IResourceManager-backed lazy res.items/spells/ability_recasts/
  key_items/zones + static jobs/slots/bags), `config` (data/settings.lua
  serialize), `packets` (byte-layout builders for the 6 outgoing packets
  we inject). **Untested against a live client** — sites marked
  `[UNVERIFIED]`/`[NOT PORTED]` in the file; `get_map_data` is stubbed
  nil (map radar degrades; needs the client's mapinfo transform) and
  GearSwap-facing dirs just won't exist under Ashita (Sets tab shows no
  files — correct, there's no GearSwap). Deploy to Ashita with
  `node scripts/deploy.mjs <ashita>\addons\xicompanion`.
- `xicompanion.lua` — LuaSocket HTTP server (default port 17890, `//xicompanion port`),
  SSE state stream, GearSwap file CRUD, `/api/icon` (DAT extraction via
  `icon_extractor`, cached under `data/icons/`), `POST /api/command`
  (`{"cmd": ...}` → `windower.send_command`), `POST /api/item`
  (packet-injected item ops: `drop` → `windower.ffxi.drop_item`,
  `move` → outgoing 0x029, `unequip` → outgoing 0x050 with Item
  Index 0 — there is no `/unequip` client command), static UI serving with
  `Cache-Control: no-cache` on HTML. `//xicompanion` commands: `open`, `overlay`,
  `fab`, `start`, `stop`, `status`, `port`, `refresh`, `swap` (scanner commands),
  `equip <set>`. **Chat**: an `incoming chunk` handler parses chat packets
  0x017 (mode @0x04 → channel via the res/chat.lua ids — say/shout/tell/
  party/linkshell/emote/yell/linkshell2/unity/assistj/assiste + system for
  modes 6/7/12 — with unmapped modes falling back to `system` since 0x017
  is always chat-log text; sender char[0xF] @0x08, message @0x17) into
  per-thread buffers streamed as SSE `chat`
  events. A second capture is **`incoming text`** — the client's rendered
  log-line stream, which covers everything the log shows including
  combat text, system lines, and every addon/plugin `add_to_chat`:
  rendered packet modes (res/chat.lua incoming∪outgoing columns) are
  skipped as already-captured, `blocked` lines and our own
  `[xicompanion]` prefix are skipped, battle color ids (the Font-Colors
  combat set + every numeric `res.action_messages` `color`) → `battle`,
  mode 121 → `system`, everything else → `echo`. Lines containing
  'learn' get `kind='learn'` for the ★ flag. `GET /api/chat?after=<seq>`
  = history; `POST /api/chat`
  `{channel,text,to?}` sends via `input /<cmd>` (`/say`, `/shout`,
  `/yell`, `/emote`, `/party`, `/linkshell`, `/linkshell2`, `/unity`,
  `/tell`) — most channels echo back
  as packets (no optimistic append), sent tells get a local `self` echo
  since they don't echo. System/battle/echo/assist channels are
  read-only. `GET|PUT /api/chat/channels` persists player-defined
  filter channels (`settings.chat_custom_channels` — `{name,channels[]}`
  merged-view metadata; membership resolved client-side). `json_decode`
  is a byte-walk JSON parser for structured route bodies.
- `swapui.lua` — headless GearSwap profile scanner powering `//xicompanion equip`,
  `swap list/add/remove/scan`. No UI.
- `macros.lua` — FFXI macro file r/w under `<ffxi>/USER/<content id>/`:
  `mcr.dat`+`mcrN.dat` palettes (28B hdr + 20 × `6×61B lines + 8B name`),
  `mcr.ttl`/`mcr_2.ttl` book titles (24B hdr + 20×16B, books 1-40), index i →
  book `i/10+1` page `i%10+1`. Header embeds md5 of bytes 24+; writes
  recompute it (pure-Lua md5, `bit` or 5.3 natives) and leave `*.xicompanion-bak`.
  Auto-translate `FD…FD` phrases ↔ `[AT:xxxxxxxx]`, other bytes ↔ `\xNN`.
  `GET /api/macros`, `PUT /api/macros/palette[?apply=1]`,
  `PUT /api/macros/title`, `POST /api/macros/run` (replays one cell's
  lines through `input`, `/wait` lines paced via `coroutine.schedule` —
  powers the detached macro bar). **apply confirmed live**: `input /macro book N`
  forces the client to re-read that book's files from disk — the endpoint
  switches away (≥1.5s, PR #1892's wipe threshold), writes while the book
  is unloaded, switches back, then `/macro set` the page.
- `journal.lua` — quest/mission/RoE tracker: parses incoming `0x056`
  (quest + mission log subtypes), `0x111` (active RoE objectives) and
  `0x112` (RoE completion bitfield pages) into per-character state under
  `data/journal/<char>.lua`, serves `GET /api/journal` +
  `GET /api/journal/names`, and pushes `journal` SSE events (debounced
  from `pump()` via `journal.flush()`). COP/SOA/ROV/TVR + the add-on
  scenarios have no completion bitfield — `inferred_done` flags let the
  UI treat every record before the current pointer as finished.
- `recasts.lua` — ability/spell cooldowns for the detached `/cooldowns`
  panel: polls `windower.ffxi.get_ability_recasts()`/
  `get_spell_recasts()` each `pump()`, rounds remaining to 0.1s so the
  `recasts` SSE event only fires on real change (snapshot also at
  `GET /api/recasts`; the empty `list` goes through `json_array` — Lua
  `{}` would otherwise encode as an object and crash `.map`). Entries
  are `{k,n,t='a'|'s',r,m}` — `m` is the observed max (clients never
  send full recasts for abilities; spells floor at
  `res.spells[id].recast`), reset on job change and logout. The view
  counts `r` down locally from the SSE `at` stamp so bars fill smoothly
  between broadcasts. `//xicompanion cooldowns` spawns the window (fab layer,
  like the tracker), `settings.cooldowns` auto-spawns it on login, and
  the fab cluster has a one-tap button for it.
- `journal_names.lua` — GENERATED (do not edit): id→name/description
  tables for all quest areas, mission storylines, and RoE
  objectives/categories. Regenerate with `python
  scripts/extract-journal.py` (reads the local FFXI DATs).
- `nm_names.lua` — GENERATED (do not edit): lowercased NM name set for
  map flagging — the client never reports notorious status (no entity
  flag, nothing in widescan), so `map.lua` name-matches entities (f&16)
  and widescan entries (`nm`) against it. Regenerate with `python
  scripts/extract-nms.py` (bg-wiki Category:Notorious_Monster API).
- `abilities.lua` + `ja_levels.lua` — the /abilities skill+spell book:
  learned sets from `get_abilities()`/`get_spells()`, obtainable spells
  from `res.spells[].levels` (subjob reqs ×2 to main level), JA job/level
  from `ja_levels.lua` — GENERATED (do not edit) by
  `scripts/extract-ja-levels.py` (bg-wiki Category:Job_Ability infoboxes:
  job/level/type/cmd, keyed by lowercased name). `GET /api/abilities`
  recomputes per call; the view refetches on job change. The view
  follows the journal layout (SPELLS/ABILITIES sidebar sections,
  header search + learned-only + target chips, right-hand detail
  pane): click a row to open its detail — canonical macro line, copy
  button, use-with-<target> action — or hit ▶ on a learned row to
  fire `input <prefix> "name" <t|st|stpc|stnpc|me>` directly. Row
  icons (`ic`, served by `/api/statusicon` from `ROM/119/57.DAT`)
  mirror the native menus: JAs keep `res.job_abilities[].icon_id`,
  spells use the element-colored `el*` tiles (`589+element`, avatar
  faces `s_*` for summons by name), WSs the element-colored `k*`
  swords (`300+element`, `kht` when elementless) — `icon_id` in res
  is the *macro palette* icon, not the menu one (and ≥640 ids —
  storm II ~648 — have no `sts_icon` store anyway). Trust icon_ids
  cluster by role → `TRUST_ITEM_ICON` maps them to real item icons
  via `/api/icon` (`iic` field: shield/sword/bow/wand/club/flute),
  specials keep the sts sphere.
- `mapimg.lua` + `mapdats.lua` — zone map image resolution.
  `mapdats.lua` is GENERATED (do not edit): zone → map# → file-id table
  built from Windower ResourceExtractor's MapDats.json (vendored at
  `scripts/mapdats.json`). `mapimg.lua` resolves file ids via
  `FTABLE.DAT` (u16 @ id*2 → `ROM/<f/128>/<f%128>.DAT` under
  `windower.ffxi_path`) and `GET /api/map/img` serves the raw DAT bytes
  as `application/x-ffxi-map`; the browser decodes the DXT3/8-bit-bitmap
  payload (`src/app/map/map-image.ts`, header @0x41, DXT texels @0x75)
  so image decode never touches the game frame. User PNGs in
  `data/maps/<zone>_<map>.png` still take precedence.
- `icon_extractor.lua` — decodes FFXI DAT item icons to BMP.
- `ui/` — vite build output; deploy copies `addon/xicompanion/` to
  `windower/addons/xicompanion/` (keep in sync; `data/` there is live state).

### Web UI — `src/app/`

- `sets/sets.store.ts` — profile-scoped `FileSets` model: sets + set-type
  bindings per GearSwap file, `sets.*` auto-import on selection, auto-save of
  the previous profile on switch, managed `<xicompanion sets>` block spliced
  into `get_sets()` (default handlers injected only when the profile has
  none). localStorage `xicompanion.sets.v2` is metadata/unbound-set cache; profile
  Lua is authoritative.
- `sets/sets.view.tsx` — file picker, save/dirty/reload header, set dropdown
  + new-set dialog, icon grid with `×` clear + `!` missing markers, bindings
  panel, slot/bag/text-filtered item picker. Item details+actions float in a shared native tooltip window (click=pin).
- `inventory/inventory.view.tsx`, `files/files.view.tsx` — bag/slot filters,
  icons; file browser/editor. Item tooltips share the same native window.
- `macros/macros.view.tsx` — macro editor: char + vertical book sidebar,
  page picker, Ctrl/Alt 2×10 grid, label + 6 line editor with byte
  counters, copy/paste palette, book rename, "save & apply" while
  logged in.
- `macrobar/macrobar.view.tsx` — `/macrobar` detached route (no NAV):
  clickable Ctrl/Alt palette cells that `POST /api/macros/run`, persisted
  char/book/page selection, refresh on focus + 15s poll.
- `journal/journal.view.tsx` — journal tab: mission storylines, quest
  areas, and RoE objectives in a group sidebar; entries show
  done/current/not-started, live RoE progress bars, and a detail pane
  with the DAT descriptions and mission stage names. Untouched entries
  are hidden unless "show all" or a search is active.
- `chat/chat.view.tsx` — Discord-style chat: pinned `≡ all` row (every
  channel + DM, view-only unread-wise), sidebar grouped ACTIVE
  (channels with messages, or the selected one) / OTHER
  (empty channels, collapsed behind an expandable header) / CUSTOM
  (player-defined filter channels, `custom:<name>` thread keys — create/
  edit via the `+` dialog, persisted addon-side through
  `/api/chat/channels`) / tell `peer` threads as DIRECT MESSAGES.
  Channels: say, shout, yell, emote, party, linkshell×2, unity, battle
  (combat text incl. rendered 0x028/0x029 lines), system, echo
  (other addons/plugins/`add_to_chat` output), assist jp/en —
  system/battle/echo/assist are read-only (no composer). In
  `all`/`custom:` views the composer gets a send-to `<select>` of the
  sendable channels. `kind='learn'` messages render highlighted and
  badge their channel row with ★ via `chatAlerts`; unread+alerts count
  toward every thread a message feeds (`chatThreadsFor` — own thread +
  matching custom channels). Header search filters the pane — the
  channel/all toggle switches between the current thread and every
  channel+DM, with `<mark>` hit highlighting and per-row channel chips
  that jump to the source thread. Grouped message list with
  per-sender hues + autoscroll-on-stick, composer posts via
  `POST /api/chat`. `AddonApi` holds `chat`/`activeChat`/`chatUnread`/
  `chatAlerts`/`chatCustom`
  signals (unread badges in the sidebar and on the Chat nav link).
  Incoming 0x017 packets are parsed by a pcall'd `incoming chunk`
  handler; packet text goes through a **byte-walker** (`sanitize_chat`)
  — never gsub — because `resources` loads `strings.lua`, which wraps
  `string.gsub`/`find`/`match`/`gmatch` in encoding-aware versions and
  untrusted binary content is how you get `strings.lua:721` errors.
  Auto-translate phrases decode via `res.auto_translates` — wire format
  `0xFD <type> <lang> <id lo> <id hi> 0xFD` (6 bytes), rendered
  `{Hello!}`; unknown ids fall back to `{AT:xxxxxxxx}`, malformed runs
  to `{AT}`. Outbound, the composer wraps chosen phrases in invisible
  markers (U+2060 WORD JOINER open, U+200B ZWSP close — atomic in the
  input, so Backspace removes the whole phrase); `POST /api/chat` runs
  `decode_outgoing_chat` which maps names back to ids (reverse of
  `res.auto_translates`) and emits real `FD 02 02 lo hi FD` wire bytes
  for `input /cmd`. `GET /api/chat/phrases` feeds the Tab-autocomplete
  popup. History lives in
  per-thread buckets (`channel` key, or `tell:<peer>` for DMs) capped at
  `settings.chat_history` (default 200) each — a busy channel can't
  evict a quiet one's tail — with `settings.chat_tell_threads` (64)
  bounding distinct tell peers. `GET /api/chat?after=` merges buckets
  seq-sorted. Each message carries a `boot` marker (random per addon
  load and regenerated by `reset_state` on login/logout); the client
  resets `chatSeq` and its log when `boot` changes — without it a
  reload restarts seqs at 1 and the `seq <= chatSeq` dedupe drops
  every message forever.
- `core/addon-api.service.ts` — same-origin API client (state SSE, files,
  `sendCommand`, `iconUrl`, `reloadGearswap`); `VITE_GSUI_API` for dev.
  All traffic rides `core/bridge.worker.ts` when `SharedWorker` exists —
  a single shared worker owns the ONE `/api/events` SSE stream + request
  proxy for every window (Chromium caps ~6 conns/origin; each held SSE
  stream starved fetches once several detached panels were open). New
  ports get the cached snapshot events (state/journal/recasts/map)
  replayed; `chat` stays pull-based per window (per-window seq/unread).
  GETs dedupe in-flight across windows and `/api/itemmeta`,
  `/api/journal/names`, `/api/chat/phrases` cache worker-side (the
  ~1MB names pull happens once, not per window). `dispatchSse`/`onConn`
  unify the worker messages and the direct-EventSource fallback.
  Data fetches go through TanStack Query (`core/query.ts`): `fetchQuery`
  for imperative reads (files, itemmeta, journal-names, chat-phrases,
  macros — static resources use `staleTime: Infinity`), writes call
  `invalidateQueries` so post-save refetches don't serve cache. Chat
  catch-up and the SSE-fallback poll stay raw fetches (cursor/fallback,
  not cacheable content). `bindQuery` is the class-View adapter — views
  are `@preact-mvc` class components so hooks can't run; it drives a
  `QueryObserver` and projects `data`/`error`/`pending` onto signals,
  re-keying reactively when signals in the options fn change
  (tooltip.view's per-item description). Call `dispose()` in `onDestroy`.
- `core/host.ts` — shell shim over `chrome.webview.postMessage`: `wails:drag`,
  `wails:resize:<cursor>` (edge zones detected in-page, 8px border),
  `xicompanion:expand`/`collapse`/`quit` for the fab↔full state machine, and
  `xicompanion:spawn:<route>`/`xicompanion:close` for detached per-tab windows plus
  `xicompanion:toggle:<route>` (spawn-or-close, the fab's menu bar) and
  `xicompanion:windows` (`__xicWindows` pushes the open-route list →
  `openWindows` signal). `fabMode`
  signal (viewport height < 200px, width unconstrained — the bar is
  ~540px wide; detached/tooltip excluded) picks button-vs-app render;
  `detachedMode`
  (`?window` param) swaps full nav for a slim title bar — the shell
  navigates spawned windows to `/<route>?window=1`, and `/?window=<path>`
  from older exes is rewritten up front. The page also posts
  `wails:runtime:ready` once on load — Wails only injects its runtime into
  assetserver pages, so our foreign-origin `SetURL` page never sends it,
  which leaves every Go-side `ExecJS` silently queued in `pendingJS`
  (tooltip updates, `__xicNavigate`, `__xicTooltipUnpinned` all dead).
  Item tooltip plumbing:
  `pinTooltip`/`setTooltip`/`closeTooltip` emit
  `xicompanion:tooltip:{bag,slot,id,name,x,y,pinned}` / `xicompanion:tooltip-hide`;
  `tooltipMode` (`?tooltip=1`) renders `tooltip/tooltip.view.tsx` in the
  shared native tooltip window (fixed 320×440, always interactive —
  `pinned=false` still toggles click-through `WS_EX_TRANSPARENT` but the
  page only ever sends pinned payloads; content updates via `ExecJS
  __xicTooltip`). The shell owns the tooltip to the summoning window
  (`GWLP_HWNDPARENT` on each `xicompanion:tooltip:`) — owned windows always
  outrank their owner, so it can't slide under the summoning
  window. `tipAnchor(el)` maps a
  hovered element to screen coords; `showInMain(url)` (`xicompanion:main:`) lets
  detached windows navigate the main one via `__xicNavigate`.
  Esc-hide/close is wired in `main.tsx` (capture phase; skips while a
  `[data-modal]` dialog is open; in tooltip mode Esc closes the tip —
  Electron handles Esc natively via `before-input-event`).
- `core/item-utils.ts` — shared item helpers (catalog merge, flag/tag
  formatting) used by inventory/sets pickers and the tooltip page.
- `src/styles.css` — theme palettes. `host.ts` `applyTheme` toggles
  `html.classic|slate|charcoal|bare` (per-window picks via
  `xicompanion.wintheme.<route>` shadow the global `xicompanion.theme`).
  Each `html.<theme>` block remaps the whole `--color-slate-*` ramp (and
  `--color-indigo-*` under slate/charcoal) plus the shadcn tokens
  (`--card`/`--popover`/`--secondary`/`--muted`/`--accent`/`--border`/
  `--input`/`--primary`/`--ring`) — views paint content with fixed
  `bg-slate-*`/`border-slate-*`/`text-slate-*` classes that all resolve
  through those vars, so cards/buttons/inputs retint without component
  edits. Panel chrome (`.ffxi-panel`/`.ffxi-panel-title`/`.ffxi-fab`)
  has separate per-theme rules further down; when adding content
  colors, use slate-ramp or token classes, never hex/other ramps.

### Overlay — `overlay/`

- `wails/` — the shippable shell (Wails **v3**, ~11MB exe, `go build -tags
  production`): probes `127.0.0.1:17890-17899` for `/api/status`
  (`$GSUI_PORT` overrides), then `SetURL` navigates the frameless +
  AlwaysOnTop window to the addon page once `app.Run` has created the
  window impl (`SetURL` is a no-op while `NativeWindow()` is nil — and
  even with an HWND it's dropped while the WebView2 core is still
  coming up, which stranded windows on the dark splash; every window
  navigates via `navigateWhenReady`, which waits for the splash's own
  `WebViewNavigationCompleted` — timed fallback included — then
  re-issues `SetURL` until the page itself posts `xicompanion:loaded` at the
  end of bootstrap; NavigationCompleted alone can't be trusted since
  connection-refused error pages fire it too).
  `SingleInstanceOptions` surfaces the first window on re-launch;
  `Windows.HiddenOnTaskbar` keeps it out of the taskbar/alt-tab.
  **No periodic z-order machinery** — every polling re-assert scheme
  (per-window `HWND_TOPMOST`, then the coordinated `zSweep`) caused
  visible flicker: each `SetWindowPos` pops a window to band-top, and
  any foreign always-on-top window made the sweep re-run every cycle.
  Stacking is now left to Windows + `xicompanion:raise` (posted on page
  mousedown — lifts the touched window without activating it, needed
  since panels carry `WS_EX_NOACTIVATE` and can't raise themselves).
  `resolveHwnd` only waits for the hwnd to exist (feeds the focus /
  exstyle / tooltip-ownership stores); `WindowMinimise` → `Show()`
  still undoes the frameless auto-minimize quirk. The window has two modes: a 540×56px
  transparent **fab** (`--fab` arg; the addon auto-spawns it on **login**
  — or on `load` while already logged in — `settings.fab`,
  `//xicompanion fab on|off`; the addon taskkills the process on **logout**)
  and the full UI. The fab is a one-row menu bar (`src/app/fab.tsx`):
  the XIC mark expands the main UI (`xicompanion:expand`), then toggle buttons
  (`xicompanion:toggle:<route>`) for the fab-layer panels (`/tracker`,
  `/macrobar`, `/cooldowns`, `/minimap`) and every app page (`/`,
  `/chat`, `/journal`, `/map`, `/macros`, `/profile`, `/settings`) —
  open routes get a gold ring driven by `openWindows`/`__xicWindows`,
  pushed by `windowsReport()` on every spawn/close. Drag from any button
  or the gaps, right-click quits.
  `expand()`/`collapse()` swap min-size/resizable/bounds; both geometries
  persist in `%LOCALAPPDATA%/xicompanion/window.json`. `trackGeometry`
  snapshots live bounds every 300ms and saves once settled — the native
  drag loop gives no end-of-move callback and taskkill beats `quit()`.
  `watchBackend` polls `/api/status` every 2s: it quits the overlay when
  the server disappears (~10s; game exit never reaches the unload
  handler) and hides/shows the window on the response's `hidden` flag —
  set during the zoning blackout (incoming `0x00B`→`0x00A` packets) and
  in event/cutscene status (player.status == 4), matching in-render
  addons. `watchForeground` polls `GetForegroundWindow` every ~350ms:
  while FFXI runs and a **foreign** window owns foreground (not ours,
  not the game's process — dialogs/IME surfaces count), the whole
  overlay family hides after ~0.7s of persistence (alt-tab flicker
  guard) and restores on the first good poll — restore uses
  `SW_SHOWNA` so it can't steal focus back, and the zoning blackout
  still wins over a restore. With no game running nothing hides.
  The page picks what
  to render from viewport size (`fabMode` signal in host.ts);
  `body.fab-mode` drops the opaque background so the buttons read
  circular — `BackgroundType: BackgroundTypeTransparent` makes the
  WebView2 backdrop transparent. Chrome on the foreign-origin page works
  through Wails' raw message channel — v3 routes `wails:drag` /
  `wails:resize:<cursor>` from any main-frame origin (unlike v2's
  origin-gated bindings), and `xicompanion:expand`/`xicompanion:collapse`/`xicompanion:quit`
  land in `RawMessageHandler`; `src/app/core/host.ts` posts them via
  `chrome.webview.postMessage`. Esc and × collapse to the fab; only
  `//lua unload` (taskkill) or fab right-click quits the process.
  Drag region: `--wails-draggable` in `src/styles.css`; edge-resize
  cursors/zones are detected in-page (8px border, fab mode excluded)
  since `WM_NCHITTEST` never reaches the webview child window.
  `xicompanion:drag`/`xicompanion:resize:<cursor>` run a **Go-driven** move/size loop
  (poll `GetCursorPos` + `SetWindowPos` until button-up) — never post
  `WM_NCLBUTTONDOWN`: a modal loop entered with the button already up
  parks holding global mouse capture and eats all input. The fab and
  fab-layer panels carry `WS_EX_NOACTIVATE` (like the tooltip) so their
  clicks — including transparent margins — can't steal game focus.
  `xicompanion:spawn:<route>` from the page's pop-out header button creates a
  detached per-tab window via `WindowManager.NewWithOptions` (frameless,
  always-on-top, 280×180 min, same message bridge): one window per route
  key, re-spawn focuses instead of duplicating, geometry persists per
  route under `windows` in window.json, `resolveHwnd` registers its
  hwnd, and `xicompanion:close` on a spawned window destroys it (on the main
  window it collapses to the fab). `watchBackend`'s zoning/cutscene hide
  applies to the fab and "fab-layer" spawned windows (`/tracker`, the
  quest tracker; `/macrobar`, the clickable macro bar; `/cooldowns`,
  the recast list) — other spawned windows and the full UI stay
  visible.
  The journal header's tracker button spawns `/tracker`; its rows post
  `xicompanion:main:<path>` which `showInMain` ExecJS's into the main window's
  `__xicNavigate` (in-page router nav, expanding the fab first) — the
  journal selects via `/journal?g=<kind>&s=<key>&id=<n>` params, and the
  tracker window itself stays up.
  `xicompanion:refocus`: a capture-phase `mouseup` listener in host.ts posts it
  after every primary-button click except on `input`/`textarea`/
  `contenteditable` (typing keeps focus); the shell `SetForegroundWindow`s
  the game — found via its `FFXiClass` window class, falling back to a
  `pol.exe` process-name scan — so clicks never strand game input.
  Drag/resize end refocuses too: the modal WM_NCLBUTTONDOWN loop eats
  the DOM mouseup, so `startMoveLoop` spawns `watchDragEnd`, which polls
  the button state and refocuses on release.
  Logs to `%LOCALAPPDATA%/xicompanion/overlay.log`; WebView2 UDF at
  `%LOCALAPPDATA%/xicompanion/webview2`.
- `launch.mjs` — dev path: spawns Electron detached, strips
  `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE` (set in this
  machine's env), pipes child stdio to `overlay.log`, exits immediately.
- `main.cjs` — borderless always-on-top (`screen-saver` level) window loading
  `http://127.0.0.1:<GSUI_PORT|17890>/`; single-instance lock (re-invoke =
  focus + `reloadIgnoringCache`, which doubles as the refresh path);
  `disableHardwareAcceleration` (frameless resize crashed some GPU stacks);
  `minimize` → `restore` (frameless+skipTaskbar auto-minimize quirk);
  periodic `moveTop` re-pin; `Esc` hides. Header is the drag region via
  injected CSS.


### xicdbg — diagnostic "MCP" addon (installed-side only)

`windower/addons/xicdbg/xicdbg.lua` — a tiny standalone Windower addon that
exists so agents can **investigate and recover the game/addon state when
xicompanion itself is down or misbehaving** (the addon's `/api/command`
bridge dies with it). Loaded before `xicompanion` in
`windower/scripts/init.txt` (`lua load xicdbg`); deploys by copying the
folder into `windower/addons/` — it is NOT part of the repo's
`addon/xicompanion/` tree and deploy.mjs does not sync it.

Not a real MCP server — a minimal LuaSocket HTTP API on `127.0.0.1:17891`
reachable with plain curl. `GET /tools` returns a machine-readable
endpoint catalog — fetch it first rather than hardcoding paths:

| Route | Purpose |
|---|---|
| `GET /tools` | endpoint catalog (discovery) |
| `GET /state` | player/zone/logged_in |
| `GET /keys` | recent keyboard events `{t,dik,down,blocked}` — the "who ate my keys" probe |
| `GET /chat` | recent incoming-text lines `{ts,mode,text}` |
| `POST /cmd` | `{"cmd":"..."}` → `send_command` (windower cmd; `input /x` for client cmds) |
| `POST /bind` | `{"key":"...","cmd":"..."}` → `//bind` |
| `POST /unbind` | `{"key":"..."}` → `//unbind` |
| `POST /unbindall` | `//unbind all` — recovers locked keys from persistent binds |

Incident notes: Windower `//bind` keybinds are global state that swallows
keys and **persists after addon unload** — a bound Escape/Enter shows up
as "keys locked" even with xicompanion unloaded. A stuck native chat
input line has the same symptom (only right-click dismisses it; Esc
should but the line can get wedged). Use `GET /keys` to see events the
client saw vs. ones a bind/hook ate (blocked flag).

## Verify / build

- `npm run build:addon` — typecheck + vite build into `addon/xicompanion/ui/`
- `npm run build:overlay` — go build the Wails shell into
  `addon/xicompanion/overlay/xicompanion-overlay.exe`
- `npm run deploy` — sync `addon/xicompanion/` → `../addons/xicompanion/`
  (live Windower install; preserves its `data/`)
- `npm run release` — build ui + overlay, then `dist/xicompanion-<ver>.zip`:
  the standalone addon (extract into `addons/`)
- `node scripts/smoke-test.mjs` — runs the real `xicompanion.lua` under
  fengari with stubs; covers HTTP routes, SSE, file CRUD, swap scanner,
  commands
- fengari cannot parse `'x':method()` literal calls in Windower libs — those
  can't be exercised locally

## Removed paths (historical)

- `src/ingame/` prim-based in-game UI, `igui_bridge.lua`, compiled `igui/` —
  superseded by the overlay (OS-level window = free input capture, no
  blockinput/hitList hacks).
- `tools/inputguard/` WH_MOUSE_LL companion — hook installed but never fired
  callbacks on this machine.
- `fenestra/` + `src/fenestra/` — dev-Windower port scaffold; Fenestra has no
  releases, failing CI, missing console/stack-traces, and a known unfixed
  action-injection bug.
