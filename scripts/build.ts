// Builds the installable package into dist/: browser IIFE bundles for both
// frames (the sandboxed iframe cannot load ESM) and an ESM bundle for the service.
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'dist');

const bundle = async (entry: string, outfile: string, target: 'browser' | 'node') => {
  const result = await Bun.build({
    entrypoints: [resolve(root, entry)],
    format: target === 'node' ? 'esm' : 'iife',
    target,
    minify: target === 'browser',
  });
  const output = result.outputs[0];
  if (!result.success || !output) {
    throw new Error(result.logs.map((log) => log.message).join('\n') || `Build failed: ${entry}`);
  }
  const file = resolve(dist, outfile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, await output.text());
};

await rm(dist, { recursive: true, force: true });
await bundle('src/panel/main.ts', 'panel/main.js', 'browser');
await bundle('src/status/main.ts', 'status/main.js', 'browser');
await bundle('src/service/main.ts', 'service/main.js', 'node');
await copyFile(resolve(root, 'src/panel/index.html'), resolve(dist, 'panel/index.html'));
await copyFile(resolve(root, 'src/status/index.html'), resolve(dist, 'status/index.html'));
console.log('Built dist/');
