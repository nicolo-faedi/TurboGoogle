import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, 'newtab.js')],
  outfile: path.join(dist, 'newtab.js'),
  bundle: true,
  minify: true,
  target: ['chrome110'],
  format: 'iife',
  legalComments: 'none',
  charset: 'utf8',
});

await build({
  entryPoints: [path.join(root, 'newtab.css')],
  outfile: path.join(dist, 'newtab.css'),
  minify: true,
  target: ['chrome110'],
  legalComments: 'none',
  charset: 'utf8',
});

const files = ['manifest.json', 'newtab.html', 'background.js'];
await Promise.all(files.map((file) => cp(path.join(root, file), path.join(dist, file))));
await cp(path.join(root, '_locales'), path.join(dist, '_locales'), { recursive: true });
await mkdir(path.join(dist, 'assets/icons'), { recursive: true });
await Promise.all(['icon.svg', 'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png'].map((file) => cp(path.join(root, 'assets/icons', file), path.join(dist, 'assets/icons', file))));
await mkdir(path.join(dist, 'assets/fonts'), { recursive: true });
await cp(path.join(root, 'assets/fonts/Sorean-Bold.woff2'), path.join(dist, 'assets/fonts/Sorean-Bold.woff2'));

console.log(`Built TurboGoogle in ${dist}`);
