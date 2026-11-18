import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/background.ts', 'src/content.ts', 'src/options.ts'],
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
  legalComments: 'none',
});
const catalog = JSON.parse(await readFile('../src/multi_chat_agent/provider_catalog.json', 'utf8'));
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const matches = [
  ...new Set(Object.values(catalog).map(({ origin }) => new URL(origin).origin + '/*')),
];
manifest.host_permissions = matches;
manifest.content_scripts[0].matches = matches;
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
for (const file of ['options.html', 'options.css']) await copyFile(file, `dist/${file}`);
console.log('Built unpacked Chrome MV3 extension: extension/dist');
