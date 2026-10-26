// Sync the shippable addon tree (addon/xicompanion) into the live Windower
// install at ../addons/xicompanion. The live dir's data/ folder (settings, icon
// cache, journal) is never touched.
//   node scripts/deploy.mjs [target-dir]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = path.join(root, 'addon', 'xicompanion');
const dst = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, '..', 'addons', 'xicompanion');

// the overlay exe builds straight into the deployable tree (npm run
// build:overlay -> addon/xicompanion/overlay/) — nothing to stage.
// Previous staging copied overlay/wails/*.exe (including stale plain
// `go build` outputs) OVER the production binary every deploy.
mkdirSync(dst, { recursive: true });

// drop stale hashed ui bundles so only the current build is live
const assets = path.join(dst, 'ui', 'assets');
if (existsSync(assets)) {
  for (const f of readdirSync(assets)) {
    if (/^index-.*\.(js|css)$/.test(f)) rmSync(path.join(assets, f));
  }
}

// copy file-by-file, skipping unchanged content — xicompanion-overlay.exe stays
// locked while running and must not be rewritten anyway
const skip = new Set([path.join(src, 'data')]);
let copied = 0;
let locked = 0;
let swapped = 0;
function sync(s, d) {
  if (skip.has(s)) return;
  if (statSync(s).isDirectory()) {
    mkdirSync(d, { recursive: true });
    for (const f of readdirSync(s)) {
      // leftovers from a previous rename-swap — deletable once the old
      // process exits; ignore failures while it's still running
      if (f.endsWith('.old.exe')) {
        try { rmSync(path.join(d, f)); } catch { /* still locked */ }
        continue;
      }
      sync(path.join(s, f), path.join(d, f));
    }
    return;
  }
  if (existsSync(d)) {
    try {
      const a = readFileSync(s);
      const b = readFileSync(d);
      if (a.equals(b)) return;
    } catch { /* unreadable dest — try the copy anyway */ }
  }
  try {
    copyFileSync(s, d);
    copied++;
  } catch (e) {
    // locked exe: Windows can't overwrite a running binary but CAN
    // rename it — swap under the running process so the next launch
    // picks the new build up
    if (!d.endsWith('.exe')) {
      locked++;
      console.warn(`skipped locked ${path.relative(src, s)}`);
      return;
    }
    try {
      const stale = `${d.slice(0, -4)}.old.exe`;
      try { rmSync(stale); } catch { /* previous swap still locked */ }
      renameSync(d, stale);
      copyFileSync(s, d);
      swapped++;
      console.warn(`rename-swapped locked ${path.relative(src, s)}`);
    } catch {
      locked++;
      console.warn(`skipped locked ${path.relative(src, s)}`);
    }
  }
}
sync(src, dst);

console.log(`deployed addon/xicompanion -> ${dst} (${copied} updated${swapped ? `, ${swapped} swapped` : ''}${locked ? `, ${locked} locked` : ''})`);
