import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
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
for (const file of ['manifest.json', 'options.html', 'options.css'])
  await copyFile(file, `dist/${file}`);
console.log('Built unpacked Chrome MV3 extension: extension/dist');
