# XI Companion

Branded **XI Companion** (window/app title, `xic-overlay.exe`,
`xicompanion-<ver>.zip` releases). The addon is `xic` — directory,
`xic.lua`, `//xic` command. Pre-rename `gearswapui`/`gsui` artifacts still
read for one-time migration: `<xic sets>` profile markers (stripped
on next save, replaced by `<xic sets>`) and `xic.sets.v2`/`v1`
localStorage keys (read as a fallback, written only to `xic.sets.v2`).

## Architecture

Single target: a **browser UI** (`src/app/`, Preact + `@preact-mvc/core`) served
by the Windower addon over localhost, viewed either in a normal browser tab
(`//xic open`), in the **Wails/WebView2 overlay** (distributed build,
`overlay/wails/` → `addon/xic/overlay/xic-overlay.exe`), or in the
**Electron overlay** (dev, `overlay/`, `npm run overlay`). `//xic overlay`
prefers the bundled exe and falls back to the Electron dev launcher.

### Addon — `addon/xic/`

- `xic.lua` — LuaSocket HTTP server (default port 17890, `//xic port`),
  SSE state stream, GearSwap file CRUD, `/api/icon` (DAT extraction via
  `icon_extractor`, cached under `data/icons/`), `POST /api/command`
  (`{"cmd": ...}` → `windower.send_command`), `POST /api/item`
  (packet-injected item ops: `drop` → `windower.ffxi.drop_item`,
  `move` → outgoing 0x029, `unequip` → outgoing 0x050 with Item
  Index 0 — there is no `/unequip` client command), static UI serving with
  `Cache-Control: no-cache` on HTML. `//xic` commands: `open`, `overlay`,
  `fab`, `start`, `stop`, `status`, `port`, `refresh`, `swap` (scanner commands),
  `equip <set>`. **Chat**: an `incoming chunk` handler parses chat packets
  0x017 (mode @0x04 → channel via the res/chat.lua ids, sender char[0xF]
  @0x08, message @0x17) into a 500-msg ring buffer streamed as SSE `chat`
  events. `GET /api/chat?after=<seq>` = history; `POST /api/chat`
  `{channel,text,to?}` sends via `input /<cmd>` — most channels echo back
  as packets (no optimistic append), sent tells get a local `self` echo
  since they don't echo. Assist channels (modes 34/35) are read-only.
- `swapui.lua` — headless GearSwap profile scanner powering `//xic equip`,
  `swap list/add/remove/scan`. No UI.
- `macros.lua` — FFXI macro file r/w under `<ffxi>/USER/<content id>/`:
  `mcr.dat`+`mcrN.dat` palettes (28B hdr + 20 × `6×61B lines + 8B name`),
  `mcr.ttl`/`mcr_2.ttl` book titles (24B hdr + 20×16B, books 1-40), index i →
  book `i/10+1` page `i%10+1`. Header embeds md5 of bytes 24+; writes
  recompute it (pure-Lua md5, `bit` or 5.3 natives) and leave `*.xic-bak`.
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
  Training regimes (FoV/GoV) are captured from outgoing `0x05B` dialogue
  choices at manual/tome NPCs (option `16n+2` = page n, low word; bit 31
  of the u32 = repeat — read the high word, `0x80000000` is signed in
  some luas), `0x029`/`0x02D` messages `558/559/643` drive
  progress/completion/renewal, `0x05C` menu params enrich needs/levels,
  and `0x113` supplies tabs.
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
  between broadcasts. `//xic cooldowns` spawns the window (fab layer,
  like the tracker), `settings.cooldowns` auto-spawns it on login, and
  the fab cluster has a one-tap button for it.
- `journal_names.lua` — GENERATED (do not edit): id→name/description
  tables for all quest areas, mission storylines, and RoE
  objectives/categories. Regenerate with `python
  scripts/extract-journal.py` (reads the local FFXI DATs).
- `regime_names.lua` — GENERATED (do not edit): FoV/GoV zone →
  page → {desc, needs, level range} tables. Regenerate with `python
  scripts/extract-regimes.py` (scrapes bg-wiki).
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
- `ui/` — vite build output; deploy copies `addon/xic/` to
  `windower/addons/xic/` (keep in sync; `data/` there is live state).

### Web UI — `src/app/`

- `sets/sets.store.ts` — profile-scoped `FileSets` model: sets + set-type
  bindings per GearSwap file, `sets.*` auto-import on selection, auto-save of
  the previous profile on switch, managed `<xic sets>` block spliced
  into `get_sets()` (default handlers injected only when the profile has
  none). localStorage `xic.sets.v2` is metadata/unbound-set cache; profile
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
- `chat/chat.view.tsx` — Discord-style chat: channel sidebar (say, shout,
  yell, party, linkshell×2, unity, emote, read-only assist), tell `peer`
  threads as DMs under DIRECT MESSAGES, grouped message list with
  per-sender hues + autoscroll-on-stick, composer posts via
  `POST /api/chat`. `AddonApi` holds `chat`/`activeChat`/`chatUnread`
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
  `xic:expand`/`collapse`/`quit` for the fab↔full state machine, and
  `xic:spawn:<route>`/`xic:close` for detached per-tab windows plus
  `xic:toggle:<route>` (spawn-or-close, the fab's menu bar) and
  `xic:windows` (`__xicWindows` pushes the open-route list →
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
  `xic:tooltip:{bag,slot,id,name,x,y,pinned}` / `xic:tooltip-hide`;
  `tooltipMode` (`?tooltip=1`) renders `tooltip/tooltip.view.tsx` in the
  shared native tooltip window (fixed 320×440, always interactive —
  `pinned=false` still toggles click-through `WS_EX_TRANSPARENT` but the
  page only ever sends pinned payloads; content updates via `ExecJS
  __xicTooltip`). The shell owns the tooltip to the summoning window
  (`GWLP_HWNDPARENT` on each `xic:tooltip:`) — owned windows always
  outrank their owner, so it can't slide under the summoning
  window. `tipAnchor(el)` maps a
  hovered element to screen coords; `showInMain(url)` (`xic:main:`) lets
  detached windows navigate the main one via `__xicNavigate`.
  Esc-hide/close is wired in `main.tsx` (capture phase; skips while a
  `[data-modal]` dialog is open; in tooltip mode Esc closes the tip —
  Electron handles Esc natively via `before-input-event`).
- `core/item-utils.ts` — shared item helpers (catalog merge, flag/tag
  formatting) used by inventory/sets pickers and the tooltip page.

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
  re-issues `SetURL` until the page itself posts `xic:loaded` at the
  end of bootstrap; NavigationCompleted alone can't be trusted since
  connection-refused error pages fire it too).
  `SingleInstanceOptions` surfaces the first window on re-launch;
  `Windows.HiddenOnTaskbar` keeps it out of the taskbar/alt-tab.
  **No periodic z-order machinery** — every polling re-assert scheme
  (per-window `HWND_TOPMOST`, then the coordinated `zSweep`) caused
  visible flicker: each `SetWindowPos` pops a window to band-top, and
  any foreign always-on-top window made the sweep re-run every cycle.
  Stacking is now left to Windows + `xic:raise` (posted on page
  mousedown — lifts the touched window without activating it, needed
  since panels carry `WS_EX_NOACTIVATE` and can't raise themselves).
  `resolveHwnd` only waits for the hwnd to exist (feeds the focus /
  exstyle / tooltip-ownership stores); `WindowMinimise` → `Show()`
  still undoes the frameless auto-minimize quirk. The window has two modes: a 540×56px
  transparent **fab** (`--fab` arg; the addon auto-spawns it on **login**
  — or on `load` while already logged in — `settings.fab`,
  `//xic fab on|off`; the addon taskkills the process on **logout**)
  and the full UI. The fab is a one-row menu bar (`src/app/fab.tsx`):
  the XIC mark expands the main UI (`xic:expand`), then toggle buttons
  (`xic:toggle:<route>`) for the fab-layer panels (`/tracker`,
  `/macrobar`, `/cooldowns`, `/minimap`) and every app page (`/`,
  `/chat`, `/journal`, `/map`, `/macros`, `/profile`, `/settings`) —
  open routes get a gold ring driven by `openWindows`/`__xicWindows`,
  pushed by `windowsReport()` on every spawn/close. Drag from any button
  or the gaps, right-click quits.
  `expand()`/`collapse()` swap min-size/resizable/bounds; both geometries
  persist in `%LOCALAPPDATA%/xic/window.json`. `trackGeometry`
  snapshots live bounds every 300ms and saves once settled — the native
  drag loop gives no end-of-move callback and taskkill beats `quit()`.
  `watchBackend` polls `/api/status` every 2s: it quits the overlay when
  the server disappears (~10s; game exit never reaches the unload
  handler) and hides/shows the window on the response's `hidden` flag —
  set during the zoning blackout (incoming `0x00B`→`0x00A` packets) and
  in event/cutscene status (player.status == 4), matching in-render
  addons. The page picks what
  to render from viewport size (`fabMode` signal in host.ts);
  `body.fab-mode` drops the opaque background so the buttons read
  circular — `BackgroundType: BackgroundTypeTransparent` makes the
  WebView2 backdrop transparent. Chrome on the foreign-origin page works
  through Wails' raw message channel — v3 routes `wails:drag` /
  `wails:resize:<cursor>` from any main-frame origin (unlike v2's
  origin-gated bindings), and `xic:expand`/`xic:collapse`/`xic:quit`
  land in `RawMessageHandler`; `src/app/core/host.ts` posts them via
  `chrome.webview.postMessage`. Esc and × collapse to the fab; only
  `//lua unload` (taskkill) or fab right-click quits the process.
  Drag region: `--wails-draggable` in `src/styles.css`; edge-resize
  cursors/zones are detected in-page (8px border, fab mode excluded)
  since `WM_NCHITTEST` never reaches the webview child window.
  `xic:drag`/`xic:resize:<cursor>` run a **Go-driven** move/size loop
  (poll `GetCursorPos` + `SetWindowPos` until button-up) — never post
  `WM_NCLBUTTONDOWN`: a modal loop entered with the button already up
  parks holding global mouse capture and eats all input. The fab and
  fab-layer panels carry `WS_EX_NOACTIVATE` (like the tooltip) so their
  clicks — including transparent margins — can't steal game focus.
  `xic:spawn:<route>` from the page's pop-out header button creates a
  detached per-tab window via `WindowManager.NewWithOptions` (frameless,
  always-on-top, 280×180 min, same message bridge): one window per route
  key, re-spawn focuses instead of duplicating, geometry persists per
  route under `windows` in window.json, `resolveHwnd` registers its
  hwnd, and `xic:close` on a spawned window destroys it (on the main
  window it collapses to the fab). `watchBackend`'s zoning/cutscene hide
  applies to the fab and "fab-layer" spawned windows (`/tracker`, the
  quest tracker; `/macrobar`, the clickable macro bar; `/cooldowns`,
  the recast list) — other spawned windows and the full UI stay
  visible.
  The journal header's tracker button spawns `/tracker`; its rows post
  `xic:main:<path>` which `showInMain` ExecJS's into the main window's
  `__xicNavigate` (in-page router nav, expanding the fab first) — the
  journal selects via `/journal?g=<kind>&s=<key>&id=<n>` params, and the
  tracker window itself stays up.
  `xic:refocus`: a capture-phase `mouseup` listener in host.ts posts it
  after every primary-button click except on `input`/`textarea`/
  `contenteditable` (typing keeps focus); the shell `SetForegroundWindow`s
  the game — found via its `FFXiClass` window class, falling back to a
  `pol.exe` process-name scan — so clicks never strand game input.
  Drag/resize end refocuses too: the modal WM_NCLBUTTONDOWN loop eats
  the DOM mouseup, so `startMoveLoop` spawns `watchDragEnd`, which polls
  the button state and refocuses on release.
  Logs to `%LOCALAPPDATA%/xic/overlay.log`; WebView2 UDF at
  `%LOCALAPPDATA%/xic/webview2`.
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

## Verify / build

- `npm run build:addon` — typecheck + vite build into `addon/xic/ui/`
- `npm run build:overlay` — go build the Wails shell into
  `addon/xic/overlay/xic-overlay.exe`
- `npm run deploy` — sync `addon/xic/` → `../addons/xic/`
  (live Windower install; preserves its `data/`)
- `npm run release` — build ui + overlay, then `dist/xicompanion-<ver>.zip`:
  the standalone addon (extract into `addons/`)
- `node scripts/smoke-test.mjs` — runs the real `xic.lua` under
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
