# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Training regimes** (Fields of Valor / Grounds of Valor) in the journal
  and tracker: outgoing 0x05B dialogue choices at a Field Manual/Grounds
  Tome capture the selected page, 0x029/0x02D messages drive live
  killed/needed progress and completion, and 0x113 supplies the tabs
  balance. A new `regime_names.lua` (generated from bg-wiki by
  `scripts/extract-regimes.py`) resolves each zone+page to its real
  objectives — mob names, counts, and recommended level — rendered in the
  journal's new TRAINING section and as a tracker row (hideable via the
  `valor:valor` group key like the other categories).

### Changed

- Rebranded as **XI Companion**: window/app titles, splash, fab tooltip,
  release names, and artifacts (`gsui-overlay.exe` → `xic-overlay.exe`,
  `gearswapui-<ver>.zip` → `xicompanion-<ver>.zip`). The addon itself is
  renamed `gearswapui` → **`xic`** (`addons/xic/xic.lua`) with `//xic` as
  the only command — page messages (`xic:`), localStorage
  (`xic.sets.v2`), overlay data dir (`%LOCALAPPDATA%/xic`), macro backups
  (`.xic-bak`), and the `com.xic.overlay` instance lock all renamed too.
  Migration shims kept: existing `<gearswapui sets>` blocks in profiles
  are replaced in place on the next save, and `gsui.sets.v2`/`v1`
  localStorage is read as a fallback so saved sets aren't lost. Note the
  overlay data dir move orphans prior window geometry and the WebView2
  profile.
- The **Profile** tab is now labeled **GearSwap** — "Profile" meant
  nothing without the GearSwap context.

### Added

- Detached per-tab windows: a pop-out button in the header opens the
  current tab in its own small always-on-top window (`xic:spawn:<route>`
  → `WindowManager.NewWithOptions` at `/<route>?window=1`, which renders
  the routed view under a slim draggable title bar). Each keeps its own
  saved bounds in `window.json`, can be shrunk to 280×180, drags/resizes
  like the main window, and closing one (×/Esc) destroys just that
  window. Re-popping an already detached tab focuses its window instead
  of duplicating it.
- The chat "+ new direct message" action is now a proper modal dialog
  (Enter opens, Esc/click-outside cancels) instead of an inline sidebar
  field.
- Detached macro bar: `/macrobar` (via the "macro bar" button on the
  Macros page or `//xic macrobar`) is an always-up fab-layer window —
  char/book/page pickers plus the 20 Ctrl/Alt cells as clickable
  buttons. A click calls `POST /api/macros/run`, which replays the
  macro's lines through the client's input line (`input`, with `/wait N`
  lines paced through the scheduler and `[AT:xxxxxxxx]` re-encoded to
  raw FD bytes) — the same thing pressing the in-game keybind does.
  Char/book/page persist across launches, and while logged in the
  pickers also switch the client's own palette (`/macro book` only when
  the book changes — rapid book re-loads risk the PR #1892 wipe —
  plus `/macro set` for the page).
- Macros page: book picker is now a vertical sidebar list (char select +
  all 40 books with title subtitles and ● content markers, matching the
  journal's group column) instead of a header dropdown.
- Overlay clicks return keyboard focus to the game: a capture-phase
  `mouseup` listener posts `xic:refocus` and the shell calls
  `SetForegroundWindow` on the FFXI window (found via its `FFXiClass`
  window class, falling back to a `pol.exe` process scan). Text-entry
  elements (input/textarea/contenteditable) keep focus so typing still
  works, and drag/resize end refocuses too — the modal move/size loop
  swallows the DOM mouseup, so the shell watches for button release in
  `startMoveLoop` and refocuses there. Applies to the main UI, detached
  windows, tooltip and fab. The same return happens when an overlay
  window stops owning input: collapse-to-fab, a detached window closing,
  the blackout hide, and quit all call `refocusGame` — which only acts
  when an overlay window actually holds foreground — so Esc/Enter go
  back to the client instead of an invisible webview.
- Fixed `[AT:xxxxxxxx]` decode skipping 2 chars short of the 13-char
  marker in `text_to_bytes` — writing a palette containing an
  auto-translate phrase corrupted it (`FD…FD` + trailing `4]`). Same
  off-by-two fixed in the editor's byte counter.
- Fixed un-hiding a tracker entry that was suppressed by its whole
  category: the row's eye only looked at the `kind:key:id` key, so an
  entry hidden by the `kind:key` group flag could never be restored —
  clicking it wrote a key that had no effect. The toggle now reflects
  the effective state (either key) and re-tracking clears both;
  `/api/journal/track` failures surface in the pane instead of
  silently dropping.
- Fixed the tooltip window bouncing under/over the main UI: every
  always-on-top window re-asserts `HWND_TOPMOST` on a timer, and
  whichever pinner ran last won the top of the band. The tooltip is
  now an **owned window** of whatever window summoned it
  (`GWLP_HWNDPARENT` — owned windows always outrank their owner in
  z-order), so re-pinning can never bury it.
- `deploy` now rename-swaps a locked `xic-overlay.exe`: Windows can't
  overwrite a running binary but can rename it, so the new build lands
  as `xic-overlay.exe` immediately and the old one is deleted once the
  process exits.
- Item tooltip actions: multi-slot equipment (weapons → `equip main` /
  `equip sub`, rings → left/right) now gets one button per valid slot —
  `meta.slots` is an unordered set, so picking `slots[0]` could target
  the wrong hand. `unequip` now works: there's no `/unequip` client
  command, so `POST /api/item` gained an `unequip` action that injects
  an equip packet (0x050) with Item Index 0 — the same encoding
  GearSwap emits for empty slots.
- API data fetches now run through TanStack Query
  (`@tanstack/query-core`): shared cache + in-flight dedupe for
  itemmeta, journal names, chat phrases, macro state, and gearswap
  files; writes invalidate their keys so refetches never serve stale
  data. Views use a `bindQuery` signal adapter over `QueryObserver`
  (the class components can't run hooks).
- Item tooltips are a real native window instead of an inline detail
  panel: clicking an item pins a small frameless always-on-top window
  beside it with its details and actions (equip/unequip/use/move/drop,
  augment and extdata details, drop confirm). One shared window is
  reused and updated via `ExecJS` (`xic:tooltip:{json}`, `-hide`) so
  sweeping items doesn't reload or reflow anything; the Inventory and
  GearSwap views no longer reserve space for a detail panel. A tracker
  row click also got `xic:main:<url>` → `showInMain` so detached
  windows can navigate the main one.

### Changed (cont.)

- The fab now lives only while a character is logged in: the addon spawns
  it on `login` (or on `load` while already in-game) and taskkills the
  overlay on `logout`. The overlay also quits itself when the addon
  server stops answering (`watchBackend`), covering game exit.
- The fab auto-hides during the zoning blackout (incoming `0x00B` →
  `0x00A` packets) and cutscenes (player status "event"), matching how
  in-render addons stop drawing — the addon reports `hidden` on
  `/api/status` and the shell calls `win.Hide()`/`win.Show()` on the
  main window only while it's in fab mode; the full UI and detached
  windows stay up.

### Fixed

- The fab (and full window) now actually restores its saved position —
  Wails' `InitialPosition` defaults to `WindowCentered`, which centers
  the window after creation and silently ignores the saved X/Y.
- Dragging the fab no longer loses its position — the overlay snapshots
  live window bounds continuously (`trackGeometry`) instead of only on
  expand/collapse/quit, which taskkill never reaches.

## [0.1.0] - 2026-10-23

Initial release — a Windower 4 addon (`gearswapui`) that runs a local HTTP
server and serves a Web UI (Preact) in a frameless, always-on-top overlay,
replacing the web interface for inventory, GearSwap set, and macro
management.

### Added

**Overlay & addon shell**

- Wails v3 / WebView2 overlay: frameless always-on-top window, single
  instance, collapsible 56px floating button ("fab") mode, native
  drag/resize via Wails message channel, per-mode window geometry
  persistence. Electron dev path via `overlay/launch.mjs`.
- LuaSocket HTTP server on `127.0.0.1:17890` (auto-probes the next 9 ports),
  SSE state stream, static UI serving, `POST /api/command` passthrough to
  `windower.send_command`.
- `//gsui` commands: `open`, `overlay`, `fab`, `start`, `stop`, `status`,
  `port`, `refresh`, `equip <set>`, `swap`.

**Inventory**

- Browse all storage bags (inventory, safe, storage, locker, satchel, sack,
  case, wardrobe 1-8); unavailable bags shown disabled, not hidden.
- Search, equipment-only, bag, and equip-slot filters; item detail panel
  with augments/extdata, jobs, flags, and duplicate locations.
- Item icons decoded from FFXI DAT files (`icon_extractor`), cached as BMP
  and served via `/api/icon`.
- In-game actions: equip, unequip (per equip slot), use, drop, and move
  between bags (packet injection).

**GearSwap sets**

- Profile file browser over `addons/GearSwap/data`, Lua read/write, and
  `gs reload`.
- Build `sets.*` tables from scanned inventory via a slot grid + filtered
  item picker; items resolve loosely by canonical id, name, and augments —
  bag position is a hint, not an identity.
- Set-type bindings (idle/engaged/precast/… with nested paths like
  `precast['Utsusemi: Ichi']`) persisted in a managed
  `<gearswapui sets>` block spliced inside the profile's `get_sets()`,
  with guarded default handlers injected only for bare profiles.
- Quick-equip scanner (`//gsui swap`) listing equippable `sets.*` paths.

**Macro editor**

- Reads and writes FFXI macro storage under `USER/<content id>/`
  (`mcr*.dat` palettes, `mcr*.ttl` book titles) — 40 books × 10 pages ×
  20 macros with 6 command lines each.
- Fully decoded file format: MD5-verified 24-byte header recomputed on
  every write, `.gsui-bak` backup per save, lossless auto-translate
  (`[AT:xxxxxxxx]`) and raw-byte (`\xNN`) round-tripping.
- Editor UI: book/page pickers, Ctrl/Alt 2×10 macro grid, label + line
  editor with byte counters, palette copy/paste, book rename.
- **Live apply**: `PUT /api/macros/palette?apply=1` forces the client to
  re-read a book while logged in — switches to another book, writes while
  the target book is unloaded, switches back and selects the page (≥1.5s
  between switches, per Windower/Lua#1892).

**Tooling**

- Vite build (`npm run build:addon`), Go build (`npm run build:overlay`),
  incremental locked-file-tolerant deploy (`scripts/deploy.mjs`), release
  packaging (`scripts/package.mjs`), GitHub release workflow.
- Fengari smoke test (`scripts/smoke-test.mjs`) driving the real addon
  over `node:net` — covers HTTP endpoints, SSE, static SPA serving, file
  CRUD, macro parse/write/apply, and addon commands.
