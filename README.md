# XI Companion

A persistent companion overlay for Final Fantasy XI — a separate desktop
process that floats always-on-top panels over the game, backed by the
`xic` Windower addon's local HTTP/SSE server. Everything the addon sees
(packets, bags, journal, chat, recasts, map data) streams to the UI;
everything the UI does goes back through injected packets or normal
`input /` commands — no in-game UI hacks, no input blocking.

![XI Companion overlaying FFXI — minimap, tracker, macro bar, cooldowns, chat, and fab](image.png)

## Features

- **Floating panels** — every view can pop out into its own detached
  window (quest tracker, macro bar, cooldowns, minimap, plus all app
  pages). Per-window themes (`dark` / `light` / `glass` / `bare`) and
  persisted geometry; `bare` paints only the controls over the game.
- **Minimap & map page** — real zone imagery decoded from the client
  DATs, player position/facing via `get_map_data()`, nearby entities,
  and widescan results (request scans from the UI). Click a player in
  the entity list to `/tell` or `/check` them.
- **Journal** — missions, quests, Records of Eminence, and Field
  Manual/Grounds of Valor training regimes, with per-entry and
  per-category tracking toggles that feed the detached tracker window.
  Wiki links on every entry.
- **GearSwap** — set editor with an equipment grid, per-file bindings,
  slot-filtered item picker, and item tooltips that open outside the
  main window.
- **Inventory** — every bag with icons, filters, and item actions:
  equip/unequip, use, move between bags, drop. Names color-coded by the
  native flag scheme (yellow Rare, green Ex).
- **Macro bar & editor** — reads/writes the client's `mcr` files
  directly, live-applies palette changes in game, and mirrors your
  palettes onto a clickable bar.
- **Cooldowns** — ability/spell recast timers in a detached strip.
- **Chat** — Discord-style unified chat: channels plus `/tell` threads
  as DMs, autotranslate-aware phrase completion.

A [preact-mvc](https://github.com/jwhenry3/preact-mvc) application —
Angular-style modules, DI, and MVC on class-based JSX views rendered by
Preact, with signal reactivity.

## Usage

```text
//lua load xic         # start the addon (spawns the fab menu bar)
//xic open             # open the full UI window
//xic minimap          # toggle the minimap window
//xic tracker          # toggle the tracker window
//xic macrobar         # toggle the macro bar
//xic cooldowns        # toggle the cooldowns window
//xic fab on|off       # toggle the fab
```

## Development

```bash
pmvc serve            # dev server (vite)
pmvc build            # production build
pmvc test             # vitest
pmvc g view my-page   # scaffold a view
pmvc g module admin   # scaffold a feature module

npm run build:addon   # typecheck + build into addon/xic/ui/
npm run build:overlay # go build the Wails shell
npm run deploy        # sync addon -> live Windower install
node scripts/smoke-test.mjs   # addon exercised under fengari
```

See `AGENTS.md` for the architecture notes.
