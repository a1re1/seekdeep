import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dir; // scripts/
const projectDir = join(root, '..');
const distDir = process.env.SEEKDEEP_OUTDIR ?? join(projectDir, 'dist');
const publicDir = join(projectDir, 'public');
const staticAssets = ['index.html', 'styles.css'];

// Validate inputs before touching dist/ so a failed build never leaves a
// half-populated output directory behind.
const missing = staticAssets.filter((file) => !existsSync(join(publicDir, file)));
if (missing.length > 0) {
  for (const file of missing) console.error(`missing public asset: public/${file}`);
  process.exit(1);
}
// sql.js (OpenCode's SQLite store) is loaded lazily from next to the bundle,
// not bundled: the wasm is ~1 MB and only OpenCode users pay for it.
const sqlJsDir = join(projectDir, 'node_modules/sql.js/dist');
const sqlJsFiles = ['sql-wasm.js', 'sql-wasm.wasm'];
for (const file of sqlJsFiles) {
  if (!existsSync(join(sqlJsDir, file))) {
    console.error(`missing ${file} — run \`bun install\``);
    process.exit(1);
  }
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(projectDir, 'src/main.ts')],
  outdir: distDir,
  minify: true,
  target: 'browser',
  sourcemap: 'external',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Copy static assets next to the bundle.
await Promise.all(
  staticAssets.map((file) => Bun.write(join(distDir, file), Bun.file(join(publicDir, file)))),
);

// Copy samples (sample loader fetches ./samples/*).
const samplesDir = join(publicDir, 'samples');
if (existsSync(samplesDir)) {
  cpSync(samplesDir, join(distDir, 'samples'), { recursive: true });
}

for (const file of sqlJsFiles) await Bun.write(join(distDir, file), Bun.file(join(sqlJsDir, file)));

// GitHub Pages: disable Jekyll processing.
await Bun.write(join(distDir, '.nojekyll'), '');

console.log(`built dist/ (${result.outputs.length} outputs)`);
