// Zip the shippable addon tree for distribution — extracting into a
// Windower addons/ dir gives a ready-to-load xic addon.
//   node scripts/package.mjs
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = path.join(root, 'addon', 'xic');
// GSUI_VERSION lets CI name the zip after the git tag instead of the
// package.json version (which may lag behind tags).
const version =
  process.env.GSUI_VERSION ||
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const zip = path.join(root, 'dist', `xicompanion-${version}.zip`);

for (const [what, p] of [
  ['ui bundle', path.join(src, 'ui', 'index.html')],
  ['overlay shell', path.join(src, 'overlay', 'xic-overlay.exe')],
]) {
  if (!existsSync(p)) {
    console.error(`${what} missing at ${p}`);
    console.error('run npm run build:addon and npm run build:overlay first');
    process.exit(1);
  }
}

mkdirSync(path.dirname(zip), { recursive: true });
rmSync(zip, { force: true });
execFileSync(
  'powershell',
  ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${src}' -DestinationPath '${zip}'`],
  { stdio: 'inherit' },
);
console.log(`packaged ${zip}`);
